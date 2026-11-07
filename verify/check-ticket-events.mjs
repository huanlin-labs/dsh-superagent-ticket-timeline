/**
 * 「Ticket 事件流解析」小类验收脚本
 * 三条验收标准逐条断言，任何一条不满足即非零退出。
 *
 * 用法：node verify/check-ticket-events.mjs
 */
import { parseTicketStream, TicketParseError, EVENT_TYPES, REPORT_STATES } from '../src/ticket-events.mjs';
import { SAMPLES } from './lib/sample-tickets.mjs';

let failures = 0;
const log = (line) => console.log(line);
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  →  ${detail}` : ''}`);
};

log('════ 验收 1：三份样例全部解析成功，事件数与声明一致 ════');
const parsed = [];
for (const { name, doc } of SAMPLES) {
  try {
    const result = parseTicketStream(doc, { source: name });
    parsed.push({ name, result });
    log(`  ${name}: 声明 ${result.declaredEventCount} 条 / 解析 ${result.events.length} 条 / 类型 ${Object.keys(result.meta.types).length} 种 / 时长 ${(result.meta.durationMs / 60000).toFixed(1)} 分钟`);
    check(`  ${name} 事件数 = 声明值`, result.events.length === result.declaredEventCount,
      `${result.events.length} vs ${result.declaredEventCount}`);
  } catch (error) {
    failures += 1;
    log(`  FAIL  ${name} 解析抛错：${error.name}: ${error.message}`);
  }
}
check('三份样例都解析成功', parsed.length === 3, `${parsed.length}/3`);
check('每份都能读到 ticket 标题', parsed.every(({ result }) => typeof result.ticket.title === 'string' && result.ticket.title.length > 0),
  parsed.map(({ result }) => result.ticket.title).join(' | '));
check('同 JSON 字符串输入与对象输入等价',
  JSON.stringify(parseTicketStream(JSON.stringify(SAMPLES[0].doc)).events)
  === JSON.stringify(parseTicketStream(SAMPLES[0].doc).events));
check('事件 atMs 单调不减', parsed.every(({ result }) => result.events.every((event, i) => i === 0 || result.events[i - 1].atMs <= event.atMs)));
check('规格覆盖 003 报告六态', REPORT_STATES.every((state) => EVENT_TYPES.includes(`report.${state}`)), EVENT_TYPES.length + ' 种事件');

log('');
log('════ 验收 2：缺字段/错类型给出「第 N 条事件缺 X」可读错误 ════');
{
  const clone = () => JSON.parse(JSON.stringify(SAMPLES[0].doc));

  const missingAt = clone();
  delete missingAt.events[2].at; // 第 3 条
  let err1;
  try { parseTicketStream(missingAt); } catch (error) { err1 = error; }
  log(`    缺 at → ${err1?.message}`);
  check('缺 at：报第 3 条 + 字段名', err1 instanceof TicketParseError && err1.code === 'MISSING_FIELD'
    && err1.ordinal === 3 && err1.field === 'at', `${err1?.code} / ordinal=${err1?.ordinal} / field=${err1?.field}`);

  const wrongType = clone();
  wrongType.events[2].human = 'yes'; // 第 3 条 input.trigger
  let err2;
  try { parseTicketStream(wrongType); } catch (error) { err2 = error; }
  log(`    human 错类型 → ${err2?.message}`);
  check('human 写字符串：报第 3 条 + 期望布尔', err2 instanceof TicketParseError && err2.code === 'BAD_FIELD_TYPE'
    && err2.ordinal === 3 && err2.field === 'human', `${err2?.code} / ${err2?.message}`);

  const unknown = clone();
  unknown.events[4].type = 'report.whatever';
  let err3;
  try { parseTicketStream(unknown); } catch (error) { err3 = error; }
  log(`    未知类型 → ${err3?.message}`);
  check('未知 type：报第 5 条并列出允许值', err3 instanceof TicketParseError && err3.code === 'UNKNOWN_TYPE'
    && err3.ordinal === 5 && /report\.ready/.test(err3.message), `${err3?.code}`);

  const badEnum = clone();
  badEnum.events[10].outcome = 'finished'; // 第 11 条 ticket.ended
  let err4;
  try { parseTicketStream(badEnum); } catch (error) { err4 = error; }
  log(`    枚举越界 → ${err4?.message}`);
  check('outcome 越界：报第 11 条 + 允许值', err4 instanceof TicketParseError && err4.code === 'BAD_FIELD_VALUE'
    && err4.ordinal === 11 && /completed/.test(err4.message), `${err4?.code}`);

  const badCount = clone();
  badCount.declaredEventCount = badCount.declaredEventCount + 1;
  let err5;
  try { parseTicketStream(badCount); } catch (error) { err5 = error; }
  log(`    条数对不上 → ${err5?.message}`);
  check('声明条数与实际不符：抛 COUNT_MISMATCH 且两边数字都在话里',
    err5 instanceof TicketParseError && err5.code === 'COUNT_MISMATCH' && /声明 12 条，实际解析出 11 条/.test(err5.message),
    `${err5?.code}`);

  const noDeclared = clone();
  delete noDeclared.declaredEventCount;
  let err6;
  try { parseTicketStream(noDeclared); } catch (error) { err6 = error; }
  check('缺 declaredEventCount：单独报出来', err6?.field === 'declaredEventCount' && err6?.code === 'MISSING_FIELD',
    `${err6?.code} / ${err6?.field}`);

  const empty = clone();
  empty.events = []; empty.declaredEventCount = 0;
  let err7;
  try { parseTicketStream(empty); } catch (error) { err7 = error; }
  check('空 events：报 EMPTY_STREAM（不静默返回空时间线）', err7?.code === 'EMPTY_STREAM', `${err7?.code}`);

  const notJson = '{ this is not json';
  let err8;
  try { parseTicketStream(notJson); } catch (error) { err8 = error; }
  check('非法 JSON：报 BAD_JSON 而不是裸 SyntaxError', err8?.code === 'BAD_JSON' && err8?.name === 'TicketParseError',
    `${err8?.code}`);
}

log('');
log('════ 验收 3：human 标志 / delivery 失败 保留原意 ════');
{
  const blocked = parseTicketStream(SAMPLES[1].doc, { source: 'blocked' });
  const humanEvents = blocked.events.filter((event) => event.type === 'input.trigger' && event.human === true);
  log(`    人类输入 ${humanEvents.length} 条：${humanEvents.map((event) => event.triggerId).join(', ')}`);
  check('human=true 的 trigger 读得到且为布尔 true', humanEvents.length === 2 && humanEvents.every((event) => event.human === true),
    humanEvents.map((event) => `${event.triggerId}=${event.human}`).join(' '));

  const noteEvent = blocked.events.find((event) => event.type === 'input.note');
  check('note 事件不凭空获得 human 字段', noteEvent !== undefined && !('human' in noteEvent));

  const failed = blocked.events.find((event) => event.type === 'delivery.failed');
  log(`    delivery 失败对象 = ${JSON.stringify(failed?.delivery)}`);
  check('delivery 失败：error 原文、ok=false、时刻都保留',
    failed?.delivery?.ok === false && /连接被拒/.test(failed?.delivery?.error) && typeof failed?.delivery?.at === 'string',
    JSON.stringify(failed?.delivery));

  const delivered = blocked.events.find((event) => event.type === 'delivery.delivered');
  check('delivery 成功：ok=true 且不携带 error', delivered?.delivery?.ok === true && delivered?.delivery?.error === undefined);

  const raw = SAMPLES[1].doc.events.find((event) => event.type === 'input.trigger');
  check('原字段未被改写（triggerId 原文可回溯）', humanEvents[0].triggerId === raw.triggerId,
    `${humanEvents[0].triggerId} vs ${raw.triggerId}`);
}

log('');
log('════ 相邻锚（陌生视角挑刺） ════');
{
  // 乱序输入必须按时间排好，且不丢条数
  const shuffled = JSON.parse(JSON.stringify(SAMPLES[0].doc));
  shuffled.events = [...shuffled.events].reverse();
  const result = parseTicketStream(shuffled);
  check('乱序输入按时间重排且条数不变', result.events.length === shuffled.declaredEventCount
    && result.events.every((event, i) => i === 0 || result.events[i - 1].atMs <= event.atMs));

  // 事件对象上的 index 指向原始数组位置，可用于回溯
  const firstEvent = result.events[0];
  check('event.index 能回指原始数组位置', typeof firstEvent.index === 'number'
    && shuffled.events[firstEvent.index].type === firstEvent.type, `index=${firstEvent.index} type=${firstEvent.type}`);

  // 未知字段不报错（真实日志会带 meta）
  const withExtra = JSON.parse(JSON.stringify(SAMPLES[0].doc));
  withExtra.events[0].meta = { raw: 'whatever' };
  check('多余字段容错、不打扰解析', parseTicketStream(withExtra).events.length === withExtra.declaredEventCount);
}

log('');
log(failures === 0 ? '结论：3 条验收标准全部通过 ✅' : `结论：${failures} 条断言未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);

/**
 * 「阶段表序推导」小类验收脚本
 * 三条验收标准逐条断言，任何一条不满足即非零退出。
 */
import { parseTicketStream } from '../src/ticket-events.mjs';
import { STAGE_IDS, STAGE_RULES, stageAt, stageSequence, stageDurations } from '../src/ticket-stage.mjs';
import { SAMPLES } from './lib/sample-tickets.mjs';

let failures = 0;
const log = (line) => console.log(line);
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  →  ${detail}` : ''}`);
};

const T0 = '2026-09-01T09:00:00.000Z';
const tick = (n) => new Date(Date.parse(T0) + n * 1000).toISOString();

/** 用事件数组直接构造一份「解析后」的结构，省掉样例噪音。 */
const build = (events) => parseTicketStream({
  declaredEventCount: events.length,
  ticket: { id: 'tk-case', title: '用例' },
  events: events.map((event, i) => ({ at: tick(i + 1), ...event })),
});

const created = { type: 'ticket.created', ticketId: 'tk-case', title: '用例', decisionId: 'd', strength: 'explicit' };
const started = (id = 'as-0') => ({ type: 'assignment.started', assignmentId: id, state: 'running' });
const reported = (state, summary = '报告') => ({ type: 'report.' + state, assignmentId: 'as-0', summary });
const humanMsg = (id = 'tr-x') => ({ type: 'input.trigger', triggerId: id, human: true });

const stageAfter = (events) => {
  const parsed = build(events);
  return stageAt(parsed, parsed.events.at(-1).at);
};

log('════ 验收 1：八个 stage 各有正例（期望值抄 003 表格行） ════');
const positives = [
  ['person/delivery', 'Delivering an Input to the Executor Session failed', [created, started(), { type: 'delivery.failed', error: 'Session 不可达' }]],
  ['person/answer', 'It has an Attention', [created, started(), { type: 'attention.raised', question: '要不要同时打进 legacy？' }]],
  ['person/review', 'The latest Report is `ready`', [created, started(), reported('ready')]],
  ['person/blocked', 'The latest Report is `blocked` … no person’s message reached the Ticket since', [created, started(), reported('blocked')]],
  ['person/failed', 'The latest Report is `failed` … no person’s message reached the Ticket since', [created, started(), reported('failed')]],
  ['working/queued', 'No Assignment, or a pending one', [created]],
  ['idle', 'The latest Report is `waiting`, or the Assignment ended', [created, started(), reported('waiting')]],
  ['working', 'Everything else', [created, started(), reported('progress')]],
];

const seen = new Set();
for (const [expected, source, events] of positives) {
  const actual = stageAfter(events);
  seen.add(actual.id);
  log(`    ${expected.padEnd(16)} ← ${actual.id.padEnd(16)} | ${source}`);
  check(`  ${expected} 命中且引用对得上`, actual.id === expected && actual.source.includes(source.slice(0, 20)),
    `实际 ${actual.id}`);
}
check('八个 stage 全部有正例且互不重复', seen.size === 8 && STAGE_IDS.every((id) => seen.has(id)), `${seen.size}/8`);
check('规则表顺序与 003 表一致（8 条、id 逐个对齐）',
  STAGE_RULES.length === 8 && STAGE_RULES.map((rule) => rule.id).join(',') === STAGE_IDS.join(','),
  STAGE_RULES.map((rule) => rule.id).join(' > '));

// idle 的另一半：latest Report waiting 之外，「Assignment ended」也算 idle
{
  const parsed = build([created, started(), reported('progress'), { type: 'assignment.ended', assignmentId: 'as-0', reason: 'ready' }]);
  const actual = stageAt(parsed, parsed.events.at(-1).at);
  check('idle 的第二种成因（Assignment ended）也命中', actual.id === 'idle', actual.id);
}

log('');
log('════ 验收 2：三条优先级反例 ════');
{
  // (a) blocked 之后到达人类消息 → working（不是继续 blocked）
  const parsed = build([created, started(), reported('blocked', '等 Redis 凭据'), humanMsg('tr-2')]);
  const before = stageAt(parsed, parsed.events[2].at);
  const after = stageAt(parsed, parsed.events[3].at);
  log(`    (a) blocked=${before.id} → 收到人类消息后=${after.id}`);
  check('(a) 消息到达前是 person/blocked', before.id === 'person/blocked', before.id);
  check('(a) 消息到达后转为 working', after.id === 'working', after.id);
  check('(a) 状态里记着"报告后有人来过"', after.state.humanSinceReport === true);

  // (b) delivery 失败 + 有 attention → person/delivery（delivery 压过 answer）
  const parsedB = build([created, started(), { type: 'delivery.failed', error: 'Session 不可达' }, { type: 'attention.raised', question: '要不要打进 legacy？' }]);
  const actualB = stageAt(parsedB, parsedB.events.at(-1).at);
  log(`    (b) delivery 失败 + attention → ${actualB.id}`);
  check('(b) person/delivery 压过 person/answer', actualB.id === 'person/delivery', actualB.id);

  // (c) report=ready 且有未读人类消息 → person/review
  const parsedC = build([created, started(), reported('ready', '改动 42 行'), humanMsg('tr-3')]);
  const actualC = stageAt(parsedC, parsedC.events.at(-1).at);
  log(`    (c) ready + 未读人类消息 → ${actualC.id}`);
  check('(c) 仍是 person/review（review 行在 blocked/failed 之上）', actualC.id === 'person/review', actualC.id);

  // 附加：answer 压过 review（happy 样例里真实出现过）
  const parsedD = build([created, started(), reported('ready'), { type: 'attention.raised', question: '要打进 legacy 吗？' }]);
  const actualD = stageAt(parsedD, parsedD.events.at(-1).at);
  check('(d) 附加：attention 压过 ready → person/answer', actualD.id === 'person/answer', actualD.id);
}

log('');
log('════ 验收 3：stage 序列时间单调不减、首条从 ticket.created 开始 ════');
for (const { name, doc } of SAMPLES) {
  const parsed = parseTicketStream(doc);
  const sequence = stageSequence(parsed);
  const monotonic = sequence.every((entry, i) => i === 0 || sequence[i - 1].atMs <= entry.atMs);
  const firstIsCreate = sequence[0].at === parsed.events[0].at && sequence[0].cause === 'ticket.created';
  log(`    ${name}: ${sequence.length} 段 → ${sequence.map((entry) => entry.stage).join(' → ')}`);
  check(`  ${name} 时间单调不减`, monotonic);
  check(`  ${name} 首条 = ticket.created 时刻且成因是它`, firstIsCreate,
    `${sequence[0].at} / cause=${sequence[0].cause}`);
  check(`  ${name} 段数 ≤ 事件数`, sequence.length <= parsed.events.length, `${sequence.length} ≤ ${parsed.events.length}`);
}

// 真实样例里也必须出现「blocked → 人类消息 → working」这一跳（不是只在合成用例里成立）
{
  const parsed = parseTicketStream(SAMPLES[1].doc);
  const sequence = stageSequence(parsed);
  const blockedIndex = sequence.findIndex((entry) => entry.stage === 'person/blocked');
  const afterBlocked = sequence[blockedIndex + 1];
  log(`    blocked 样例序列：${sequence.map((entry) => entry.stage).join(' → ')}`);
  check('blocked 样例里 blocked 之后紧跟 working', blockedIndex >= 0 && afterBlocked?.stage === 'working',
    afterBlocked?.stage ?? '(无后续)');
  check('该跳的成因是 input.trigger', afterBlocked?.cause === 'input.trigger', afterBlocked?.cause);
  check('blocked 样例里也出现 person/delivery（delivery 先于 review）',
    sequence.some((entry) => entry.stage === 'person/delivery'));
}

log('');
log('════ 相邻锚（陌生视角挑刺） ════');
{
  // stageAt 在时间点之前 → 就是结算点（第一条事件）之前的状态，不应抛错
  const parsed = parseTicketStream(SAMPLES[0].doc);
  const before = stageAt(parsed, Date.parse(parsed.events[0].at) - 1);
  check('早于首条事件的时间点：返回 working/queued（尚无 assignment）', before.id === 'working/queued', before.id);

  // 非法时间输入要明确报错，不静默返回
  let threw = false;
  try { stageAt(parsed, 'not-a-time'); } catch (error) { threw = error instanceof TypeError; }
  check('非法时间参数抛 TypeError', threw);

  // 同一个时间点反复取，结果稳定
  const a = stageAt(parsed, parsed.events[5].at).id;
  const b = stageAt(parsed, parsed.events[5].at).id;
  check('同一时间点取值稳定', a === b, `${a} / ${b}`);

  // 交接到人时立即释放（003：ready/blocked/failed 之后 handoff）
  const handoff = build([created, started(), reported('ready'), { type: 'assignment.ended', assignmentId: 'as-0', reason: 'ready' }]);
  check('assignment 结束后仍是 person/review（review 行在 idle 之上）',
    stageAt(handoff, handoff.events.at(-1).at).id === 'person/review');

  // 时长统计：各段之和 = 总时长
  const durations = stageSequence(parsed).map((entry, i, arr) => (arr[i + 1]?.atMs ?? parsed.events.at(-1).atMs) - entry.atMs);
  const total = durations.reduce((sum, ms) => sum + ms, 0);
  check('各段时长之和 = 总时长', total === parsed.events.at(-1).atMs - parsed.events[0].atMs,
    `${total} vs ${parsed.events.at(-1).atMs - parsed.events[0].atMs}`);
  const durations2 = stageDurations(parsed);
  check('stageDurations 段数与 sequence 一致且每段 ms ≥ 0',
    durations2.length === stageSequence(parsed).length && durations2.every((entry) => entry.ms >= 0),
    `${durations2.length} 段 / 最小 ms=${Math.min(...durations2.map((entry) => entry.ms))}`);
}

log('');
log(failures === 0 ? '结论：3 条验收标准全部通过 ✅' : `结论：${failures} 条断言未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);

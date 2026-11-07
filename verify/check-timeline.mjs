/**
 * 「统一时间线条目」小类验收脚本
 * 三条验收标准逐条断言，任何一条不满足即非零退出。
 */
import { parseTicketStream } from '../src/ticket-events.mjs';
import {
  projectTicket, projectSession, mergeTimelines, resolveRef, isMonotonic, SOURCE_RANK,
} from '../src/timeline.mjs';
import { SAMPLES } from './lib/sample-tickets.mjs';

let failures = 0;
const log = (line) => console.log(line);
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  →  ${detail}` : ''}`);
};

/** 一份形如 DSH session.v4 的会话事件（time 是毫秒）。 */
const SESSION_EVENTS = [
  { type: 'session', seq: 0, time: Date.parse('2026-09-02T10:00:01.000Z'), data: { version: 4, id: 'ch-demo' } },
  { type: 'turn/start', seq: 1, time: Date.parse('2026-09-02T10:00:01.500Z'), data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: Date.parse('2026-09-02T10:00:02.000Z'), data: { text: '给导出接口补个限流，100 rps' } },
  { type: 'tool/call', seq: 3, time: Date.parse('2026-09-02T10:02:00.000Z'), data: { name: 'shell', arguments: { command: 'rg -n "export" src' } } },
  { type: 'tool/result', seq: 4, time: Date.parse('2026-09-02T10:02:05.000Z'), data: { name: 'shell', text: 'src/export.ts:42' } },
  { type: 'assistant/message', seq: 5, time: Date.parse('2026-09-02T10:09:00.000Z'), data: { text: '缺 Redis 凭据，限流计数写不进去' } },
  { type: 'turn/end', seq: 6, time: Date.parse('2026-09-02T10:09:01.000Z'), data: { turn: 1 } },
  { type: 'todo/write', seq: 7, time: Date.parse('2026-09-02T10:09:02.000Z'), data: { todos: [{ content: '接 Redis' }, { content: '压测' }] } },
];

log('════ 验收 1：两类源各自可投影、混排后时间单调不减 ════');
const ticketParsed = parseTicketStream(SAMPLES[1].doc, { source: 'blocked' });
const ticketEntries = projectTicket(ticketParsed);
const sessionEntries = projectSession(SESSION_EVENTS, { sessionId: 'ch-demo' });

log(`    Ticket 源：${ticketEntries.length} 条（事件 ${ticketParsed.events.length} 条）`);
log(`    会话源：${sessionEntries.length} 条（原始 ${SESSION_EVENTS.length} 条）`);
for (const entry of sessionEntries.slice(0, 4)) log(`      ${entry.at.slice(11, 19)} [${entry.subject}] ${entry.summary}`);

check('Ticket 源：条目数 = 事件数', ticketEntries.length === ticketParsed.events.length,
  `${ticketEntries.length} vs ${ticketParsed.events.length}`);
check('Ticket 源：单独投影时间单调不减', isMonotonic(ticketEntries));
check('会话源：条目数 = 可投影事件数', sessionEntries.length === SESSION_EVENTS.length,
  `${sessionEntries.length} vs ${SESSION_EVENTS.length}`);
check('会话源：单独投影时间单调不减', isMonotonic(sessionEntries));
check('条目字段齐备（at/atMs/source/kind/subject/summary/rawRef/id）',
  [...ticketEntries, ...sessionEntries].every((entry) =>
    entry.at && Number.isFinite(entry.atMs) && entry.source && entry.kind
    && entry.subject && entry.summary && entry.rawRef && entry.id));
check('summary 是人话不是类型名（不含裸类型串）',
  ticketEntries.every((entry) => entry.summary !== entry.kind)
  && sessionEntries.every((entry) => entry.summary !== entry.kind));

const merged = mergeTimelines(ticketEntries, sessionEntries);
log(`    混排：${merged.length} 条（应为 ${ticketEntries.length + sessionEntries.length}）`);
for (const entry of merged.slice(0, 6)) log(`      ${entry.at.slice(11, 19)} ${entry.source.padEnd(7)} ${entry.summary}`);
check('混排后条数 = 两源之和', merged.length === ticketEntries.length + sessionEntries.length);
check('混排后时间单调不减', isMonotonic(merged));
check('混排确实交错（不是简单拼接）',
  merged.some((entry, i) => i > 0 && entry.source !== merged[i - 1].source),
  merged.map((entry) => entry.source[0]).join(''));

log('');
log('════ 验收 2：同刻事件顺序确定（打乱输入 5 次结果一致） ════');
{
  // 造一批「同一毫秒」的混合事件：ticket 与 session 各若干，全部 time 相同
  const sameMs = Date.parse('2026-09-05T12:00:00.000Z');
  const mk = (i) => ({ type: 'input.note', text: `注记 ${i}`, at: new Date(sameMs).toISOString() });
  const tieTicket = parseTicketStream({
    declaredEventCount: 4,
    ticket: { id: 'tk-tie', title: '同刻测试' },
    events: [mk(1), mk(2), mk(3), mk(4)],
  });
  const tieSessionEvents = [1, 2, 3, 4, 5, 6].map((seq) => ({
    type: 'assistant/message', seq, time: sameMs, data: { text: `同刻会话 ${seq}` },
  }));

  const signature = () => {
    const t = projectTicket(tieTicket);
    const s = projectSession(tieSessionEvents);
    // 故意每次以不同顺序传入
    const a = mergeTimelines(t, s);
    const b = mergeTimelines(s, t);
    return { a: a.map((entry) => entry.id).join('|'), b: b.map((entry) => entry.id).join('|') };
  };

  const runs = [];
  for (let i = 0; i < 5; i += 1) runs.push(signature());
  const allSame = runs.every((run) => run.a === runs[0].a && run.b === runs[0].a);
  log(`    同刻条目 ${tieTicket.events.length + tieSessionEvents.length} 条，序列指纹 = ${runs[0].a.slice(0, 60)}…`);
  check('5 次运行序列完全一致', allSame);
  check('两种传入顺序结果一致（不依赖参数顺序）', runs[0].a === runs[0].b);

  // 同刻时 ticket 先于 session（SOURCE_RANK 契约）
  const order = mergeTimelines(projectSession(tieSessionEvents), projectTicket(tieTicket)).map((entry) => entry.source);
  const firstSessionIdx = order.indexOf('session');
  const lastTicketIdx = order.lastIndexOf('ticket');
  log(`    同刻排序：${order.join(',')}（rank: ticket=${SOURCE_RANK.ticket}, session=${SOURCE_RANK.session}）`);
  check('同刻时 ticket 段整体在 session 段之前', lastTicketIdx < firstSessionIdx);
  check('同刻同来源内按原始序号升序',
    mergeTimelines(projectSession(tieSessionEvents)).map((entry) => entry.rawRef.seq).join(',') === '1,2,3,4,5,6');
}

log('');
log('════ 验收 3：rawRef 能回原始事件 ════');
{
  const collections = { ticket: ticketParsed, session: SESSION_EVENTS };
  let ok = 0;
  for (const entry of merged) {
    const original = resolveRef(entry.rawRef, collections);
    if (original.type === entry.kind) ok += 1;
  }
  check('每个条目都能按 rawRef 取回同类型原始事件', ok === merged.length, `${ok}/${merged.length}`);

  // 逐类型抽查：ticket 侧按下标回指，session 侧按 seq 回指
  const ticketEntry = ticketEntries[5];
  const ticketBack = resolveRef(ticketEntry.rawRef, collections);
  check('ticket rawRef.index 指向原数组同一位置',
    ticketBack === ticketParsed.events[ticketEntry.rawRef.index] && ticketBack.type === ticketEntry.kind,
    `index=${ticketEntry.rawRef.index} type=${ticketBack.type}`);

  const sessionEntry = sessionEntries[3];
  const sessionBack = resolveRef(sessionEntry.rawRef, collections);
  check('session rawRef.seq 取回同 seq 原始事件',
    sessionBack.seq === sessionEntry.rawRef.seq && sessionBack.type === sessionEntry.kind,
    `seq=${sessionBack.seq} type=${sessionBack.type}`);

  // 越界/不存在要明确报错
  let threwRange = false;
  try { resolveRef({ source: 'ticket', index: 999 }, collections); } catch (error) { threwRange = error instanceof RangeError; }
  check('ticket 下标越界抛 RangeError', threwRange);

  let threwSeq = false;
  try { resolveRef({ source: 'session', seq: 999 }, collections); } catch (error) { threwSeq = error instanceof RangeError; }
  check('找不到 seq 抛 RangeError', threwSeq);

  let threwSource = false;
  try { resolveRef({ source: 'ghost' }, collections); } catch (error) { threwSource = error instanceof TypeError; }
  check('未知来源抛 TypeError', threwSource);
}

log('');
log('════ 相邻锚（陌生视角挑刺） ════');
{
  // 会话事件缺 time / 缺 type 的要被过滤，而不是造出 NaN 时间
  const dirty = [
    ...SESSION_EVENTS.slice(0, 2),
    { type: 'user/message', seq: 99, data: { text: '没有 time' } },
    { seq: 98, time: Date.parse('2026-09-02T10:05:00.000Z'), data: {} },
  ];
  const filtered = projectSession(dirty);
  check('缺 time / 缺 type 的会话事件被过滤掉', filtered.length === 2, `${filtered.length}/4`);
  check('过滤后时间仍然有效（无 NaN）', filtered.every((entry) => Number.isFinite(entry.atMs)));

  // 空格子：空数组混排不炸
  check('空输入混排得到空数组', mergeTimelines([], []).length === 0);

  // mergeTimelines 不改入参
  const before = ticketEntries.map((entry) => entry.id).join('|');
  mergeTimelines(sessionEntries, ticketEntries);
  check('mergeTimelines 不改动入参数组', ticketEntries.map((entry) => entry.id).join('|') === before);

  // 会话事件 time 是毫秒 → at 是 ISO，两者对得上
  const one = sessionEntries[2];
  check('会话 time(ms) 与 at(ISO) 同源一致', Date.parse(one.at) === one.atMs, `${one.atMs}`);
}

log('');
log(failures === 0 ? '结论：3 条验收标准全部通过 ✅' : `结论：${failures} 条断言未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);

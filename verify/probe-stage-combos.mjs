/**
 * 组级验收补测：优先级组合矩阵（组收官用，独立于小类验收脚本）。
 * 只回答一个问题：003 表序里「谁压过谁」是否在实现里也成立。
 */
import { parseTicketStream } from '../src/ticket-events.mjs';
import { stageAt } from '../src/ticket-stage.mjs';

const T0 = '2026-09-01T09:00:00.000Z';
const tick = (n) => new Date(Date.parse(T0) + n * 1000).toISOString();
const build = (events) => parseTicketStream({
  declaredEventCount: events.length,
  ticket: { id: 'x', title: 'x' },
  events: events.map((event, i) => ({ at: tick(i + 1), ...event })),
});

const created = { type: 'ticket.created', ticketId: 'x', title: 'x', decisionId: 'd', strength: 'explicit' };
const started = { type: 'assignment.started', assignmentId: 'as-0', state: 'running' };
const ready = { type: 'report.ready', assignmentId: 'as-0', summary: 'ok' };
const blocked = { type: 'report.blocked', assignmentId: 'as-0', summary: '等凭据' };
const failed = { type: 'report.failed', assignmentId: 'as-0', summary: '炸了' };
const attention = { type: 'attention.raised', question: '要不要打进 legacy？' };
const deliveryFailed = { type: 'delivery.failed', error: 'Session 不可达' };
const human = { type: 'input.trigger', triggerId: 'tr-h', human: true };

/** [说明, 事件序列, 期望 stage] */
const CASES = [
  ['delivery 压过 review（ready 在前、delivery 失败在后）', [created, started, ready, deliveryFailed], 'person/delivery'],
  ['delivery 压过 answer（attention 在前）', [created, started, attention, deliveryFailed], 'person/delivery'],
  ['delivery 压过 blocked', [created, started, blocked, deliveryFailed], 'person/delivery'],
  ['answer 压过 review', [created, started, ready, attention], 'person/answer'],
  ['review 压过 blocked 位次（ready 单独存在）', [created, started, ready], 'person/review'],
  ['blocked 被人类消息解除 → working', [created, started, blocked, human], 'working'],
  ['failed 被人类消息解除 → working', [created, started, failed, human], 'working'],
  ['blocked 未被解除 → person/blocked', [created, started, blocked], 'person/blocked'],
  ['delivery 成功后让位给 blocked', [created, started, deliveryFailed, { type: 'delivery.delivered' }, blocked], 'person/blocked'],
  ['新 assignment 清掉 delivery 失败', [created, started, deliveryFailed, { type: 'assignment.started', assignmentId: 'as-1', state: 'running' }], 'working'],
  ['ticket 结束清掉 delivery 失败与 attention', [created, started, deliveryFailed, attention, { type: 'ticket.ended', by: 'human', outcome: 'stopped' }], 'working'],
  ['无 assignment → queued', [created], 'working/queued'],
  ['report.waiting → idle', [created, started, { type: 'report.waiting', assignmentId: 'as-0', summary: '等触发' }], 'idle'],
  ['assignment 结束 → idle', [created, started, { type: 'report.progress', assignmentId: 'as-0', summary: 'x' }, { type: 'assignment.ended', assignmentId: 'as-0', reason: 'ready' }], 'idle'],
];

let failedCases = 0;
for (const [label, events, expected] of CASES) {
  const parsed = build(events);
  const actual = stageAt(parsed, parsed.events.at(-1).at).id;
  const ok = actual === expected;
  if (!ok) failedCases += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(44)} → ${actual}${ok ? '' : `（期望 ${expected}）`}`);
}
console.log(failedCases === 0 ? `结论：${CASES.length} 条优先级组合全通过 ✅` : `结论：${failedCases} 条未通过 ❌`);
process.exit(failedCases === 0 ? 0 : 1);

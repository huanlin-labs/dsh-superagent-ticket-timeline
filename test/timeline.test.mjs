/**
 * 第五块：时间线排序稳定性
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTicketStream } from '../src/ticket-events.mjs';
import { projectTicket, projectSession, mergeTimelines, SOURCE_RANK } from '../src/timeline.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/ticket-happy.json', import.meta.url), 'utf8'));
const parsed = parseTicketStream(fixture, { source: 'fixture' });

test('projectTicket：条目数等于事件数，且逐条带 at/atMs/kind/summary', () => {
  const entries = projectTicket(parsed);
  assert.equal(entries.length, parsed.events.length);
  for (const entry of entries) {
    assert.ok(entry.id && entry.at && Number.isFinite(entry.atMs));
    assert.ok(entry.kind && entry.summary && entry.source === 'ticket');
  }
});

test('mergeTimelines：输出按 atMs 非降序（不乱序）', () => {
  const merged = mergeTimelines(projectTicket(parsed));
  const times = merged.map((entry) => entry.atMs);
  const sorted = [...times].sort((a, b) => a - b);
  assert.deepEqual(times, sorted);
});

test('同一时刻多源：ticket 排在 session 之前（SOURCE_RANK 决定）', () => {
  const stamp = '2026-09-08T09:12:03.140Z';
  const ticketEntry = { id: 'ticket:x', at: stamp, atMs: Date.parse(stamp), source: 'ticket', kind: 'ticket.created', subject: 'ticket', summary: '建单', rawRef: { index: 0 } };
  const sessionEntry = { id: 'session:x', at: stamp, atMs: Date.parse(stamp), source: 'session', kind: 'user.message', subject: 'person', summary: '说话', rawRef: { seq: 1 } };
  const merged = mergeTimelines([sessionEntry, ticketEntry]);
  assert.equal(merged[0].source, 'ticket', '同刻应 ticket 在前');
  assert.ok(SOURCE_RANK.ticket < SOURCE_RANK.session);
});

test('排序是确定性的：同一输入跑两次，id 序列完全相同', () => {
  const once = mergeTimelines(projectTicket(parsed)).map((entry) => entry.id);
  const twice = mergeTimelines(projectTicket(parsed)).map((entry) => entry.id);
  assert.deepEqual(once, twice);
});

test('排序不受输入顺序影响：倒着喂进去，结果仍是同一序列', () => {
  const forward = projectTicket(parsed);
  const backward = [...forward].reverse();
  assert.deepEqual(
    mergeTimelines(backward).map((entry) => entry.id),
    mergeTimelines(forward).map((entry) => entry.id),
  );
});

test('projectSession：会话事件也能投影成同一种条目形状', () => {
  const events = [
    { type: 'user.message', time: Date.parse('2026-09-08T09:00:00.000Z'), seq: 1, data: { text: '开始吧' } },
    { type: 'assistant.message', time: Date.parse('2026-09-08T09:00:05.000Z'), seq: 2, data: { text: '好的' } },
  ];
  const entries = projectSession(events, { sessionId: 's1' });
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.source, 'session');
    assert.ok(Number.isFinite(entry.atMs));
  }
});

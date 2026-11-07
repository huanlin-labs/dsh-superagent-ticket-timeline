/**
 * 第三块：阶段八态 + 三条优先级反例
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTicketStream } from '../src/ticket-events.mjs';
import { STAGE_IDS, reduceStream, stageAt, stageOf } from '../src/ticket-stage.mjs';
import { ev, ticketDoc } from './helpers.mjs';

const created = (i = 0) => ev(i, 'ticket.created', {
  ticketId: 'tk-test', title: '测试用票据', decisionId: 'dec-1', strength: 'explicit',
});
const started = (i = 1) => ev(i, 'assignment.started', { assignmentId: 'as-1', state: 'running' });
const report = (i, state) => ev(i, 'report.' + state, { assignmentId: 'as-1', summary: '汇报 ' + state });

/** 构造并解析，返回末尾 stage。 */
function lastStage(events) {
  const parsed = parseTicketStream(ticketDoc(events), { source: 'test' });
  return stageAt(parsed, events.at(-1).at).id;
}

test('阶段表恰好 8 个，且没有重复', () => {
  assert.equal(STAGE_IDS.length, 8);
  assert.equal(new Set(STAGE_IDS).size, 8);
});

test('八态逐一可达：每个 stage 都有能构造出来的事件序列', () => {
  const cases = [
    ['working/queued', [created()]],
    ['working', [created(), started()]],
    ['person/review', [created(), started(), report(2, 'ready')]],
    ['person/blocked', [created(), started(), report(2, 'blocked')]],
    ['person/failed', [created(), started(), report(2, 'failed')]],
    ['person/answer', [created(), started(), ev(2, 'attention.raised', { question: '要哪个环境？' })]],
    ['person/delivery', [created(), started(), ev(2, 'delivery.failed', { error: '连接被拒' })]],
    ['idle', [created(), started(), report(2, 'waiting')]],
  ];
  for (const [expected, events] of cases) {
    assert.equal(lastStage(events), expected, `这串事件应落在 ${expected}`);
  }
  const covered = new Set(cases.map(([stage]) => stage));
  assert.deepEqual([...covered].sort(), [...STAGE_IDS].sort(), '八态必须全覆盖');
});

// ── 三条优先级反例（顺序取 003 的表）────────────────────────
test('反例①：未交付失败 与 blocked 并存 → 取 person/delivery（delivery 优先）', () => {
  const events = [created(), started(), report(2, 'blocked'), ev(3, 'delivery.failed', { error: '投递失败' })];
  assert.equal(lastStage(events), 'person/delivery');
});

test('反例②：待答复提问 与 blocked 并存 → 取 person/answer（answer 优先于 blocked）', () => {
  const events = [created(), started(), report(2, 'blocked'), ev(3, 'attention.raised', { question: '给个地址？' })];
  assert.equal(lastStage(events), 'person/answer');
});

test('反例③：待答复提问 与 ready 并存 → 仍取 person/answer（answer 优先于 review）', () => {
  const events = [created(), started(), report(2, 'ready'), ev(3, 'attention.raised', { question: '要不要合并？' })];
  assert.equal(lastStage(events), 'person/answer');
});

test('blocked 被人话解除：人类消息一到就回到 working', () => {
  const events = [
    created(), started(), report(2, 'blocked'),
    ev(3, 'input.trigger', { triggerId: 'tr-1', human: true }),
  ];
  assert.equal(lastStage(events), 'working');
});

test('stageOf 是纯函数：同一 state 反复调用结果一致', () => {
  const parsed = parseTicketStream(ticketDoc([created(), started()]), { source: 'test' });
  const state = reduceStream(parsed).at(-1).state;
  assert.equal(stageOf(state).id, stageOf(state).id);
});

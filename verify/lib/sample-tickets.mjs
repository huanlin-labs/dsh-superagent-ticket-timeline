/**
 * 三份 Ticket 事件流形状样例（验收用，不是交付物 fixtures/）。
 * 真·fixtures 由「三份 fixture」小类产出；此处只保证解析器有可解析的三种典型形状。
 * 时间戳取 2026-09-0x，语义对齐 docs/003-execution.md。
 */

/** ① 顺利到底：accept → working → ready → completed */
export const SAMPLE_HAPPY = {
  ticket: { id: 'tk-happy', title: '修复登录页在 Safari 下白屏' },
  declaredEventCount: 11,
  events: [
    { at: '2026-09-01T09:00:00.000Z', type: 'ticket.created', ticketId: 'tk-happy', title: '修复登录页在 Safari 下白屏', decisionId: 'dec-1', strength: 'explicit' },
    { at: '2026-09-01T09:00:01.000Z', type: 'assignment.started', assignmentId: 'as-0', state: 'running' },
    { at: '2026-09-01T09:00:02.000Z', type: 'input.trigger', triggerId: 'tr-1', human: true },
    { at: '2026-09-01T09:01:00.000Z', type: 'report.progress', assignmentId: 'as-0', summary: '已经复现白屏，正在定位 Safari 的兼容分支' },
    { at: '2026-09-01T09:06:00.000Z', type: 'report.progress', assignmentId: 'as-0', summary: '改完 polyfill，本地 Safari 18 通过' },
    { at: '2026-09-01T09:10:00.000Z', type: 'report.ready', assignmentId: 'as-0', summary: '修复完成，改动 42 行，等你过一眼' },
    { at: '2026-09-01T09:11:00.000Z', type: 'assignment.ended', assignmentId: 'as-0', reason: 'ready' },
    { at: '2026-09-01T09:12:00.000Z', type: 'input.note', text: 'CI 已绿，可以收尾' },
    { at: '2026-09-01T09:15:00.000Z', type: 'attention.raised', question: '这个 polyfill 要不要同时打进 legacy 构建？' },
    { at: '2026-09-01T09:20:00.000Z', type: 'attention.cleared' },
    { at: '2026-09-01T09:30:00.000Z', type: 'ticket.ended', by: 'executor', outcome: 'completed' },
  ],
};

/** ② 阻塞后重试：blocked → 人类消息 → 重新开工 → ready */
export const SAMPLE_BLOCKED = {
  ticket: { id: 'tk-blocked', title: '给导出接口补限流' },
  declaredEventCount: 13,
  events: [
    { at: '2026-09-02T10:00:00.000Z', type: 'ticket.created', ticketId: 'tk-blocked', title: '给导出接口补限流', decisionId: 'dec-2', strength: 'inferred' },
    { at: '2026-09-02T10:00:01.000Z', type: 'assignment.started', assignmentId: 'as-0', state: 'running' },
    { at: '2026-09-02T10:00:02.000Z', type: 'input.trigger', triggerId: 'tr-2', human: true },
    { at: '2026-09-02T10:00:03.000Z', type: 'delivery.failed', error: 'Executor Session 暂时不可达（连接被拒）' },
    { at: '2026-09-02T10:00:10.000Z', type: 'delivery.delivered' },
    { at: '2026-09-02T10:02:00.000Z', type: 'report.progress', assignmentId: 'as-0', summary: '开始读现有的导出路径' },
    { at: '2026-09-02T10:09:00.000Z', type: 'report.blocked', assignmentId: 'as-0', summary: '缺 Redis 凭据，限流计数写不进去；需要你给个可用的实例地址' },
    { at: '2026-09-02T10:30:00.000Z', type: 'input.trigger', triggerId: 'tr-3', human: true },
    { at: '2026-09-02T10:31:00.000Z', type: 'report.progress', assignmentId: 'as-0', summary: '拿到地址了，接上 Redis 继续' },
    { at: '2026-09-02T10:40:00.000Z', type: 'report.ready', assignmentId: 'as-0', summary: '限流 100 rps 已生效，压测通过' },
    { at: '2026-09-02T10:41:00.000Z', type: 'assignment.ended', assignmentId: 'as-0', reason: 'ready' },
    { at: '2026-09-02T10:42:00.000Z', type: 'input.note', text: '对照工单 #5521 核对过阈值' },
    { at: '2026-09-02T11:00:00.000Z', type: 'ticket.ended', by: 'executor', outcome: 'completed' },
  ],
};

/** ③ dropped 后被人类消息唤醒：dropped → resumed → ready */
export const SAMPLE_RESUMED = {
  ticket: { id: 'tk-resumed', title: '复现「保存后列表不刷新」' },
  declaredEventCount: 12,
  events: [
    { at: '2026-09-03T14:00:00.000Z', type: 'ticket.created', ticketId: 'tk-resumed', title: '复现「保存后列表不刷新」', decisionId: 'dec-3', strength: 'explicit' },
    { at: '2026-09-03T14:00:01.000Z', type: 'assignment.started', assignmentId: 'as-0', state: 'running' },
    { at: '2026-09-03T14:00:02.000Z', type: 'input.trigger', triggerId: 'tr-4', human: true },
    { at: '2026-09-03T14:05:00.000Z', type: 'report.progress', assignmentId: 'as-0', summary: '按描述步骤试了三次，列表都正常刷新' },
    { at: '2026-09-03T14:12:00.000Z', type: 'report.dropped', assignmentId: 'as-0', summary: '本地复现不了，先挂着；有新的复现步骤再叫我' },
    { at: '2026-09-03T14:13:00.000Z', type: 'assignment.ended', assignmentId: 'as-0', reason: 'dropped' },
    { at: '2026-09-03T14:14:00.000Z', type: 'ticket.ended', by: 'executor', outcome: 'dropped' },
    { at: '2026-09-04T09:00:00.000Z', type: 'input.trigger', triggerId: 'tr-5', human: true },
    { at: '2026-09-04T09:00:01.000Z', type: 'assignment.started', assignmentId: 'as-1', state: 'running' },
    { at: '2026-09-04T09:20:00.000Z', type: 'report.ready', assignmentId: 'as-1', summary: '按你给的新步骤复现到了，缓存 key 少一维已修' },
    { at: '2026-09-04T09:21:00.000Z', type: 'assignment.ended', assignmentId: 'as-1', reason: 'ready' },
    { at: '2026-09-04T09:30:00.000Z', type: 'ticket.ended', by: 'executor', outcome: 'completed' },
  ],
};

export const SAMPLES = [
  { name: 'happy', doc: SAMPLE_HAPPY },
  { name: 'blocked', doc: SAMPLE_BLOCKED },
  { name: 'resumed', doc: SAMPLE_RESUMED },
];

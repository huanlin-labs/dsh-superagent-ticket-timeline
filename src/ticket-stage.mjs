/**
 * Ticket 阶段推导（docs/003-execution.md 的 stage 表）。
 *
 * 核心事实：003 的 stage 表是**有序**的，读法明说「Read the table from top to bottom;
 * the first matching row wins」。所以这里不写 if/else 树，而是：
 *   STAGE_RULES = 一个有序数组，每条规则 = 一个谓词 + 它在 003 里的原文行
 *   stageOf(state) = STAGE_RULES.find(rule => rule.when(state))
 * 谁想改优先级，只能动数组顺序——顺序即规范，在代码里看得见。
 *
 * 表（自上而下，第一个命中者胜）：
 *   person/delivery  Delivering an Input to the Executor Session failed ...
 *   person/answer    It has an Attention
 *   person/review    The latest Report is `ready`
 *   person/blocked   The latest Report is `blocked`, and no person's message reached the Ticket since
 *   person/failed    （同上，`failed`）
 *   working/queued   No Assignment, or a pending one
 *   idle             The latest Report is `waiting`, or the Assignment ended
 *   working          Everything else
 */

/** 八个 stage 的稳定 id（顺序与 003 表一致）。 */
export const STAGE_IDS = [
  'person/delivery',
  'person/answer',
  'person/review',
  'person/blocked',
  'person/failed',
  'working/queued',
  'idle',
  'working',
];

/**
 * 有序规则表。`source` 是 003 表格该行的原文条件——测试的期望值就抄它，不拍脑袋。
 * `when(state)` 只看状态，不看事件：状态由 reduceStream 折叠出来。
 */
export const STAGE_RULES = [
  {
    id: 'person/delivery',
    label: 'Input undelivered',
    source: 'Delivering an Input to the Executor Session failed; it is retried after 2 seconds, then after a delay that doubles up to a minute, and a success, a new Assignment or the Ticket\u2019s end clears it',
    when: (state) => Boolean(state.delivery?.failed),
  },
  {
    id: 'person/answer',
    label: 'Awaiting answer',
    source: 'It has an Attention',
    when: (state) => Boolean(state.attention),
  },
  {
    id: 'person/review',
    label: 'Awaiting review',
    source: 'The latest Report is `ready`',
    when: (state) => state.latestReport?.state === 'ready',
  },
  {
    id: 'person/blocked',
    label: 'Blocked',
    source: 'The latest Report is `blocked` or `failed`, and no person\u2019s message reached the Ticket since',
    when: (state) => state.latestReport?.state === 'blocked' && !state.humanSinceReport,
  },
  {
    id: 'person/failed',
    label: 'Failed',
    source: 'The latest Report is `blocked` or `failed`, and no person\u2019s message reached the Ticket since',
    when: (state) => state.latestReport?.state === 'failed' && !state.humanSinceReport,
  },
  {
    id: 'working/queued',
    label: 'Queued',
    source: 'No Assignment, or a pending one',
    when: (state) => state.assignmentId === null,
  },
  {
    id: 'idle',
    label: 'Waiting for a Trigger',
    source: 'The latest Report is `waiting`, or the Assignment ended',
    when: (state) => state.latestReport?.state === 'waiting' || state.assignmentEnded,
  },
  {
    id: 'working',
    label: 'Working',
    source: 'Everything else',
    when: () => true,
  },
];

/** 折叠用的初始状态：没有任何事件时的 Ticket。 */
export function initialState() {
  return {
    /** 当前（最后一个开工的）assignment；null = 没有 assignment（003 的 "No Assignment"）。 */
    assignmentId: null,
    /** 当前 assignment 是否已结束（003 idle 行的 "the Assignment ended"）。 */
    assignmentEnded: false,
    /** 最新一份报告（任何 assignment 的最后一份）。 */
    latestReport: null,
    /** 未交付失败的记录；成功后清空（003 person/delivery 行的 "a success ... clears it"）。 */
    delivery: null,
    /** 未答复的 Attention。 */
    attention: null,
    /** 最新报告之后是否有人的消息到达过（决定 blocked/failed 是否仍成立）。 */
    humanSinceReport: false,
    /** Ticket 是否已结束。 */
    ended: null,
    /** 事件计数，便于断言。 */
    eventCount: 0,
  };
}

/**
 * 把一条事件折进状态，返回新状态（不改入参）。
 * 这里的每条分支都能在 003 / model.ts 找到出处，注释里标了行号。
 */
export function applyEvent(state, event) {
  const next = { ...state, eventCount: state.eventCount + 1 };

  switch (event.type) {
    case 'ticket.created':
      // 新 Ticket 从零开始（M2 的自动派发/attention 都还没发生）
      return { ...initialState(), eventCount: next.eventCount };

    case 'assignment.started':
      // 003 person/delivery 行：new Assignment 也清掉 delivery 失败
      next.assignmentId = event.assignmentId;
      next.assignmentEnded = false;
      next.delivery = null;
      next.humanSinceReport = false;
      return next;

    case 'assignment.ended':
      next.assignmentEnded = true;
      return next;

    case 'report.progress':
    case 'report.waiting':
    case 'report.ready':
    case 'report.blocked':
    case 'report.failed':
    case 'report.dropped':
      next.latestReport = { state: event.state, summary: event.summary, at: event.at, atMs: event.atMs, assignmentId: event.assignmentId };
      // 新报告意味着"此后有没有人来消息"重新计数
      next.humanSinceReport = false;
      return next;

    case 'input.trigger':
      // 003：A new human message releases a blocked or failed Ticket…
      if (event.human) next.humanSinceReport = true;
      return next;

    case 'delivery.failed':
      // 003 person/delivery 行
      next.delivery = { failed: true, error: event.error, at: event.at, atMs: event.atMs };
      return next;

    case 'delivery.delivered':
      next.delivery = null;
      return next;

    case 'attention.raised':
      next.attention = { question: event.question, at: event.at, atMs: event.atMs };
      return next;

    case 'attention.cleared':
      next.attention = null;
      return next;

    case 'ticket.ended':
      next.ended = { by: event.by, outcome: event.outcome, reason: event.reason, at: event.at, atMs: event.atMs };
      // 003：the Ticket's end 也清掉 delivery 失败与 attention
      next.delivery = null;
      next.attention = null;
      return next;

    default:
      // 未知事件不改变阶段（解析层已经拦过未知类型，这里只做防御）
      return next;
  }
}

/** 当前状态对应的 stage（第一个命中的规则）。 */
export function stageOf(state) {
  const rule = STAGE_RULES.find((candidate) => candidate.when(state));
  return { id: rule.id, label: rule.label, source: rule.source };
}

/** 折叠整条事件流，返回每一步之后的状态快照。 */
export function reduceStream(parsed) {
  const steps = [{ at: null, atMs: -Infinity, state: initialState(), event: null }];
  let state = initialState();
  for (const event of parsed.events) {
    state = applyEvent(state, event);
    steps.push({ at: event.at, atMs: event.atMs, state, event });
  }
  return steps;
}

/**
 * 给定时间点上 的 stage。
 * @param {{events: Array<object>}} parsed
 * @param {string|number} when ISO 字符串或毫秒时间戳
 */
export function stageAt(parsed, when) {
  const atMs = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(atMs)) throw new TypeError(`stageAt 需要可解析的时间，收到 ${JSON.stringify(when)}`);
  let state = initialState();
  for (const event of parsed.events) {
    if (event.atMs > atMs) break;
    state = applyEvent(state, event);
  }
  return { ...stageOf(state), at: new Date(atMs).toISOString(), state };
}

/**
 * 整条 Ticket 的 stage 变化序列：只在 stage 变化时记一条。
 * 首条固定在第一条事件（ticket.created）的时刻——这是时间线的起点。
 */
export function stageSequence(parsed) {
  const steps = reduceStream(parsed);
  const entries = [];
  let previous = null;
  for (const step of steps) {
    if (!step.event) continue; // 初始占位，跳过
    const stage = stageOf(step.state);
    const rounded = {
      at: step.at,
      atMs: step.atMs,
      stage: stage.id,
      label: stage.label,
      cause: step.event.type,
      causeIndex: step.event.index,
      ended: Boolean(step.state.ended),
    };
    if (!previous || previous.stage !== rounded.stage) {
      entries.push(rounded);
      previous = rounded;
    } else {
      // 同 stage 的后续事件不新增条目，但记下最后一次发生时刻，便于算时长
      previous.lastSeenAt = rounded.at;
      previous.lastSeenAtMs = rounded.atMs;
    }
  }
  return entries;
}

/** 当前 stage 持续时长（毫秒），用于概览。 */
export function stageDurations(parsed) {
  const entries = stageSequence(parsed);
  const end = parsed.events.at(-1)?.atMs ?? 0;
  return entries.map((entry, i) => ({
    stage: entry.stage,
    label: entry.label,
    from: entry.at,
    to: entries[i + 1]?.at ?? new Date(end).toISOString(),
    ms: (entries[i + 1]?.atMs ?? end) - entry.atMs,
  }));
}

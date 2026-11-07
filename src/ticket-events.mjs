/**
 * Ticket 事件流解析。
 *
 * 字段依据：docs/003-execution.md（stage 表、assignment 生命周期、delivery 失败、retry/restart）
 *          + dsh-superagent-prototype/src/core/model.ts（Ticket / Assignment / ReportState / TicketInput）
 *
 * 文件形状（fixture 与真实导出共用）：
 * {
 *   "declaredEventCount": 12,          // 必填：文件自称有几条事件，解析时对账
 *   "ticket": { "id": "tk-1", "title": "..." },   // 可选：标题等元信息
 *   "events": [ { "at": "...ISO...", "type": "ticket.created", ... }, ... ]
 * }
 *
 * 设计取舍：
 *   - 规格是**数据**（EVENT_SPEC 表），不是一堆 if/else；加事件类型只改表。
 *   - 校验**严格失败**：宁可在解析阶段报「第 3 条事件缺 at」，
 *     也不要把坏事件吞掉后在时间线上留下一段"什么都没发生"的空白。
 *   - 报错信息统一带**1 基下标**（人话：第 3 条），机器侧另有 index/field 字段。
 */

/** 报告状态：docs/003 与 model.ts 的 ReportState 完全一致。 */
export const REPORT_STATES = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'];

/** assignment 状态（model.ts 的 AssignmentState）。 */
export const ASSIGNMENT_STATES = ['pending', 'running', 'ended'];

/** ticket 结束方式 / 结果（model.ts 的 TicketEndBy / TicketOutcome）。 */
export const END_BY = ['executor', 'human'];
export const OUTCOMES = ['completed', 'merged', 'closed', 'dropped', 'stopped'];

const reportTypes = Object.fromEntries(REPORT_STATES.map((state) => [
  `report.${state}`,
  // 报告必须落在某个 assignment 上，且带一句话摘要——003 里 report 就是 Executor 说的话。
  { required: { assignmentId: 'string', summary: 'string' }, shape: 'report', state },
]));

/**
 * 事件规格表。required 里字段名 → 期望类型；enum 里字段名 → 允许值。
 * 未知字段不报错（真实日志会带 meta 之类的东西，容许但不依赖）。
 */
export const EVENT_SPEC = {
  'ticket.created': {
    required: { ticketId: 'string', title: 'string', decisionId: 'string', strength: 'string' },
    enums: { strength: ['explicit', 'inferred'] },
  },
  'ticket.ended': {
    required: { by: 'string', outcome: 'string' },
    enums: { by: END_BY, outcome: OUTCOMES },
  },
  'assignment.started': { required: { assignmentId: 'string', state: 'string' }, enums: { state: ASSIGNMENT_STATES } },
  'assignment.ended': { required: { assignmentId: 'string', reason: 'string' } },
  ...reportTypes,
  // 人类的或自动的输入；human 只在人写的消息上出现，且必须是布尔。
  'input.trigger': { required: { triggerId: 'string' }, booleans: { human: true } },
  'input.note': { required: { text: 'string' } },
  // 003 person/delivery 行的成因：把 Input 交给 Executor Session 失败。
  'delivery.failed': { required: { error: 'string' }, shape: 'delivery' },
  'delivery.delivered': { required: {}, shape: 'delivery' },
  'attention.raised': { required: { question: 'string' }, shape: 'attention' },
  'attention.cleared': { required: {}, shape: 'attention' },
};

export const EVENT_TYPES = Object.keys(EVENT_SPEC);

/** 解析错误：带 1 基下标与字段名，既给人看也给机器读。 */
export class TicketParseError extends Error {
  constructor({ code, index, field, message, detail }) {
    super(message);
    this.name = 'TicketParseError';
    this.code = code;
    this.index = index;
    this.field = field;
    this.detail = detail;
    // 人话序号：数组下标 2 → 「第 3 条」
    this.ordinal = typeof index === 'number' ? index + 1 : undefined;
  }
}

const isIsoTimestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function fail(code, index, field, message, detail) {
  throw new TicketParseError({ code, index, field, message, detail });
}

function ensureObject(value, index) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('EVENT_SHAPE', index, null, `第 ${index + 1} 条事件不是对象（${Array.isArray(value) ? 'array' : typeof value}）`);
  }
}

/** 校验单条事件，返回规范化后的副本（at 同时给出 iso 与毫秒）。 */
function normalizeEvent(raw, index) {
  ensureObject(raw, index);

  if (typeof raw.type !== 'string' || raw.type === '') {
    fail('MISSING_FIELD', index, 'type', `第 ${index + 1} 条事件缺 type（不知这是什么事件）`);
  }
  const spec = EVENT_SPEC[raw.type];
  if (!spec) {
    fail('UNKNOWN_TYPE', index, 'type',
      `第 ${index + 1} 条事件的 type="${raw.type}" 不认识；允许的有 ${EVENT_TYPES.join(' / ')}`);
  }

  if (raw.at === undefined) {
    fail('MISSING_FIELD', index, 'at', `第 ${index + 1} 条事件（${raw.type}）缺 at（没有时间点，时间线就排不出来）`);
  }
  if (!isIsoTimestamp(raw.at)) {
    fail('BAD_FIELD_TYPE', index, 'at',
      `第 ${index + 1} 条事件（${raw.type}）的 at 不是可解析的时间戳：${JSON.stringify(raw.at)}`);
  }

  for (const [field, type] of Object.entries(spec.required ?? {})) {
    if (raw[field] === undefined || raw[field] === null) {
      fail('MISSING_FIELD', index, field, `第 ${index + 1} 条事件（${raw.type}）缺 ${field}`);
    }
    if (type === 'string' && typeof raw[field] !== 'string') {
      fail('BAD_FIELD_TYPE', index, field,
        `第 ${index + 1} 条事件（${raw.type}）的 ${field} 应为字符串，实际是 ${typeof raw[field]}`);
    }
  }

  for (const [field, allowed] of Object.entries(spec.enums ?? {})) {
    if (raw[field] !== undefined && !allowed.includes(raw[field])) {
      fail('BAD_FIELD_VALUE', index, field,
        `第 ${index + 1} 条事件（${raw.type}）的 ${field}="${raw[field]}" 不在允许值 ${allowed.join(' / ')} 内`);
    }
  }

  for (const [field, mustTrue] of Object.entries(spec.booleans ?? {})) {
    if (raw[field] !== undefined && typeof raw[field] !== 'boolean') {
      fail('BAD_FIELD_TYPE', index, field,
        `第 ${index + 1} 条事件（${raw.type}）的 ${field} 应为布尔，实际是 ${typeof raw[field]}`);
    }
    if (mustTrue && raw[field] === false) {
      // false 是合法值（自动输入），这里不拦；保留分支只为说明语义。
    }
  }

  const atMs = Date.parse(raw.at);
  const event = {
    ...raw,
    index,
    at: new Date(atMs).toISOString(),
    atMs,
    iso: new Date(atMs).toISOString(),
  };
  if (spec.shape) event.shape = spec.shape;
  if (spec.state) event.state = spec.state;
  // human 只可能来自 trigger：显式 false 也保留，别的类型不凭空加字段
  if (raw.type === 'input.trigger') event.human = raw.human === true;
  // delivery 失败保留原意：错误文本与发生时刻都要在
  if (raw.type === 'delivery.failed') event.delivery = { error: raw.error, at: event.at, ok: false };
  if (raw.type === 'delivery.delivered') event.delivery = { at: event.at, ok: true };
  return event;
}

/**
 * 解析一份 Ticket 事件流。
 * @param {string|object} input JSON 文本或已解析对象
 * @param {{ source?: string }} [options]
 * @returns {{ ticket: object, events: Array<object>, declaredEventCount: number, meta: object }}
 * @throws {TicketParseError}
 */
export function parseTicketStream(input, options = {}) {
  let doc = input;
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input);
    } catch (error) {
      throw new TicketParseError({ code: 'BAD_JSON', message: `不是合法 JSON：${error.message}`, detail: options.source });
    }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new TicketParseError({
      code: 'BAD_ENVELOPE',
      message: '顶层应为对象（{ declaredEventCount, events, ticket? }），实际是 ' + (Array.isArray(doc) ? 'array' : typeof doc),
    });
  }
  if (!Array.isArray(doc.events)) {
    throw new TicketParseError({ code: 'MISSING_FIELD', field: 'events', message: '顶层缺 events 数组' });
  }
  if (doc.events.length === 0) {
    throw new TicketParseError({ code: 'EMPTY_STREAM', field: 'events', message: 'events 是空数组：没有可展示的事件' });
  }

  const events = doc.events.map(normalizeEvent);

  // 顺序容错：允许文件里乱序，但 parse 会按时间稳定排序（同刻按原 index 保持）
  events.sort((a, b) => (a.atMs - b.atMs) || (a.index - b.index));

  const declared = doc.declaredEventCount;
  if (declared === undefined) {
    throw new TicketParseError({
      code: 'MISSING_FIELD', field: 'declaredEventCount',
      message: '顶层缺 declaredEventCount（文件自称几条事件；没有它就无法对账丢没丢）',
    });
  }
  if (typeof declared !== 'number' || !Number.isInteger(declared)) {
    throw new TicketParseError({
      code: 'BAD_FIELD_TYPE', field: 'declaredEventCount',
      message: `declaredEventCount 应为整数，实际是 ${typeof declared}`,
    });
  }
  if (declared !== events.length) {
    throw new TicketParseError({
      code: 'COUNT_MISMATCH', field: 'declaredEventCount',
      message: `声明 ${declared} 条，实际解析出 ${events.length} 条 —— 事件数与文件内声明不一致`,
    });
  }

  const ticket = doc.ticket ?? {};
  return {
    ticket,
    events,
    declaredEventCount: declared,
    meta: {
      source: options.source,
      firstAt: events[0]?.at,
      lastAt: events.at(-1)?.at,
      durationMs: events.at(-1).atMs - events[0].atMs,
      types: countByType(events),
    },
  };
}

/** 各事件类型出现次数，概览与测试都用得上。 */
export function countByType(events) {
  const counts = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

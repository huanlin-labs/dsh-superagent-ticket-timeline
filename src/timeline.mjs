/**
 * 统一时间线条目：把 Ticket 事件与 DSH 会话事件投影成同一种条目。
 *
 * 条目形状：{ id, at, atMs, source, kind, subject, summary, rawRef }
 *   source   'ticket' | 'session'
 *   kind     事件类型（ticket 的 type / session 的 type 原样保留，便于筛选）
 *   subject  谁在动作（worker / person / system / ticket / tool:<name>）
 *   summary  一句话人话（不是类型名堆砌）
 *   rawRef   { source, index } 或 { source, seq } —— 能回到原始事件
 *
 * 排序契约（stable）：atMs 升序 → sourceRank（ticket 先于 session）→ seq/index 升序。
 * 三项全序意味着：同刻事件的相对顺序**不依赖数组传入顺序**，多次运行结果逐条相同。
 */

/** 两个来源的固定先后（同毫秒时用来定序，不是"谁更重要"）。 */
export const SOURCE_RANK = { ticket: 0, session: 1 };

const clamp = (text, max = 80) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
};

/** 从任意形状的会话事件 data 里捞出一段人类可读的文本。 */
function firstText(data, depth = 0) {
  if (data == null || depth > 3) return '';
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = firstText(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof data === 'object') {
    for (const key of ['text', 'content', 'message', 'summary', 'title', 'name', 'question', 'error', 'command']) {
      if (key in data) {
        const found = firstText(data[key], depth + 1);
        if (found) return found;
      }
    }
    // arguments 之类：给个紧凑 JSON 摘要
    if ('arguments' in data) {
      try {
        return clamp(JSON.stringify(data.arguments), 60);
      } catch {
        return '';
      }
    }
  }
  return '';
}

// ─────────────────────────── Ticket 投影 ───────────────────────────

/** Ticket 事件 → { subject, summary }（人话，含"谁 + 做了什么 + 关键内容"）。 */
export function describeTicketEvent(event) {
  switch (event.type) {
    case 'ticket.created':
      return { subject: 'ticket', summary: `Ticket 建单：${clamp(event.title, 40)}（${event.strength} 授权，决策 ${event.decisionId}）` };
    case 'ticket.ended':
      return { subject: 'ticket', summary: `Ticket 结束：${event.outcome}（由 ${event.by}${event.reason ? '，' + clamp(event.reason, 30) : ''}）` };
    case 'assignment.started':
      return { subject: 'worker', summary: `worker 开工（assignment ${event.assignmentId}）` };
    case 'assignment.ended':
      return { subject: 'worker', summary: `worker 收工（assignment ${event.assignmentId}）：${clamp(event.reason, 30)}` };
    case 'report.progress':
    case 'report.waiting':
    case 'report.ready':
    case 'report.blocked':
    case 'report.failed':
    case 'report.dropped':
      return { subject: 'worker', summary: `worker 汇报 ${event.state}：${clamp(event.summary)}` };
    case 'input.trigger':
      return event.human
        ? { subject: 'person', summary: `人来消息（${event.triggerId}）` }
        : { subject: 'system', summary: `自动输入（${event.triggerId}）` };
    case 'input.note':
      return { subject: 'system', summary: `主会话留了条注记：${clamp(event.text)}` };
    case 'delivery.failed':
      return { subject: 'system', summary: `交付给 worker 失败：${clamp(event.error)}` };
    case 'delivery.delivered':
      return { subject: 'system', summary: '补投成功，输入已进 worker 的会话' };
    case 'attention.raised':
      return { subject: 'worker', summary: `worker 向人提问：${clamp(event.question)}` };
    case 'attention.cleared':
      return { subject: 'person', summary: '提问已处理，Ticket 继续' };
    default:
      return { subject: 'ticket', summary: `事件 ${event.type}` };
  }
}

/** Ticket 流 → 条目数组。`rawRef.index` 指回 parsed.events 的下标。 */
export function projectTicket(parsed) {
  return parsed.events.map((event) => {
    const { subject, summary } = describeTicketEvent(event);
    return {
      id: `ticket:${event.index}:${event.type}`,
      at: event.at,
      atMs: event.atMs,
      source: 'ticket',
      kind: event.type,
      subject,
      summary,
      rawRef: { source: 'ticket', index: event.index },
    };
  });
}

// ─────────────────────────── 会话投影 ───────────────────────────

/**
 * 低信息事件：真实会话日志里这些能占掉一半以上的行，对「看懂发生了什么」零贡献。
 * 判定放在投影层（而非渲染层），这样文本/JSON/HTML 三条出口口径一致。
 */
const NOISE_PREFIX = /^(request\/|permission\/|sandbox\/|approval\/|agent\/inbox|step\/|subagent\/|session\/title-llm)/;

export function isLowSignalSessionEvent(event) {
  const type = event?.type ?? '';
  if (NOISE_PREFIX.test(type)) return true;
  if (type === 'tool/result' && !firstText(event?.data ?? {}).trim()) return true;
  return false;
}

/** 系统注入到 user/message 里的整段（工作区规则、运行时上下文等），不是人说的话。 */
const SYSTEM_INJECT = /^\s*(<system-reminder>|The following workspace instructions|Current runtime context|A skill is a reusable)/;

/** DSH 会话事件 → { subject, summary }。事件形状：{ type, seq, time(ms), data }。 */
export function describeSessionEvent(event) {
  const data = event.data ?? {};
  const name = data.name ?? data.tool ?? '';
  switch (event.type) {
    case 'user/message': {
      const text = firstText(data);
      return { subject: 'person', summary: SYSTEM_INJECT.test(text) ? '用户：（系统注入，略）' : `用户：${clamp(text)}` };
    }
    case 'assistant/message':
      return { subject: 'assistant', summary: `助手：${clamp(firstText(data))}` };
    case 'tool/call':
      return { subject: `tool:${name || 'unknown'}`, summary: `调用 ${name || '(未命名工具)'}：${clamp(firstText(data.arguments) || '（无参数摘要）', 60)}` };
    case 'tool/result':
      return { subject: `tool:${name || 'unknown'}`, summary: `${name || '工具'} 返回结果：${clamp(firstText(data) || '（无文本）', 60)}` };
    case 'turn/start':
      return { subject: 'assistant', summary: `第 ${data.turn ?? '?'} 轮开始` };
    case 'turn/end':
      return { subject: 'assistant', summary: `第 ${data.turn ?? '?'} 轮结束` };
    case 'step/start':
      return { subject: 'assistant', summary: `第 ${data.turn ?? '?'} 轮第 ${data.step ?? '?'} 步开始` };
    case 'step/end':
      return { subject: 'assistant', summary: `第 ${data.turn ?? '?'} 轮第 ${data.step ?? '?'} 步结束` };
    case 'todo/write':
      return { subject: 'system', summary: `更新待办：${Array.isArray(data.todos) ? data.todos.length + ' 项' : '（无清单）'}` };
    case 'deliverables/presented':
      return { subject: 'system', summary: `交付物：${clamp(firstText(data) || '已呈现', 50)}` };
    case 'session/title':
      return { subject: 'system', summary: `会话标题：${clamp(firstText(data))}` };
    // 未知类型不再回显 type 名（「会话事件 request/header」这种行等于没写）
    default:
      return { subject: 'system', summary: '其他会话事件' };
  }
}

/**
 * 会话事件 → 条目数组。
 * `rawRef.seq` 指回原始事件的 seq（DSH 自己的序号，天然可回溯）。
 */
export function projectSession(events, options = {}) {
  const kept = [];
  let omitted = 0;
  for (const event of events) {
    if (typeof event?.type !== 'string' || !Number.isFinite(event.time)) continue;
    if (!options.includeLowSignal && isLowSignalSessionEvent(event)) {
      omitted += 1;
      continue;
    }
    const { subject, summary } = describeSessionEvent(event);
    kept.push({
      id: `session:${event.seq}:${event.type}`,
      at: new Date(event.time).toISOString(),
      atMs: event.time,
      source: 'session',
      kind: event.type,
      subject,
      summary,
      rawRef: { source: 'session', seq: event.seq },
      sessionId: options.sessionId,
    });
  }
  // 被折叠的条数挂在数组上（不可枚举，JSON 出口不会带出这个字段）
  Object.defineProperty(kept, 'omittedLowSignal', { value: omitted, enumerable: false });
  return kept;
}

// ─────────────────────────── 混排 ───────────────────────────

/** 三项全序比较：时间 → 来源 → 原始序号。 */
function compareEntries(a, b) {
  if (a.atMs !== b.atMs) return a.atMs - b.atMs;
  const rank = (SOURCE_RANK[a.source] ?? 99) - (SOURCE_RANK[b.source] ?? 99);
  if (rank !== 0) return rank;
  const aSeq = a.rawRef.seq ?? a.rawRef.index ?? 0;
  const bSeq = b.rawRef.seq ?? b.rawRef.index ?? 0;
  return aSeq - bSeq;
}

/** 把任意多个条目数组混排成一条；不改入参，返回新数组。 */
export function mergeTimelines(...lists) {
  const flat = lists.flat().filter(Boolean);
  return [...flat].sort(compareEntries);
}

/**
 * 用 rawRef 回到原始事件。
 * @param {{source:string}} ref
 * @param {{ticket?: object, session?: Array<object>}} collections
 */
export function resolveRef(ref, collections) {
  if (ref.source === 'ticket') {
    const event = collections.ticket?.events?.[ref.index];
    if (!event) throw new RangeError(`ticket 事件下标越界：${ref.index}`);
    return event;
  }
  if (ref.source === 'session') {
    const event = (collections.session ?? []).find((candidate) => candidate.seq === ref.seq);
    if (!event) throw new RangeError(`找不到 seq=${ref.seq} 的会话事件`);
    return event;
  }
  throw new TypeError(`未知来源：${ref.source}`);
}

/** 混排后时间是否单调不减（验收与自检都用）。 */
export function isMonotonic(entries) {
  return entries.every((entry, i) => i === 0 || entries[i - 1].atMs <= entry.atMs);
}

export { compareEntries };

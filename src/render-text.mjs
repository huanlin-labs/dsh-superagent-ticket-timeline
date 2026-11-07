/**
 * 终端文本时间线：一行一条，能直读、能 grep。
 *
 * 版式（width=100 时）：
 *   tk-blocked · 导出接口加限流（决策 dec-2 / explicit）
 *   当前阶段 person/blocked   时长 12m34s   事件 13 条
 *   报告序列 progress → blocked → ready
 *   人类介入 2 次   失败 1 次   重试 1 次
 *
 *   10:00:00.000  working          Ticket 建单：…
 *   10:00:01.500  person/blocked   worker 汇报 blocked：等 CI 凭据
 *   ...
 *
 *   # 起点 → 终点：working → person/blocked（12m34s，7 段）
 *   # 卡点：阻塞 1 次、失败 1 次、人类介入 2 次；最长停在 person/blocked 8m
 *   # 结论：Ticket 未结束，当前在 person/blocked 等 CI 凭据
 *
 * 两条硬约束（验收会逐行量）：
 *   1. 每行**显示宽度** ≤ width（中文按 2 列算），超了就截断加省略号，绝不折行；
 *   2. 关闭颜色时不出现任何 \x1b —— 用 `color: false` 或环境变量 NO_COLOR。
 */

import { initialState, applyEvent, stageOf, stageSequence } from './ticket-stage.mjs';

/** 每个阶段一枚徽章色（SGR 前景色）。 */
export const STAGE_COLORS = {
  'person/delivery': 91, // 亮红：投递失败最要命
  'person/failed': 31,   // 红
  'person/blocked': 33,  // 黄
  'person/answer': 93,   // 亮黄：等人回答
  'person/review': 96,   // 亮青：等人验收
  'working/queued': 34,  // 蓝
  working: 32,           // 绿
  idle: 90,              // 灰
};

const MIN_WIDTH = 60;
const TIME_WIDTH = 12; // HH:MM:SS.mmm

/** 显示宽度：CJK / 全角按 2 列，其余按 1 列（等宽终端下的实际占位）。 */
export function displayWidth(text) {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1f9ff);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 按显示宽度截断，超出时末尾补一个省略号（省略号占 1 列）。 */
export function fitWidth(text, budget) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (displayWidth(flat) <= budget) return flat;
  if (budget <= 1) return '…';
  let out = '';
  let width = 0;
  for (const char of flat) {
    const charWidth = displayWidth(char);
    if (width + charWidth > budget - 1) break;
    out += char;
    width += charWidth;
  }
  return out + '…';
}

/** 补空格到指定显示宽度（徽章对齐用）。 */
function padWidth(text, width) {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

const paint = (text, code, color) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);

/** 毫秒 → 人话时长：<1s 用毫秒，<60s 用秒，其余 Xm Ys / Xh Ym。 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

const hhmmss = (iso) => {
  const date = new Date(iso);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
};

/** 从解析后的流里抽出概览要用的几个事实（纯统计，不改状态）。 */
export function summarize(parsed) {
  const events = parsed.events;
  const first = events[0];
  const last = events[events.length - 1];

  // 逐事件折叠，拿到"每条事件之后的阶段"
  const perEventStage = [];
  let state = initialState();
  for (const event of events) {
    state = applyEvent(state, event);
    perEventStage.push(stageOf(state).id);
  }
  const currentStage = perEventStage[perEventStage.length - 1] ?? 'working';

  const reports = events.filter((event) => event.type.startsWith('report.')).map((event) => event.state);
  const humanInputs = events.filter((event) => event.type === 'input.trigger' && event.human === true).length
    + events.filter((event) => event.type === 'attention.cleared').length;
  const failedReports = events.filter((event) => event.type === 'report.failed').length;
  const deliveryFailures = events.filter((event) => event.type === 'delivery.failed').length;
  const assignments = events.filter((event) => event.type === 'assignment.started').length;
  const retries = Math.max(0, assignments - 1);
  const ended = events.find((event) => event.type === 'ticket.ended') ?? null;

  return {
    ticketId: parsed.ticket?.id ?? '(unknown)',
    title: parsed.ticket?.title ?? '(无标题)',
    decisionId: parsed.ticket?.decisionId ?? '—',
    strength: parsed.ticket?.strength ?? '—',
    eventCount: events.length,
    from: first?.at ?? null,
    to: last?.at ?? null,
    spanMs: first && last ? last.atMs - first.atMs : 0,
    currentStage,
    perEventStage,
    eventsAtMs: events.map((event) => event.atMs),
    reports,
    humanInputs,
    failedReports,
    deliveryFailures,
    retries,
    ended,
  };
}

/**
 * 渲染整份文本时间线。
 * @param {object} parsed parseTicketStream 的产物
 * @param {{width?:number, color?:boolean, title?:string}} options
 */
export function renderTextTimeline(parsed, options = {}) {
  const width = Math.max(MIN_WIDTH, options.width ?? 100);
  const color = options.color ?? !process.env.NO_COLOR;
  const info = summarize(parsed);

  // 窄屏回退：徽章列收窄，摘要预算随之变大
  const badgeWidth = width >= 90 ? 16 : 12;
  const summaryBudget = Math.max(8, width - TIME_WIDTH - 1 - badgeWidth - 1);
  const lines = [];

  // ── 头部概览 ──
  lines.push(fitWidth(`${info.ticketId} · ${info.title}（决策 ${info.decisionId} / ${info.strength}）`, width));
  lines.push(fitWidth(`当前阶段 ${info.currentStage}   时长 ${formatDuration(info.spanMs)}   事件 ${info.eventCount} 条`, width));
  lines.push(fitWidth(`报告序列 ${info.reports.length ? info.reports.join(' → ') : '（无汇报）'}`, width));
  lines.push(fitWidth(
    `人类介入 ${info.humanInputs} 次   失败 ${info.failedReports} 次   重试 ${info.retries} 次`
    + (info.deliveryFailures ? `   投递失败 ${info.deliveryFailures} 次` : ''),
    width,
  ));
  lines.push('');

  // ── 主体：一行一条 ──
  for (let i = 0; i < parsed.events.length; i += 1) {
    const event = parsed.events[i];
    const stageId = info.perEventStage[i];
    const code = STAGE_COLORS[stageId] ?? 0;
    const badge = padWidth(fitWidth(stageId, badgeWidth), badgeWidth);
    const summary = fitWidth(describeForLine(event), summaryBudget);
    const time = hhmmss(event.at);
    lines.push(`${time} ${paint(badge, code, color)} ${summary}`.replace(/\s+$/, ''));
  }
  lines.push('');

  // ── 尾部：三行"一眼看懂" ──
  for (const tail of describeTail(info, width)) lines.push(fitWidth(tail, width));

  return lines.join('\n') + '\n';
}

/** 单条事件的摘要文案（比 timeline.mjs 更短，给等宽列让位）。 */
function describeForLine(event) {
  const clamp = (text, max = 42) => {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
  };
  switch (event.type) {
    case 'ticket.created': return `建单：${clamp(event.title, 30)}`;
    case 'ticket.ended': return `结束：${event.outcome}（${event.by}）`;
    case 'assignment.started': return `worker 开工（${event.assignmentId}）`;
    case 'assignment.ended': return `worker 收工（${event.assignmentId}）：${clamp(event.reason, 24)}`;
    case 'report.progress': return `汇报 progress：${clamp(event.summary)}`;
    case 'report.waiting': return `汇报 waiting：${clamp(event.summary)}`;
    case 'report.ready': return `汇报 ready：${clamp(event.summary)}`;
    case 'report.blocked': return `汇报 blocked：${clamp(event.summary)}`;
    case 'report.failed': return `汇报 failed：${clamp(event.summary)}`;
    case 'report.dropped': return `汇报 dropped：${clamp(event.summary)}`;
    case 'input.trigger': {
      // 人的原话是排查时最关键的信息之一，摘要里必须带上（截断由 clamp 管）。
      const who = event.human ? '人说话' : '自动输入';
      const said = event.note ? `：${clamp(event.note, 30)}` : '';
      return `${who}（${event.triggerId}）${said}`;
    }
    case 'input.note': return `注记：${clamp(event.text, 34)}`;
    case 'delivery.failed': return `投递失败：${clamp(event.error, 30)}`;
    case 'delivery.delivered': return '补投成功';
    case 'attention.raised': return `向人提问：${clamp(event.question, 34)}`;
    case 'attention.cleared': return '提问已处理';
    default: return event.type;
  }
}

/** 尾部三行：起点→终点 / 卡点 / 结论。全部由数据算出，不写死。 */
function describeTail(info) {
  // 把逐事件阶段压掉连续重复，得到"经过哪几段"
  const segments = [];
  for (const stageId of info.perEventStage) {
    if (segments[segments.length - 1] !== stageId) segments.push(stageId);
  }
  const chain = segments.join(' → ');

  // 每段停留时长：用事件时间戳算
  const durations = new Map();
  let current = null;
  let startMs = null;
  for (let i = 0; i < info.perEventStage.length; i += 1) {
    const stageId = info.perEventStage[i];
    const atMs = info.eventsAtMs?.[i];
    if (stageId !== current) {
      if (current && startMs != null) durations.set(current, (durations.get(current) ?? 0) + (atMs - startMs));
      current = stageId;
      startMs = atMs;
    }
  }
  let longest = null;
  for (const [stageId, ms] of durations) {
    if (!longest || ms > longest.ms) longest = { stageId, ms };
  }

  // 数字放在链条前面：链太长被截断时，时长与段数不能跟着一起丢
  const line1 = `# 起点 → 终点（${formatDuration(info.spanMs)}，${segments.length} 段）：${chain}`;
  const line2 = `# 卡点：阻塞 ${info.reports.filter((r) => r === 'blocked').length} 次、`
    + `失败 ${info.failedReports} 次、人类介入 ${info.humanInputs} 次`
    + (longest ? `；最长停在 ${longest.stageId} ${formatDuration(longest.ms)}` : '');
  const line3 = info.ended
    ? `# 结论：Ticket 已结束 —— ${info.ended.outcome}（由 ${info.ended.by}）`
    : `# 结论：Ticket 未结束，当前在 ${info.currentStage}`;

  return [line1, line2, line3];
}

/**
 * CLI 骨架：三路子命令 + 统一 JSON 出口。
 *
 * 设计要点（都是为了让验收可机械核对）：
 *   1. **一张 SPEC 驱动三处**：参数定义只写一遍，`--help` 的渲染、参数解析、以及
 *      「help 里写的」与「实际吃的」天然一致——不是两处抄写后再人工比对。
 *   2. **错误只走一个出口**：所有预期错误抛 CliError，顶层统一印「错误：…」并给退出码；
 *      非预期异常也不许吐裸堆栈（只有 TT_DEBUG=1 时才附堆栈，给开发看）。
 *   3. **`--json` 三件套**：任何子命令的机读输出都含 `frameCount` / `entries` / `meta`，
 *      另附 `events` 让 `render` 能重建页面。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseTicketStream } from './ticket-events.mjs';
import { projectTicket, projectSession, mergeTimelines } from './timeline.mjs';
import { renderTextTimeline, formatDuration } from './render-text.mjs';
import { renderHtmlTimeline } from './render-html.mjs';
import { decodeZstd } from './zstd-decode.mjs';
import { stageAt } from './ticket-stage.mjs';
import { createRedactor } from './redact.mjs';
import { redactDocument, unmapText, readMappingFile } from './redact-audit.mjs';

/** 预期内的用户态错误：一句话中文 + 退出码，绝不带堆栈。 */
export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

const COMMON_FLAGS = [
  { flag: '--json', kind: 'bool', desc: '输出机读 JSON（含 frameCount / entries / meta / events）' },
  { flag: '--no-color', kind: 'bool', desc: '不输出 ANSI 颜色（等同设置 NO_COLOR=1）' },
  { flag: '--limit', kind: 'value', arg: 'N', desc: '只输出前 N 条时间线条目（0 表示不限制）' },
  { flag: '--map-out', kind: 'value', arg: 'FILE', desc: '把「真值→假名」对照表写到 FILE（默认不落盘）' },
  { flag: '--unmap', kind: 'value', arg: 'FILE', desc: '用 FILE 里的对照表把假名还原成真值' },
  { flag: '--help', kind: 'bool', desc: '显示本子命令帮助' },
];

/** 子命令表：help、解析、校验都只看这份。 */
export const COMMANDS = {
  ticket: {
    summary: '读 Ticket 事件流（fixture JSON），输出脱敏时间线',
    usage: 'ticket <fixture.json> [选项]',
    positionals: [{ name: 'fixture.json', desc: 'Ticket 事件流文件：{declaredEventCount?, ticket, events[]}' }],
    flags: COMMON_FLAGS,
    examples: [
      'ticket fixtures/ticket-blocked.json',
      'ticket fixtures/ticket-blocked.json --json > blocked.json',
      'ticket fixtures/ticket-blocked.json --no-color --limit 5',
    ],
  },
  session: {
    summary: '读 DSH 会话日志（多帧 .zstd），输出会话事件时间线',
    usage: 'session <file.zstd> [选项]',
    positionals: [{ name: 'file.zstd', desc: 'DSH 会话日志：~/.dsh/sessions/**/session.v*.jsonl.zstd' }],
    flags: [
      { flag: '--only', kind: 'value', arg: 'KIND', desc: '只留一类：person / assistant / tool / turn' },
      { flag: '--raw', kind: 'bool', desc: '不折叠低信息事件（请求头 / 权限 / 步进 / 空结果全列出）' },
      ...COMMON_FLAGS,
    ],
    examples: [
      'session session.v4.jsonl.zstd',
      'session session.v4.jsonl.zstd --json --limit 20',
    ],
  },
  render: {
    summary: '把 ticket/session --json 的产物渲染成单文件 HTML',
    usage: 'render --in <json> --out <html> [选项]',
    positionals: [],
    flags: [
      { flag: '--in', kind: 'value', arg: 'FILE', desc: '输入：ticket/session 的 --json 输出文件' },
      { flag: '--out', kind: 'value', arg: 'FILE', desc: '输出：单文件 HTML 路径' },
      ...COMMON_FLAGS,
    ],
    examples: [
      'render --in blocked.json --out blocked.html',
      'render --in blocked.json --out blocked.html --map-out mapping.json',
    ],
  },
  unmap: {
    summary: '用对照表把「已脱敏文本」还原成原文（命令行闭环）',
    usage: 'unmap --in <redacted.txt> --map <mapping.json> [--out <file>]',
    positionals: [],
    flags: [
      { flag: '--in', kind: 'value', arg: 'FILE', desc: '输入：含假名的文本（比如 ticket 加 map-out 后重定向得到的 r.txt）' },
      { flag: '--map', kind: 'value', arg: 'FILE', desc: '对照表：用 map-out 导出的 mapping.json' },
      { flag: '--out', kind: 'value', arg: 'FILE', desc: '输出文件（省略则打到 stdout）' },
      { flag: '--help', kind: 'bool', desc: '显示本子命令帮助' },
    ],
    examples: [
      'unmap --in redacted.txt --map mapping.json',
      'unmap --in redacted.txt --map mapping.json --out restored.txt',
    ],
  },
};

const MAIN_USAGE = `用法：ticket-timeline <子命令> [选项]

子命令：
${Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(9)}${spec.summary}`).join('\n')}

公共选项：--json / --no-color / --limit / --map-out / --unmap / --help
看某个子命令的细节：ticket-timeline <子命令> --help
`;

/** 从 SPEC 渲染 help —— 与解析器同源，所以不可能写歪。 */
export function renderHelp(name) {
  const spec = COMMANDS[name];
  if (!spec) throw new CliError(`不认识的子命令：${name}`, 2);
  const lines = [`用法：ticket-timeline ${spec.usage}`, '', spec.summary, ''];
  if (spec.positionals.length) {
    lines.push('位置参数：');
    for (const pos of spec.positionals) lines.push(`  ${pos.name.padEnd(16)}${pos.desc}`);
    lines.push('');
  }
  lines.push('选项：');
  for (const flag of spec.flags) {
    const head = flag.kind === 'value' ? `${flag.flag} <${flag.arg}>` : flag.flag;
    lines.push(`  ${head.padEnd(20)}${flag.desc}`);
  }
  if (spec.examples.length) {
    lines.push('', '例子：');
    for (const example of spec.examples) lines.push(`  ticket-timeline ${example}`);
  }
  return lines.join('\n') + '\n';
}

/** 按 SPEC 解析参数：未知 flag、缺值、多余位置参数都当用法错误（退出码 2）。 */
export function parseArgs(spec, argv) {
  const byFlag = new Map(spec.flags.map((flag) => [flag.flag, flag]));
  const opts = Object.create(null);
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) { positional.push(token); continue; }
    const flag = byFlag.get(token);
    if (!flag) throw new CliError(`未知参数：${token}（用 --help 看可用参数）`, 2);
    if (flag.kind === 'bool') { opts[flag.flag] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliError(`参数 ${token} 需要一个值`, 2);
    }
    opts[flag.flag] = value;
    i += 1;
  }
  if (positional.length > spec.positionals.length) {
    throw new CliError(`参数给多了：多出「${positional[spec.positionals.length]}」（用 --help 看用法）`, 2);
  }
  return { opts, positional };
}

const needPositional = (parsed, index, label) => {
  const value = parsed.positional[index];
  if (!value) throw new CliError(`缺少位置参数 <${label}>（用 --help 看用法）`, 2);
  return value;
};

const needValue = (parsed, flag, label) => {
  const value = parsed.opts[flag];
  if (!value) throw new CliError(`缺少参数 ${flag} <${label}>（用 --help 看用法）`, 2);
  return value;
};

function readBytes(path, label) {
  if (!existsSync(path)) throw new CliError(`找不到${label}：${path}（检查路径是否写错）`);
  const buffer = readFileSync(path);
  if (buffer.length === 0) throw new CliError(`${label}是空的：${path}（0 字节）`);
  return buffer;
}

function readJsonFile(path) {
  const text = readBytes(path, 'JSON 文件').toString('utf8');
  if (!text.trim()) throw new CliError(`JSON 文件里只有空白：${path}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`不是合法 JSON：${path}\n  ${error.message}`);
  }
}

/** 文本输出的脱敏 / 还原开关。 */
function passThroughRedaction(text, opts) {
  if (opts['--unmap']) {
    const mapping = readMappingFile(opts['--unmap']);
    return unmapText(text, mapping);
  }
  return redactDocument({ text, mapOut: opts['--map-out'] ?? null }).text;
}

const colorFor = (opts) => !(opts['--no-color'] || process.env.NO_COLOR);

const applyLimit = (entries, opts) => {
  const limit = opts['--limit'] === undefined ? 0 : Number(opts['--limit']);
  if (opts['--limit'] !== undefined && (!Number.isFinite(limit) || limit < 0)) {
    throw new CliError(`--limit 要一个非负整数，收到「${opts['--limit']}」`, 2);
  }
  return limit > 0 ? entries.slice(0, limit) : entries;
};

/**
 * 机读出口的脱敏必须**结构化**做：逐个字符串值处理，绝不拿正则去扫序列化后的 JSON 文本。
 * （踩过的坑：路径正则会把 `\"file_path\": \"C:\\...\"` 里的转义引号一起吃掉，产物变成非法 JSON。）
 * 同一份 payload 共用一个 redactor，保证同一真值在任意字段都拿到同一个假名。
 */
const redactDeep = (value, redact, mapping) => {
  if (typeof value === 'string') return mapping ? unmapText(value, mapping) : redact(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact, mapping));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, redact, mapping);
    return out;
  }
  return value;
};

const jsonOut = (io, payload, opts = {}) => {
  let safe;
  if (opts['--unmap']) {
    safe = redactDeep(payload, null, readMappingFile(opts['--unmap']));
  } else {
    const redactor = createRedactor({});
    safe = redactDeep(payload, (text) => redactor.redactText(text));
    // 顺手落对照表：复用 redactDocument 的写盘分支（空文本也要过一次，才能导出 entries）
    if (opts['--map-out']) redactDocument({ text: '', redactor, mapOut: opts['--map-out'] });
  }
  io.stdout(`${JSON.stringify(safe, null, 2)}\n`);
};

/** session 子命令的文本视图（会话事件没有 Ticket 阶段可讲，只按类型分行）。 */
function renderSessionText(entries, { color, width = 100, omitted: omittedOption = 0 } = {}) {
  const omitted = omittedOption;
  const span = entries.length ? entries[entries.length - 1].atMs - entries[0].atMs : 0;
  const count = (test) => entries.filter(test).length;
  const head = [
    `会话时间线：${entries.length} 条事件，跨度 ${formatDuration(span)}`,
    `用户 ${count((e) => e.subject === 'person')} 次   助手 ${count((e) => e.subject === 'assistant')} 次   工具 ${count((e) => String(e.subject).startsWith('tool'))} 次`,
    ...(omitted ? [`（已折叠 ${omitted} 条低信息事件：请求头 / 权限 / 步进 / 空工具结果）`] : []),
    '',
  ];

  const body = entries.map((entry) => {
    const clock = new Date(entry.atMs).toISOString().slice(11, 23);
    const kind = entry.kind.padEnd(20).slice(0, 20);
    const summary = entry.summary.length > width - 34 ? entry.summary.slice(0, width - 35) + '…' : entry.summary;
    const code = entry.subject === 'person' ? '93' : entry.subject === 'assistant' ? '36' : entry.subject.startsWith('tool') ? '35' : '90';
    const kindPainted = color ? `\u001b[${code}m${kind}\u001b[0m` : kind;
    return `${clock} ${kindPainted} ${summary}`;
  });

  const tail = ['', '# 提示：--limit N 只看前 N 条；要看被折叠的原始事件，请直接解压 .zstd 后 grep。'];
  return [...head, ...body, ...tail].join('\n') + '\n';
}

async function cmdTicket(parsed, io) {
  const path = needPositional(parsed, 0, 'fixture.json');
  const doc = readJsonFile(path);
  if (!Array.isArray(doc?.events)) {
    throw new CliError(`这份 JSON 里没有 events 数组：${path}（ticket 子命令要 Ticket 事件流，不是时间线 JSON）`);
  }
  if (doc.events.length === 0) throw new CliError(`events 是空数组，没有可展示的事件：${path}`);

  let ticketParsed;
  try {
    ticketParsed = parseTicketStream(doc, { source: path });
  } catch (error) {
    throw new CliError(`Ticket 事件流不符合格式：${error.message}`);
  }

  const entries = applyLimit(mergeTimelines(projectTicket(ticketParsed)), parsed.opts);
  const lastEvent = ticketParsed.events.at(-1);
  const meta = {
    ticketId: ticketParsed.ticket?.id ?? '(unknown)',
    title: ticketParsed.ticket?.title ?? '(无标题)',
    currentStage: stageAt(ticketParsed, lastEvent.at).id,
    eventCount: ticketParsed.events.length,
    entryCount: entries.length,
    spanMs: lastEvent.atMs - ticketParsed.events[0].atMs,
  };

  if (parsed.opts['--json']) {
    jsonOut(io, {
      ok: true,
      command: 'ticket',
      frameCount: 0, // Ticket 事件流不是 zstd，没有帧
      meta: { ...meta, spanText: formatDuration(meta.spanMs), source: path, kind: 'ticket' },
      entries,
      events: ticketParsed.events,
    }, parsed.opts);
    return 0;
  }

  const text = renderTextTimeline(ticketParsed, { color: colorFor(parsed.opts) });
  io.stdout(passThroughRedaction(text, parsed.opts));
  return 0;
}

async function cmdSession(parsed, io) {
  const path = needPositional(parsed, 0, 'file.zstd');
  const buffer = readBytes(path, 'zstd 文件');
  let decoded;
  try {
    decoded = decodeZstd(buffer);
  } catch (error) {
    throw new CliError(`这个文件不像多帧 zstd 会话日志：${path}\n  ${error.message}`);
  }

  const events = [];
  for (const line of decoded.text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event.type === 'string' && Number.isFinite(event.time)) events.push(event);
    } catch { /* 非 JSON 行（比如日志尾巴）跳过 */ }
  }
  if (events.length === 0) {
    throw new CliError(
      `这个会话日志里没有可展示的事件：${path}`
      + `（解出 ${decoded.summary.frameCount} 帧 / ${decoded.summary.lines} 行，但没有含 type 与 time 的 JSON 事件）`,
    );
  }

  const only = parsed.opts['--only'];
  if (only !== undefined && !ONLY_KINDS[only]) {
    throw new CliError(`--only 只认 ${Object.keys(ONLY_KINDS).join(' / ')}，收到「${only}」`, 2);
  }
  const projected = projectSession(events, { sessionId: path, includeLowSignal: Boolean(parsed.opts['--raw']) });
  const omittedLowSignal = projected.omittedLowSignal ?? 0;
  const kept = only ? projected.filter(ONLY_KINDS[only]) : projected;
  const entries = applyLimit(mergeTimelines(kept), parsed.opts);
  const meta = {
    sessionId: path,
    kind: 'session',
    eventCount: events.length,
    entryCount: entries.length,
    byType: events.reduce((acc, event) => {
      acc[event.type] = (acc[event.type] ?? 0) + 1;
      return acc;
    }, {}),
    spanMs: events.at(-1).time - events[0].time,
  };

  if (parsed.opts['--json']) {
    jsonOut(io, {
      ok: true,
      command: 'session',
      frameCount: decoded.summary.frameCount,
      meta: { ...meta, spanText: formatDuration(meta.spanMs), source: path, decode: decoded.summary },
      entries,
      events,
    }, parsed.opts);
    return 0;
  }

  io.stdout(passThroughRedaction(renderSessionText(entries, { color: colorFor(parsed.opts), omitted: omittedLowSignal }), parsed.opts));
  return 0;
}

async function cmdRender(parsed, io) {
  const inPath = needValue(parsed, '--in', 'FILE');
  const outPath = needValue(parsed, '--out', 'FILE');
  const doc = readJsonFile(inPath);
  if (!Array.isArray(doc?.events) || doc.events.length === 0) {
    throw new CliError(
      `这份 JSON 里没有 events，没法渲染：${inPath}\n`
      + '  用 `ticket <fixture.json> --json > x.json` 或 `session <file.zstd> --json > x.json` 生成',
    );
  }

  const pseudoParsed = {
    ticket: { id: doc.meta?.ticketId ?? '(unknown)', title: doc.meta?.title ?? '(无标题)' },
    events: doc.events,
  };
  const html = passThroughRedaction(renderHtmlTimeline(pseudoParsed), parsed.opts);
  try {
    writeFileSync(outPath, html, 'utf8');
  } catch (error) {
    throw new CliError(`写不了输出文件：${outPath}\n  ${error.message}`);
  }
  io.stdout(`已写出 ${outPath}（${Buffer.byteLength(html, 'utf8')} 字节，${doc.events.length} 条事件）\n`);
  return 0;
}

/** --only 可选值 → 条目过滤器。 */
const ONLY_KINDS = {
  person: (entry) => entry.subject === 'person',
  assistant: (entry) => entry.subject === 'assistant',
  tool: (entry) => String(entry.subject).startsWith('tool'),
  turn: (entry) => entry.kind === 'turn/start' || entry.kind === 'turn/end',
};

/** `unmap`：把含假名的文本用对照表还原（--unmap 的命令行闭环）。 */
async function cmdUnmap(parsed, io) {
  const inPath = needValue(parsed, '--in', 'FILE');
  const mapPath = needValue(parsed, '--map', 'FILE');
  if (!existsSync(inPath)) throw new CliError(`找不到输入文件：${inPath}`);
  if (!existsSync(mapPath)) throw new CliError(`找不到对照表：${mapPath}`);

  let text;
  try {
    text = readFileSync(inPath, 'utf8');
  } catch (error) {
    throw new CliError(`读不了输入文件：${inPath}\n  ${error.message}`);
  }
  const mapping = readMappingFile(mapPath);
  const restored = unmapText(text, mapping);
  const outPath = parsed.opts['--out'] ?? null;
  if (!outPath) {
    io.stdout(restored);
    return 0;
  }
  writeFileSync(outPath, restored, 'utf8');
  const count = Array.isArray(mapping?.entries) ? mapping.entries.length : 0;
  io.stdout(`已还原 ${outPath}（${Buffer.byteLength(restored, 'utf8')} 字节，对照表 ${count} 条）\n`);
  return 0;
}

const HANDLERS = { ticket: cmdTicket, session: cmdSession, render: cmdRender, unmap: cmdUnmap };

/**
 * 执行一次 CLI。返回退出码（bin 里赋给 process.exitCode）。
 * @param {string[]} argv 不含 node 与脚本路径
 * @param {{stdout:(s:string)=>void, stderr:(s:string)=>void}} [io]
 */
export async function run(argv, io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}) {
  try {
    const [name, ...rest] = argv;
    if (!name || name === '--help' || name === 'help') {
      io.stdout(MAIN_USAGE);
      return 0;
    }
    const spec = COMMANDS[name];
    if (!spec) {
      throw new CliError(`不认识的子命令：${name}（可用：${Object.keys(COMMANDS).join(' / ')}）`, 2);
    }
    const parsed = parseArgs(spec, rest);
    if (parsed.opts['--help']) {
      io.stdout(renderHelp(name));
      return 0;
    }
    return await HANDLERS[name](parsed, io);
  } catch (error) {
    const isExpected = error instanceof CliError;
    io.stderr(`错误：${isExpected ? error.message : (error?.message ?? String(error))}\n`);
    if (!isExpected) {
      io.stderr('（这是内部错误。设置 TT_DEBUG=1 重跑可以看到技术细节。）\n');
      if (process.env.TT_DEBUG) io.stderr(`\n${error?.stack ?? ''}\n`);
    }
    return isExpected ? error.exitCode : 1;
  }
}

export { MAIN_USAGE, COMMON_FLAGS, createRedactor };

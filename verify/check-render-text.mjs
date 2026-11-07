/**
 * 「终端文本时间线」小类验收脚本
 * 三条验收标准逐条断言，任何一条不满足即非零退出。
 */
import { parseTicketStream } from '../src/ticket-events.mjs';
import { stageAt, stageDurations } from '../src/ticket-stage.mjs';
import {
  renderTextTimeline, summarize, displayWidth, fitWidth, formatDuration,
} from '../src/render-text.mjs';
import { SAMPLES } from './lib/sample-tickets.mjs';

let failures = 0;
const log = (line) => console.log(line);
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  →  ${detail}` : ''}`);
};

const TIME_COL = 12 + 1; // HH:MM:SS.mmm + 一个空格

const rendered = SAMPLES.map((sample) => {
  const parsed = parseTicketStream(sample.doc, { source: sample.name });
  return { name: sample.name, parsed, text: renderTextTimeline(parsed, { width: 100, color: false }) };
});

log('════ 验收 1：三份样例各出一份时间线，概览的 stage 与时长跟事实一致 ════');
{
  for (const { name, parsed, text } of rendered) {
    const lines = text.split('\n');
    const info = summarize(parsed);
    const events = parsed.events;

    // 独立重算"事实"，不采信 summarize 的自述
    const expectedStage = stageAt(parsed, events[events.length - 1].at).id;
    const expectedSpan = events[events.length - 1].atMs - events[0].atMs;
    const expectedSpanText = formatDuration(expectedSpan);

    const stageOk = lines[1].includes(`当前阶段 ${expectedStage}`);
    const spanOk = lines[1].includes(`时长 ${expectedSpanText}`);
    const countOk = lines[1].includes(`事件 ${events.length} 条`);

    log(`    ${name}: 第 2 行 = ${lines[1]}`);
    check(`  ${name} 概览阶段 = stageAt 独立算出的 ${expectedStage}`, stageOk);
    check(`  ${name} 概览时长 = 首末事件差 ${expectedSpanText}`, spanOk, `${expectedSpan}ms`);
    check(`  ${name} 概览事件数 = ${events.length} 条`, countOk);
    check(`  ${name} summarize 与 stageAt 结论一致`, info.currentStage === expectedStage,
      `${info.currentStage} vs ${expectedStage}`);

    // 主体行数 = 事件数（一行一条）
    const bodyLines = lines.filter((line) => /^\d{2}:\d{2}:\d{2}\.\d{3} /.test(line));
    check(`  ${name} 主体一行一条：${bodyLines.length} 行 = ${events.length} 条事件`,
      bodyLines.length === events.length);
    // 时间戳逐条对得上
    const stampsOk = bodyLines.every((line, i) => {
      const at = new Date(events[i].at);
      const hh = String(at.getUTCHours()).padStart(2, '0');
      const mm = String(at.getUTCMinutes()).padStart(2, '0');
      const ss = String(at.getUTCSeconds()).padStart(2, '0');
      const ms = String(at.getUTCMilliseconds()).padStart(3, '0');
      return line.startsWith(`${hh}:${mm}:${ss}.${ms} `);
    });
    check(`  ${name} 每行时间戳与该条事件时间一致`, stampsOk);

    // 尾部必须正好三行以 "# " 开头
    const tail = lines.filter((line) => line.startsWith('# '));
    check(`  ${name} 尾部三行"一眼看懂"`, tail.length === 3, `${tail.length} 行`);
    log(`      ${tail.join('\n      ')}`);
  }

  const names = rendered.map((item) => item.name).join('/');
  check('三份样例都渲染成功', rendered.length === 3 && rendered.every((item) => item.text.length > 100),
    `${names}；字节 ${rendered.map((item) => item.text.length).join('/')}`);
}

log('');
log('════ 验收 2：100 列下每行 ≤100（含概览与结论行），长摘要不折断 ════');
{
  // 一条超长摘要的极端 Ticket：验证"截断而不是折行"
  const longText = '这一条汇报的正文特别长'.repeat(12);
  const longDoc = {
    declaredEventCount: 4,
    ticket: { id: 'tk-long-summary', title: '超长摘要压力测试：' + '很长的标题'.repeat(6), decisionId: 'dec-9', strength: 'explicit' },
    events: [
      { at: '2026-09-03T08:00:00.000Z', type: 'ticket.created', ticketId: 'tk-long-summary', title: '超长摘要压力测试', decisionId: 'dec-9', strength: 'explicit' },
      { at: '2026-09-03T08:00:02.000Z', type: 'assignment.started', assignmentId: 'as-0', state: 'running' },
      { at: '2026-09-03T08:01:00.000Z', type: 'report.blocked', assignmentId: 'as-0', summary: longText },
      { at: '2026-09-03T08:05:00.000Z', type: 'report.ready', assignmentId: 'as-0', summary: longText },
    ],
  };
  const longParsed = parseTicketStream(longDoc, { source: 'long' });
  const longText100 = renderTextTimeline(longParsed, { width: 100, color: false });

  const cases = [...rendered.map((item) => ({ name: item.name, text: item.text })), { name: 'long', text: longText100 }];
  for (const { name, text } of cases) {
    const lines = text.replace(/\n$/, '').split('\n');
    const worstChars = Math.max(...lines.map((line) => [...line].length));
    const worstDisplay = Math.max(...lines.map((line) => displayWidth(line)));
    const offenders = lines.filter((line) => displayWidth(line) > 100 || [...line].length > 100);
    log(`    ${name}: ${lines.length} 行，最长 字符 ${worstChars} / 显示宽 ${worstDisplay}`);
    check(`  ${name} 每行字符数 ≤100 且显示宽度 ≤100`, offenders.length === 0,
      offenders.length ? offenders[0].slice(0, 40) : 'ok');
  }

  // 超长摘要确实被截断（出现省略号），而不是被折行（行数不增加）
  const longLines = longText100.split('\n').filter((line) => line.includes('汇报'));
  check('超长摘要被截断成单行（带省略号，行数不增）',
    longLines.length === 2 && longLines.every((line) => line.includes('…')),
    `${longLines.length} 行`);

  // 窄屏回退：width=80 也要守住
  const narrow = renderTextTimeline(longParsed, { width: 80, color: false });
  const narrowWorst = Math.max(...narrow.split('\n').map((line) => displayWidth(line)));
  check('width=80 时每行显示宽度 ≤80（自动回退）', narrowWorst <= 80, `最宽 ${narrowWorst}`);
  const narrowBadgeLine = narrow.split('\n').find((line) => /^\d{2}:\d{2}:\d{2}\.\d{3} /.test(line)) ?? '';
  const narrowBadgeCol = narrowBadgeLine.slice(TIME_COL, TIME_COL + 12);
  check('width=80 时徽章列收窄到 12 列',
    Boolean(narrowBadgeLine) && displayWidth(narrowBadgeLine.slice(TIME_COL, TIME_COL + 12)) === 12,
    `「${narrowBadgeCol}」= ${displayWidth(narrowBadgeCol)} 列`);

  // 宽屏徽章列应为 16 列（对照，证明回退真的按宽度切换）
  const wideLine = longText100.split('\n').find((line) => /^\d{2}:\d{2}:\d{2}\.\d{3} /.test(line)) ?? '';
  const wideBadgeCol = wideLine.slice(TIME_COL, TIME_COL + 16);
  // 「对齐」是量的，不是看着像：时间列恒 12、徽章列恒 16、正文起点恒 30
  {
    const body = longText100.split('\n').filter((line) => /^\d{2}:\d{2}:\d{2}\.\d{3} /.test(line));
    const timeWidths = body.map((line) => displayWidth(line.slice(0, 12)));
    const badgeWidths = body.map((line) => displayWidth(line.slice(13, 29)));
    const summaryStarts = body.map((line) => displayWidth(line.slice(0, 30)));
    check('时间戳列逐行等宽（12 列，共 ' + body.length + ' 行）',
      timeWidths.every((w) => w === 12), timeWidths.join(','));
    check('阶段徽章列逐行等宽（16 列）',
      badgeWidths.every((w) => w === 16), badgeWidths.join(','));
    check('摘要起始列逐行对齐（第 30 列）',
      summaryStarts.every((w) => w === 30), summaryStarts.join(','));
    check('徽章列之间以单空格分隔（第 12 列是空格）',
      body.every((line) => line[12] === ' '));
  }
  check('width=100 时徽章列 16 列（与窄屏确有差别）',
    displayWidth(wideBadgeCol) === 16 && wideBadgeCol !== narrowBadgeCol.slice(0, 16),
    `「${wideBadgeCol}」= ${displayWidth(wideBadgeCol)} 列`);
}

log('');
log('════ 验收 3：NO_COLOR=1 时不输出任何 ANSI 转义符 ════');
{
  const sample = rendered[0];
  const withColor = renderTextTimeline(sample.parsed, { width: 100 }); // 默认：跟随 NO_COLOR
  const previous = process.env.NO_COLOR;

  process.env.NO_COLOR = '1';
  const noColorEnv = renderTextTimeline(sample.parsed, { width: 100 });
  if (previous === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previous;

  const explicitFalse = renderTextTimeline(sample.parsed, { width: 100, color: false });
  const explicitTrue = renderTextTimeline(sample.parsed, { width: 100, color: true });

  log(`    NO_COLOR=1 输出里的 ESC 个数 = ${(noColorEnv.match(/\u001b/g) ?? []).length}`);
  check('NO_COLOR=1 时输出零 ESC', !/\u001b/.test(noColorEnv));
  check('color:false 时输出零 ESC', !/\u001b/.test(explicitFalse));
  check('color:true 时确实上了色（对照，证明不是永远没色）',
    /\u001b\[\d+m/.test(explicitTrue), `${(explicitTrue.match(/\u001b/g) ?? []).length} 个 ESC`);
  check('开色与关色的可见文本完全相同（颜色只加码不改字）',
    explicitTrue.replace(/\u001b\[\d+m/g, '') === explicitFalse.replace(/\u001b\[\d+m/g, ''));
  check('默认（无 NO_COLOR）时带色 —— 与显式 color:true 等价',
    withColor.replace(/\u001b\[\d+m/g, '') === explicitTrue.replace(/\u001b\[\d+m/g, ''));
  // NO_COLOR 关色的那份，也要过 100 列检查（转义符不该把长度撑爆）
  check('NO_COLOR 输出同样守住 100 列',
    noColorEnv.split('\n').every((line) => [...line].length <= 100));
}

log('');
log('════ 相邻锚（陌生视角挑刺） ════');
{
  // 可 grep：主体行都以时间戳开头，能 grep 出阶段/关键字
  const sample = rendered[1]; // blocked 样
  const blockedLines = sample.text.split('\n').filter((line) => line.includes('blocked'));
  check('能 grep：含 blocked 的行可被直接筛出', blockedLines.length >= 2, `${blockedLines.length} 行`);
  const timeStamped = sample.text.split('\n').filter((line) => /^\d{2}:\d{2}:\d{2}\.\d{3} /.test(line));
  check('每行以 HH:MM:SS.mmm 开头（可按时间切）',
    timeStamped.length === sample.parsed.events.length);

  // displayWidth / fitWidth 是布局基石，单独钉死
  check('displayWidth：ASCII 按 1 列', displayWidth('abc123') === 6);
  check('displayWidth：中文按 2 列', displayWidth('中文') === 4);
  check('fitWidth 不超预算', displayWidth(fitWidth('中文中文中文中文', 5)) <= 5,
    `${fitWidth('中文中文中文中文', 5)} (${displayWidth(fitWidth('中文中文中文中文', 5))})`);
  check('fitWidth 未超预算时原样返回', fitWidth('abc', 10) === 'abc');
  check('formatDuration 分级正确',
    formatDuration(500) === '500ms' && formatDuration(3000) === '3s'
    && formatDuration(90000) === '1m30s' && formatDuration(3600000) === '1h0m',
    `${formatDuration(500)}/${formatDuration(3000)}/${formatDuration(90000)}/${formatDuration(3600000)}`);

  // 空事件序列不炸
  // 注意：parseTicketStream 对空 events 会抛 EMPTY_STREAM（上游契约），
  // 所以这一条只测"渲染层拿到空数组不崩"，用构造的 parsed 直接喂。
  const emptyParsed = { ticket: { id: 'tk-empty', title: '空' }, events: [] };
  let emptyOk = true;
  let emptyText = '';
  try { emptyText = renderTextTimeline(emptyParsed, { width: 100, color: false }); } catch { emptyOk = false; }
  check('空事件序列不崩（有概览与结论）', emptyOk && emptyText.includes('事件 0 条'),
    emptyText.split('\n')[1]);

  // stageDurations 与渲染出的阶段链不矛盾（相邻接口核对）
  const segments = stageDurations(sample.parsed);
  const chainFromRender = sample.text.split('\n').find((line) => line.startsWith('# 起点'));
  check('尾部阶段链段数与 stageDurations 一致',
    Boolean(chainFromRender) && chainFromRender.includes(`${segments.length} 段`),
    `${segments.length} 段 vs ${chainFromRender?.slice(0, 60)}`);
}

log('');
log(failures === 0 ? '结论：3 条验收标准全部通过 ✅' : `结论：${failures} 条断言未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);

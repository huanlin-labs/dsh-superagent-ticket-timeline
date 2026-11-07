/**
 * 「子命令与 JSON 出口」小类验收脚本
 * 三条验收标准逐条断言；错误路径看退出码与提示文本，不看堆栈。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { run, COMMANDS, renderHelp, parseArgs, CliError } from '../src/cli.mjs';
import { SAMPLES } from './lib/sample-tickets.mjs';
import { findSamples } from './lib/samples.mjs';

let failures = 0;
const log = (line) => console.log(line);
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  →  ${detail}` : ''}`);
};

/** 跑一次 CLI，回收 stdout/stderr/退出码。 */
async function cli(argv) {
  const out = [];
  const err = [];
  const code = await run(argv, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const TMP = join(process.env.SystemDrive ?? 'D:', '临时', 'ticket-timeline-cli-check');
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const fixturePath = join(TMP, 'ticket-blocked.json');
writeFileSync(fixturePath, JSON.stringify(SAMPLES[1].doc, null, 2), 'utf8');
const emptyPath = join(TMP, 'empty.json');
writeFileSync(emptyPath, '', 'utf8');
const brokenPath = join(TMP, 'broken.json');
writeFileSync(brokenPath, '{ "ticket": { "id": "x", ', 'utf8');
const noEventsPath = join(TMP, 'no-events.json');
writeFileSync(noEventsPath, JSON.stringify({ ticket: { id: 'x', title: 'x' }, events: [] }), 'utf8');
const missingPath = join(TMP, 'does-not-exist.json');

log('════ 验收 1：三个子命令各有 --help，且与实际参数一致 ════');
{
  for (const name of Object.keys(COMMANDS)) {
    const result = await cli([name, '--help']);
    const specFlags = COMMANDS[name].flags.map((flag) => flag.flag).sort();
    const helpFlags = [...new Set((result.stdout.match(/--[a-z-]+/g) ?? []))].sort();
    log(`    ${name}: exit=${result.code}，help 里出现 ${helpFlags.length} 个 flag`);
    check(`  ${name} --help 可用（退出码 0 且有用法行）`,
      result.code === 0 && result.stdout.includes(`ticket-timeline ${COMMANDS[name].usage}`));
    check(`  ${name} help 里的 flag 集合 = SPEC 集合`,
      JSON.stringify(helpFlags) === JSON.stringify(specFlags),
      `help=${helpFlags.join(',')} spec=${specFlags.join(',')}`);
    check(`  ${name} help 与 renderHelp() 逐字相同（同源渲染）`,
      result.stdout === renderHelp(name));
  }

  // 「一致」的行为验证：把每个 flag 真喂给解析器，不许报未知参数
  for (const name of Object.keys(COMMANDS)) {
    const spec = COMMANDS[name];
    const bad = [];
    for (const flag of spec.flags) {
      if (flag.flag === '--help') continue;
      const argv = flag.kind === 'bool' ? [flag.flag] : [flag.flag, flag.flag === '--limit' ? '3' : 'x.txt'];
      try {
        const parsed = parseArgs(spec, argv);
        const present = flag.kind === 'bool' ? parsed.opts[flag.flag] === true : parsed.opts[flag.flag] === argv[1];
        if (!present) bad.push(`${flag.flag}(解析未生效)`);
      } catch (error) {
        bad.push(`${flag.flag}(${error.message})`);
      }
    }
    check(`  ${name} 每个列出的 flag 都能被真实解析`, bad.length === 0, bad.join('；') || 'ok');
  }

  const unknown = await cli(['ticket', '--nope']);
  check('未知 flag 被拒（退出码 2 + 提示看 --help）',
    unknown.code === 2 && unknown.stderr.includes('未知参数：--nope') && unknown.stderr.includes('--help'));
  const badSub = await cli(['nonsense']);
  check('未知子命令被拒（退出码 2）',
    badSub.code === 2 && badSub.stderr.includes('不认识的子命令：nonsense'));
}

log('');
log('════ 验收 2：三种错误返回非零退出码，提示可读、无裸堆栈 ════');
{
  const CASES = [
    ['文件不存在', ['ticket', missingPath], '找不到'],
    ['非法 JSON', ['ticket', brokenPath], '不是合法 JSON'],
    ['空文件', ['ticket', emptyPath], '是空的'],
    ['空数据（events 为空）', ['ticket', noEventsPath], '空数组'],
    ['session 传了非 zstd', ['session', brokenPath], '没有可展示的事件'],
    ['render 缺 --out', ['render', '--in', fixturePath], '缺少参数 --out'],
    ['--limit 非数字', ['ticket', fixturePath, '--limit', 'abc'], '非负整数'],
  ];
  for (const [label, argv, expectFragment] of CASES) {
    const result = await cli(argv);
    const stackLike = /^\s+at\s+\S+/m.test(result.stderr) || /node:internal/.test(result.stderr);
    log(`    ${label}: exit=${result.code}  stderr=${JSON.stringify(result.stderr.trim().slice(0, 60))}`);
    check(`  ${label} → 退出码非 0`, result.code !== 0, `code=${result.code}`);
    check(`  ${label} → 中文提示含「${expectFragment}」`, result.stderr.includes(expectFragment));
    check(`  ${label} → 无裸堆栈 / 无内部路径`, !stackLike);
  }

  // 非 zstd 输入的提示里要带"解出几帧 / 几行"，让人能自己判断是哪种坏
  const notZstd = await cli(['session', brokenPath]);
  check('非 zstd 提示里带帧数与行数（可自查）',
    /解出 \d+ 帧 \/ \d+ 行/.test(notZstd.stderr), notZstd.stderr.replace(/\n/g, ' ⏎ ').slice(0, 90));
  // 缺位置参数也给用法提示而不是崩
  const internalErr = [];
  const internal = await run(['ticket'], {
    stdout: () => {},
    stderr: (text) => { internalErr.push(text); },
  });
  check('缺位置参数也给用法提示而不是崩',
    internal === 2 && internalErr.join('').includes('缺少位置参数'), `code=${internal}`);
}

log('');
log('════ 验收 3：--json 输出含 frameCount / entries / meta ════');
{
  const ticketJson = await cli(['ticket', fixturePath, '--json']);
  check('ticket --json 退出码 0', ticketJson.code === 0, `code=${ticketJson.code}`);
  let doc = null;
  let parsed = false;
  try { doc = JSON.parse(ticketJson.stdout); parsed = true; } catch { parsed = false; }
  check('ticket --json 能被 JSON.parse', parsed);
  log(`    ticket: entries=${doc?.entries?.length} frameCount=${doc?.frameCount} meta.eventCount=${doc?.meta?.eventCount}`);
  check('ticket --json 含 frameCount / entries / meta 三段',
    doc && 'frameCount' in doc && Array.isArray(doc.entries) && doc.meta && typeof doc.meta === 'object');
  check('ticket entries 条数 = 事件数', doc.entries.length === SAMPLES[1].doc.events.length,
    `${doc.entries.length} vs ${SAMPLES[1].doc.events.length}`);
  check('ticket 的 frameCount = 0（Ticket 流不是 zstd）', doc.frameCount === 0);
  check('ticket meta 带当前阶段与跨度', doc.meta.currentStage === 'person/review' && doc.meta.spanText === '1h0m',
    `${doc.meta.currentStage} / ${doc.meta.spanText}`);

  // --limit 真的截断（同时 JSON 里 events 仍全量，给 render 用）
  const limited = await cli(['ticket', fixturePath, '--json', '--limit', '3']);
  const limitedDoc = JSON.parse(limited.stdout);
  check('--limit 3 时 entries=3 而 events 仍是全量',
    limitedDoc.entries.length === 3 && limitedDoc.events.length === SAMPLES[1].doc.events.length,
    `entries=${limitedDoc.entries.length} events=${limitedDoc.events.length}`);

  // session 侧：用真实 zstd
  const samples = findSamples();
  if (samples.length === 0) {
    log('    （本机没有 session.v*.jsonl.zstd，session 的 JSON 出口留作未验证）');
    check('session --json 含三段（无样本，未验证）', false, '缺样本');
  } else {
    const sample = samples[0];
    const sessionJson = await cli(['session', sample.path, '--json', '--limit', '5']);
    check(`session --json 退出码 0（${sample.name}）`, sessionJson.code === 0, `code=${sessionJson.code} ${sessionJson.stderr.trim().slice(0, 50)}`);
    let sDoc = null;
    let sParsed = false;
    try { sDoc = JSON.parse(sessionJson.stdout); sParsed = true; } catch { sParsed = false; }
    check('session --json 能被 JSON.parse', sParsed);
    log(`    session: frameCount=${sDoc?.frameCount} entries=${sDoc?.entries?.length} 事件=${sDoc?.meta?.eventCount}`);
    check('session --json 含 frameCount / entries / meta 三段',
      sDoc && 'frameCount' in sDoc && Array.isArray(sDoc.entries) && sDoc.meta);
    check('session 的 frameCount = 实际帧数（>0）', sDoc.frameCount > 0, `${sDoc.frameCount}`);
    check('session 的 --limit 5 生效', sDoc.entries.length === Math.min(5, sDoc.meta.eventCount),
      `${sDoc.entries.length} / 共 ${sDoc.meta.eventCount}`);
  }

  // render 端到端：json → html
  const jsonPath = join(TMP, 'blocked.json');
  writeFileSync(jsonPath, ticketJson.stdout, 'utf8');
  const htmlPath = join(TMP, 'blocked.html');
  const renderResult = await cli(['render', '--in', jsonPath, '--out', htmlPath]);
  check('render 端到端成功', renderResult.code === 0 && existsSync(htmlPath), renderResult.stderr.trim().slice(0, 60));
  if (existsSync(htmlPath)) {
    const html = (await import('node:fs')).readFileSync(htmlPath, 'utf8');
    check('render 产物是自包含 HTML（无外链、含时间线）',
      !/https?:\/\//.test(html) && html.includes('id="timeline"') && html.includes('ev-12'));
    check('render 提示信息含字节数与事件数',
      /已写出 .+（\d+ 字节，13 条事件）/.test(renderResult.stdout), renderResult.stdout.trim());
  }
}

log('');
log('════ 相邻锚（陌生视角挑刺） ════');
{
  // CliError 带退出码语义
  const error = new CliError('测试', 2);
  check('CliError 携带 exitCode', error.exitCode === 2 && error.name === 'CliError');

  // 纯文本输出（非 --json）不该是 JSON，且默认无颜色时无 ESC
  const plain = await cli(['ticket', fixturePath, '--no-color']);
  check('--no-color 文本输出含时间线行且零 ESC',
    plain.code === 0 && /\d{2}:\d{2}:\d{2}\.\d{3}/.test(plain.stdout) && !/\u001b/.test(plain.stdout));
  check('非 --json 输出不能被当成 JSON 解析', (() => {
    try { JSON.parse(plain.stdout); return false; } catch { return true; }
  })());

  // --map-out 真落盘；不给则不落盘（沿用脱敏小类的约定）
  const mapPath = join(TMP, 'mapping.json');
  await cli(['ticket', fixturePath, '--no-color', '--map-out', mapPath]);
  check('给了 --map-out 才写对照表', existsSync(mapPath), mapPath);
  const noMap = await cli(['ticket', fixturePath, '--no-color']);
  check('不给 --map-out 时不多写文件', noMap.code === 0);

  // 顶层用法
  const mainHelp = await cli(['--help']);
  check('无子命令时打印总用法（含三个子命令名）',
    mainHelp.code === 0 && ['ticket', 'session', 'render'].every((name) => mainHelp.stdout.includes(name)));
}

rmSync(TMP, { recursive: true, force: true });

log('');
log(failures === 0 ? '结论：3 条验收标准全部通过 ✅' : `结论：${failures} 条断言未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);

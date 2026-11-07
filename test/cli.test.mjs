/**
 * 第六块：CLI 端到端（真 spawn 子进程，走真实退出码）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/ticket-timeline.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../fixtures/ticket-blocked-retry.json', import.meta.url));

/** 真起一个 node 子进程跑 CLI。 */
function cli(args, options = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    ...options,
  });
  assert.equal(result.error, undefined, `子进程不该起不来：${result.error?.message}`);
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('端到端：三个子命令的 --help 都以 0 退出', () => {
  for (const name of ['ticket', 'session', 'render']) {
    const { code, stdout } = cli([name, '--help']);
    assert.equal(code, 0, `${name} --help 应退出 0`);
    assert.ok(stdout.includes(`ticket-timeline ${name}`), `${name} 的 help 应带用法行`);
  }
});

test('端到端：ticket --json 退出 0，stdout 可 JSON.parse 且含三段', () => {
  const { code, stdout } = cli(['ticket', FIXTURE, '--json']);
  assert.equal(code, 0);
  const doc = JSON.parse(stdout);
  assert.ok('frameCount' in doc, '缺 frameCount');
  assert.ok(Array.isArray(doc.entries), 'entries 必须是数组');
  assert.equal(typeof doc.meta, 'object');
  assert.equal(doc.entries.length, 10);
});

test('端到端：文件不存在 → 非零退出、中文提示、无裸堆栈', () => {
  const { code, stderr } = cli(['ticket', 'nope-not-here.json']);
  assert.notEqual(code, 0);
  assert.ok(stderr.includes('找不到'), `应给出找不到文件的提示，实际：${stderr}`);
  assert.equal(/^\s+at\s+\S+/m.test(stderr), false, '不该吐堆栈');
});

test('端到端：未知子命令 → 退出码 2', () => {
  const { code, stderr } = cli(['nonsense']);
  assert.equal(code, 2);
  assert.ok(stderr.includes('不认识的子命令'));
});

test('端到端：render 把 JSON 变成自包含 HTML 文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-cli-test-'));
  try {
    const jsonPath = join(dir, 'in.json');
    const htmlPath = join(dir, 'out.html');
    const first = cli(['ticket', FIXTURE, '--json']);
    writeFileSync(jsonPath, first.stdout, 'utf8');

    const rendered = cli(['render', '--in', jsonPath, '--out', htmlPath]);
    assert.equal(rendered.code, 0, rendered.stderr);
    assert.ok(existsSync(htmlPath), 'HTML 应被写出来');

    const html = readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('id="timeline"'), '应含时间线容器');
    assert.equal(/https?:\/\//.test(html), false, '产物不许有外链');
    assert.ok(rendered.stdout.includes('10 条事件'), `提示应报条数，实际：${rendered.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('端到端：ticket 的纯文本输出含时间线行且无 ESC（NO_COLOR=1）', () => {
  const { code, stdout } = cli(['ticket', FIXTURE], { env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(code, 0);
  assert.match(stdout, /\d{2}:\d{2}:\d{2}\.\d{3}/);
  assert.equal(stdout.includes('\u001b'), false);
});

// ── 收尾补的三项：unmap 闭环、--only、--raw ─────────────────────────
import { findSamples as findZstdSamples } from '../verify/lib/samples.mjs';

test('端到端：unmap 把脱敏文本还原回真值（--map-out → unmap 闭环）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-unmap-'));
  try {
    const mapPath = join(dir, 'm.json');
    const redacted = cli(['ticket', FIXTURE, '--no-color', '--map-out', mapPath]).stdout;
    assert.equal(redacted.includes('10.8.0.14'), false, '脱敏产物不该含真 IP');

    const inPath = join(dir, 'r.txt');
    writeFileSync(inPath, redacted, 'utf8');
    const restored = cli(['unmap', '--in', inPath, '--map', mapPath]);
    assert.equal(restored.code, 0, restored.stderr);
    assert.ok(restored.stdout.includes('10.8.0.14'), `还原后应拿回真 IP，实际：${restored.stdout.slice(0, 120)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const zstdSamples = findZstdSamples();
const zstdPath = zstdSamples.length ? zstdSamples[0].path : null;
const skipZstd = '本机没有 session.v*.jsonl.zstd 样本（脱机环境正常现象）';
const lineCount = (args) => cli(args).stdout.split('\n').length;

test('端到端：--only person 只剩人类消息（行数少于默认）', { skip: zstdPath ? false : skipZstd }, () => {
  const all = lineCount(['session', zstdPath, '--no-color']);
  const person = lineCount(['session', zstdPath, '--no-color', '--only', 'person']);
  assert.ok(person < all, `--only person ${person} 行应少于默认 ${all} 行`);
});

test('端到端：--raw 不折叠（行数多于默认）', { skip: zstdPath ? false : skipZstd }, () => {
  const all = lineCount(['session', zstdPath, '--no-color']);
  const raw = lineCount(['session', zstdPath, '--no-color', '--raw']);
  assert.ok(raw > all, `--raw ${raw} 行应多于默认 ${all} 行`);
});

test('端到端：--only 给非法值 → 退出码 2 且列出可选值', { skip: zstdPath ? false : skipZstd }, () => {
  const { code, stderr } = cli(['session', zstdPath, '--only', 'nonsense']);
  assert.equal(code, 2);
  assert.ok(stderr.includes('person'), `提示里该列出可选值，实际：${stderr.slice(0, 120)}`);
});
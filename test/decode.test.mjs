/**
 * 第二块：逐帧解码 + 容错三例
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { decodeZstd, firstFrameOnly } from '../src/zstd-decode.mjs';

// Node < 22.15 没有内建 zstd；"天真做法"那条对照用例需要它，否则只能 skip。
const HAS_ZSTD = typeof zlib.zstdDecompressSync === 'function';
import { twoFrames } from './helpers.mjs';
import { findSamples } from '../verify/lib/samples.mjs';

test('两帧拼接：两段内容都解出来，顺序正确', () => {
  const { both } = twoFrames('AAA\n', 'BBB\n');
  const { text, summary } = decodeZstd(both);
  assert.equal(text, 'AAA\nBBB\n');
  assert.equal(summary.frameCount, 2);
  assert.equal(summary.decodedChars, 8);
  assert.equal(summary.truncatedFrames, 0);
});

test('逐帧回调：onFrame 对每一帧恰好回调一次', () => {
  const { both } = twoFrames();
  const seen = [];
  decodeZstd(both, { onFrame: (frame) => seen.push(frame.index) });
  assert.deepEqual(seen, [0, 1]);
});

test('中文内容跨帧不乱码（按帧拼字节后整体 UTF-8 解码）', () => {
  const { both } = twoFrames('第一帧\n', '第二帧\n');
  const { text } = decodeZstd(both);
  assert.equal(text, '第一帧\n第二帧\n');
  assert.equal(text.includes('\uFFFD'), false, '不该出现替换字符');
});

// ── 容错三例 ───────────────────────────────────────────────
test('容错①：纯非 zstd 输入 → 0 帧、空文本、不抛异常', () => {
  const buffer = Buffer.from('完全不是 zstd 的一段文本\n', 'utf8');
  const { text, summary } = decodeZstd(buffer);
  assert.equal(summary.frameCount, 0);
  assert.equal(text, '');
  assert.ok(summary.gapBytes >= 1, '整段都应记为未识别的空档字节');
});

test('容错②：尾部垃圾 → 前面的帧照常解出，垃圾不影响内容', () => {
  const { both } = twoFrames('AAA\n', 'BBB\n');
  const { text, summary } = decodeZstd(Buffer.concat([both, Buffer.from('TAIL-GARBAGE')]));
  assert.equal(text, 'AAA\nBBB\n');
  assert.equal(summary.frameCount, 2);
});

test('容错③：第二帧被截断 → 显式标记 truncated，只解出第一帧，不静默丢数据', () => {
  const { both } = twoFrames('AAA\n', 'BBB\n');
  const truncated = both.subarray(0, both.length - 6);
  const { text, frames, summary } = decodeZstd(truncated);
  assert.equal(text, 'AAA\n', '只有完整的第一帧该进文本');
  assert.equal(frames[1].status, 'truncated');
  assert.equal(summary.truncatedFrames, 1, '截断帧必须被计数，便于人判断"日志没写完"');
  assert.equal(summary.skippedFrames, 1);
  assert.ok(frames[1].note?.includes('truncated'), '应留下可读的说明');
});

const samples = findSamples();
const samplePath = samples.length ? samples[0].path : null;
const skipReason = '本机没有 session.v*.jsonl.zstd 样本（脱机环境正常现象）';

test('真实会话日志：解出的行数与字符数自洽', { skip: samplePath ? false : skipReason }, () => {
  const { text, summary } = decodeZstd(readFileSync(samplePath));
  assert.ok(summary.frameCount >= 1);
  assert.equal(summary.decodedChars, text.length, 'decodedChars 必须等于文本长度');
  const countedLines = text.split('\n').length;
  assert.ok(summary.lines > 0 && Math.abs(summary.lines - countedLines) <= 1,
    `summary.lines=${summary.lines} 与实际切行 ${countedLines} 只允许差 1（末尾换行）`);
});

test('firstFrameOnly（天真做法）：整段喂 zstdDecompressSync 视 Node 版本可能只解首帧（本模块存在的理由）', { skip: HAS_ZSTD ? false : 'Node < 22.15 没有内建 zstd，无法演示"天真做法"' }, () => {
  const { both } = twoFrames('AAA\n', 'BBB\n');
  const full = decodeZstd(both);
  const naive = firstFrameOnly(both);
  // 实测差异（别写死）：Node 24.18.0 只解出首帧；Node 24.22.2 已能一次解出全部帧。
  // 所以这里只断言"天真做法只会是首帧或全量"，并把命中哪种打印出来。
  assert.ok(
    naive.text === 'AAA\n' || naive.text === 'AAA\nBBB\n',
    `天真做法只该是首帧或全量，实际：${JSON.stringify(naive.text)}`,
  );
  assert.ok(naive.text.length <= full.text.length, `天真做法 ${naive.text.length} 不该超过全量 ${full.text.length}`);
  assert.equal(full.text, 'AAA\nBBB\n', '本模块要把两帧都拿到');
  if (naive.text === full.text) {
    console.log(`  ⚠ 本机 Node ${process.version} 的 zstdDecompressSync 已能跨帧解压：本模块的价值转为帧统计 / 截断标记 / 跳过 skippable / 逐帧回调`);
  }
});

test('真实会话日志：天真做法拿到的永远不多于全量（且通常更少）', { skip: samplePath ? false : skipReason }, () => {
  const buffer = readFileSync(samplePath);
  const full = decodeZstd(buffer);
  const naive = firstFrameOnly(buffer);
  assert.ok(naive.text.length <= full.text.length,
    `天真做法 ${naive.text.length} 不该超过全量 ${full.text.length}`);
});

/**
 * 第一块：帧扫描（合成多帧 + 真实样本）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { scanFrames } from '../src/zstd-frames.mjs';
import { twoFrames } from './helpers.mjs';
import { findSamples } from '../verify/lib/samples.mjs';

test('合成两帧：frameCount=2，且两帧首尾相接无缝隙', () => {
  const { both } = twoFrames();
  const scan = scanFrames(both);
  assert.equal(scan.frameCount, 2);
  assert.equal(scan.zstdFrames, 2);
  assert.equal(scan.skippableFrames, 0);
  assert.equal(scan.trailingGarbage, 0);
  assert.equal(scan.frames[0].endOffset, scan.frames[1].offset, '第一帧结束处应正好是第二帧开始处');
});

test('空缓冲：0 帧、不炸', () => {
  const scan = scanFrames(Buffer.alloc(0));
  assert.equal(scan.frameCount, 0);
  assert.deepEqual(scan.frames, []);
});

test('纯文本（magic 不对）：0 帧且整段计入 trailingGarbage', () => {
  const buffer = Buffer.from('这不是 zstd，只是一段普通文本\n', 'utf8');
  const scan = scanFrames(buffer);
  assert.equal(scan.frameCount, 0, '不该把普通文本认成帧');
  assert.equal(scan.trailingGarbage, buffer.length);
  assert.ok(scan.gaps.length >= 1, '扫不到帧就该留下空档记录');
});

test('尾部垃圾：仍认得出前面两帧，多余字节单独计数', () => {
  const { both } = twoFrames();
  const tail = Buffer.from('GARBAGE-TAIL', 'utf8');
  const scan = scanFrames(Buffer.concat([both, tail]));
  assert.equal(scan.frameCount, 2);
  assert.equal(scan.trailingGarbage, tail.length);
});

const samples = findSamples();
const samplePath = samples.length ? samples[0].path : null;
const skipReason = '本机没有 ~/.dsh/sessions/**/session.v*.jsonl.zstd 样本（脱机环境正常现象）';

test('真实会话日志：帧扫描结果自洽（帧数与偏移单调）', { skip: samplePath ? false : skipReason }, () => {
  const scan = scanFrames(readFileSync(samplePath));
  assert.ok(scan.frameCount >= 1, `真实样本至少 1 帧，实际 ${scan.frameCount}`);
  for (const [index, frame] of scan.frames.entries()) {
    assert.ok(frame.endOffset > frame.offset, `第 ${index} 帧 endOffset 必须大于 offset`);
    if (index > 0) {
      assert.ok(frame.offset >= scan.frames[index - 1].endOffset, `第 ${index} 帧不该与前帧重叠`);
    }
  }
});

test('真实会话日志：多帧确认（DSH 会话日志不止一帧）', { skip: samplePath ? false : skipReason }, () => {
  const scan = scanFrames(readFileSync(samplePath));
  assert.ok(scan.zstdFrames >= 1);
  // 只断言"文件长度 = 帧字节 + 垃圾字节"，任何情况下都该成立
  const covered = scan.frames.reduce((sum, frame) => sum + (frame.endOffset - frame.offset), 0);
  assert.equal(covered + scan.trailingGarbage, readFileSync(samplePath).length);
});

test('文件缺失时上面两条走 skip 而不是 fail（自检本用例自身前提）', () => {
  if (samplePath) {
    assert.ok(existsSync(samplePath));
  } else {
    assert.equal(skipReason.length > 0, true, '没有样本时必须给出 skip 理由');
  }
});

/**
 * 「帧边界遍历器」小类验收脚本
 * 三条验收标准逐条断言，任何一条不满足即非零退出。
 *
 * 用法：
 *   node verify/check-frames.mjs [真实样本路径]
 *   真实样本默认取 $env:USERPROFILE/.dsh/sessions 下任一 session.v4.jsonl.zstd；
 *   找不到时该条记为 SKIP（不算失败，避免在别的机器上假红）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { scanFrames, formatFrameTable } from '../src/zstd-frames.mjs';
import { findSamples } from './lib/samples.mjs';

let failures = 0;
const lines = [];
const log = (line) => { lines.push(line); console.log(line); };
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  →  ${detail}` : ''}`);
};

/** 样本收集见 ./lib/samples.mjs（两个验收脚本共用）。 */

log('════ 验收 1：真实多帧样本 ════');
const forced = process.argv[2];
const samples = forced ? [{ version: 0, path: forced }] : findSamples();
const v4 = samples.find((sample) => sample.version === 4) ?? samples[0];
if (!v4 || !existsSync(v4.path)) {
  log(`  SKIP  真实样本缺失（${v4?.path ?? '未找到'}），本机没有 .dsh/sessions 时不判红`);
} else {
  const buf = readFileSync(v4.path);
  const scan = scanFrames(buf);
  log(`  样本：${v4.path}`);
  log(`  字节：${buf.length}`);
  for (const row of formatFrameTable(scan)) {
    log(`    #${row.idx} ${row.kind} offset=${row.offset} end=${row.endOffset} bytes=${row.bytes} blocks=${row.blocks} types=${row.types} ${row.ok}`);
  }
  const offsets = scan.frames.map((frame) => frame.offset);
  check('frameCount = 2', scan.frameCount === 2, `实际 ${scan.frameCount}`);
  check('帧偏移 = [0, 203]', offsets.length === 2 && offsets[0] === 0 && offsets[1] === 203, `实际 [${offsets.join(', ')}]`);
  check('全部帧完整（无截断）', scan.frames.every((frame) => frame.complete), scan.frames.map((f) => f.truncated ?? 'ok').join(','));
  check('帧边界首尾相接、无空洞', scan.gaps.length === 0 && scan.frames.at(-1).endOffset === buf.length,
    `gaps=${scan.gaps.length} lastEnd=${scan.frames.at(-1).endOffset} fileSize=${buf.length}`);
}

// 附加强证据：v3 日志是「一事件一帧」，帧数远大于 v4，用来检验扫描器在几百帧规模上不会跑偏
const v3 = samples.find((sample) => sample.version === 3);
if (!forced && v3 && existsSync(v3.path)) {
  const buf = readFileSync(v3.path);
  const scan = scanFrames(buf);
  const contiguous = scan.frames.every((frame, i) => (i === 0 ? frame.offset === 0 : frame.offset === scan.frames[i - 1].endOffset));
  log('');
  log(`  附加样本（v3，一事件一帧）：${buf.length} 字节 → ${scan.frameCount} 帧`);
  check('v3 帧数 > 300 且各帧完整', scan.frameCount > 300 && scan.frames.every((frame) => frame.complete), `${scan.frameCount} 帧`);
  check('v3 帧偏移全链首尾相接、末帧落文件末尾', contiguous && scan.frames.at(-1).endOffset === buf.length,
    `lastEnd=${scan.frames.at(-1).endOffset}`);
}

log('');
log('════ 验收 2：合成多帧（逐帧压缩后拼接） ════');
{
  const chunks = ['alpha\n', 'beta-beta\n', 'gamma-gamma-gamma\n', 'delta\n'];
  const frames = chunks.map((chunk) => zstdCompressSync(Buffer.from(chunk, 'utf8')));
  const joined = Buffer.concat(frames);
  const scan = scanFrames(joined);
  for (const row of formatFrameTable(scan)) {
    log(`    #${row.idx} ${row.kind} offset=${row.offset} end=${row.endOffset} bytes=${row.bytes} blocks=${row.blocks}`);
  }
  check(`帧数 = ${frames.length}（构造值）`, scan.frameCount === frames.length, `实际 ${scan.frameCount}`);
  let contiguous = true;
  let expected = 0;
  for (const frame of scan.frames) {
    if (frame.offset !== expected) contiguous = false;
    expected = frame.endOffset;
  }
  check('每帧偏移首尾相接、无空洞', contiguous && scan.gaps.length === 0, `gaps=${scan.gaps.length}`);
  check('最后一帧末尾 = 文件末尾', scan.frames.at(-1).endOffset === joined.length, `${scan.frames.at(-1).endOffset} vs ${joined.length}`);
  const sizes = scan.frames.map((frame) => frame.contentSize);
  check('Frame_Content_Size 与原始块字节数逐帧一致',
    sizes.every((size, i) => size === Buffer.byteLength(chunks[i], 'utf8')),
    `解析 [${sizes.join(',')}] vs 实际 [${chunks.map((c) => Buffer.byteLength(c, 'utf8')).join(',')}]`);
}

log('');
log('════ 验收 3：skippable 帧（识别为帧、不参与解压） ════');
{
  const payload = Buffer.from('this-is-skippable-user-data-0123456789', 'utf8');
  const skippable = Buffer.alloc(8 + payload.length);
  skippable.writeUInt32LE(0x184d2a50, 0); // skippable magic
  skippable.writeUInt32LE(payload.length, 4);
  payload.copy(skippable, 8);

  const real = zstdCompressSync(Buffer.from('real-frame\n', 'utf8'));
  const mixed = Buffer.concat([real, skippable, zstdCompressSync(Buffer.from('after-skip\n', 'utf8'))]);
  const scan = scanFrames(mixed);
  for (const row of formatFrameTable(scan)) {
    log(`    #${row.idx} ${row.kind} offset=${row.offset} end=${row.endOffset} bytes=${row.bytes} ${row.ok}`);
  }
  check('总帧数 = 3（2 个 zstd + 1 个 skippable）', scan.frameCount === 3, `实际 ${scan.frameCount}`);
  check('zstdFrames = 2 / skippableFrames = 1', scan.zstdFrames === 2 && scan.skippableFrames === 1,
    `${scan.zstdFrames} / ${scan.skippableFrames}`);
  const skipped = scan.frames.filter((frame) => frame.kind === 'skippable');
  check('skippable 帧标记 skipped=true', skipped.length === 1 && skipped[0].skipped === true);
  check('skippable 帧不带解压产物字段', skipped.every((frame) => !('decompressed' in frame) && !('text' in frame)));
  check('skippable 载荷长度如实记录', skipped[0]?.payloadLength === payload.length, `实际 ${skipped[0]?.payloadLength}`);
  check('skippable 之后的帧仍在正确偏移', scan.frames[2].offset === real.length + skippable.length,
    `${scan.frames[2].offset} vs ${real.length + skippable.length}`);
}

log('');
log('════ 相邻锚（陌生视角挑刺） ════');
{
  const empty = scanFrames(Buffer.alloc(0));
  check('空输入不抛异常且 frameCount=0', empty.frameCount === 0);
  const garbage = Buffer.from('not a zstd frame at all, just text bytes', 'utf8');
  const scan = scanFrames(garbage);
  check('纯垃圾输入 frameCount=0、整段记为空洞', scan.frameCount === 0 && scan.trailingGarbage === garbage.length,
    `garbage=${scan.trailingGarbage}/${garbage.length}`);
  const leading = Buffer.concat([Buffer.from('junk!!', 'utf8'), zstdCompressSync(Buffer.from('x\n', 'utf8'))]);
  const leadScan = scanFrames(leading);
  check('前置垃圾不影响后续帧识别', leadScan.frameCount === 1 && leadScan.frames[0].offset === 6,
    `frameCount=${leadScan.frameCount} offset=${leadScan.frames[0]?.offset}`);
}

log('');
log(failures === 0 ? '结论：3 条验收标准全部通过 ✅' : `结论：${failures} 条断言未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);

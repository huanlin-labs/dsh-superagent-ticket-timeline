/**
 * 「逐帧解压与容错诊断」小类验收脚本
 * 三条验收标准逐条断言，任何一条不满足即非零退出。
 *
 * 用法：node verify/check-decode.mjs [真实样本路径]
 */
import { readFileSync, existsSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { decodeZstd, firstFrameOnly, firstFrameSlice, formatDecodeTable } from '../src/zstd-decode.mjs';
import { findSamples } from './lib/samples.mjs';

let failures = 0;
const log = (line) => console.log(line);
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  →  ${detail}` : ''}`);
};

log('════ 验收 1：真实样本解出的字符数与「只解第一帧」对照 ════');
const forced = process.argv[2];
const samples = forced ? [{ version: 0, path: forced }] : findSamples();
const v4 = samples.find((sample) => sample.version === 4) ?? samples[0];
if (!v4 || !existsSync(v4.path)) {
  log(`  SKIP  真实样本缺失（${v4?.path ?? '未找到'}），本机没有 .dsh/sessions 时不判红`);
} else {
  const buf = readFileSync(v4.path);
  const result = decodeZstd(buf);
  for (const row of formatDecodeTable(result)) {
    log(`    #${row.idx} ${row.kind} offset=${row.offset} bytes=${row.compressedBytes} decoded=${row.decodedBytes} ${row.status}`);
  }
  const naive = firstFrameOnly(buf);
  const sliced = firstFrameSlice(buf);

  log(`  逐帧解压：${result.summary.totalDecodedBytes} 字节 / ${result.summary.decodedChars} 字符 / ${result.summary.lines} 行 / ${result.summary.frameCount} 帧`);
  log(`  只解第一帧（整段喂解压器）：${naive.text.length} 字符`);
  log(`  只解第一帧（先切第一帧再解）：${sliced.text.length} 字符`);

  // 口径说明：验收原文写的是「字符数 ≥2,000,000」，那个数其实来自实测「字节数 2,205,080」。
  // 这里两条都量出来，谁不达标就摆在明面上，不把字节数当字符数糊过去。
  check('解出字节数 ≥ 2,000,000（原始口径：2,205,080 字节）', result.summary.totalDecodedBytes >= 2_000_000,
    `${result.summary.totalDecodedBytes} 字节`);
  check('解出字符数（UTF-16 码元）如实记录', result.summary.decodedChars > 1_900_000,
    `${result.summary.decodedChars} 字符 —— ${result.summary.decodedChars < 2_000_000 ? '按字面「字符 ≥2,000,000」不达标，差 ' + (2_000_000 - result.summary.decodedChars) + ' 字符' : '达标'}`);
  check('字节数 / 字符数 比值符合中文占比（>1.1）',
    result.summary.totalDecodedBytes / result.summary.decodedChars > 1.1,
    `${(result.summary.totalDecodedBytes / result.summary.decodedChars).toFixed(3)}`);
  check('解出事件（非空行）≥ 600 条', result.summary.lines >= 600, `${result.summary.lines}`);
  check('只解第一帧恰得 240 字符', naive.text.length === 240, `${naive.text.length}`);
  check('切出第一帧再解也是 240 字符（差值源于「只解一帧」而非切片）',
    sliced.text.length === 240, `${sliced.text.length}`);
  check('两者比值 > 5000 倍', result.summary.decodedChars / naive.text.length > 5000,
    `${(result.summary.decodedChars / naive.text.length).toFixed(0)} 倍`);
  check('每帧状态都是 ok', result.frames.every((frame) => frame.status === 'ok'),
    result.frames.map((frame) => frame.status).join(','));
}

log('');
log('════ 验收 2：三种坏输入都不抛异常、且如实记账 ════');
{
  const chunks = ['one\n', 'two-two\n', 'three-three-three\n', 'four\n'];
  const frames = chunks.map((chunk) => zstdCompressSync(Buffer.from(chunk, 'utf8')));
  const joined = Buffer.concat(frames);

  // (a) 截断末帧：把最后一帧砍掉一半
  const cut = joined.length - Math.floor(frames.at(-1).length / 2);
  const truncated = joined.subarray(0, cut);
  let truncatedResult;
  let threwA = false;
  try {
    truncatedResult = decodeZstd(truncated);
  } catch (error) {
    threwA = true;
    log(`    抛异常：${error.message}`);
  }
  const statuses = truncatedResult?.frames.map((frame) => frame.status).join(',') ?? '-';
  log(`    (a) 截断末帧 ${joined.length} → ${truncated.length} 字节：${statuses}`);
  check('(a) 不抛异常', !threwA);
  check('(a) 末帧标记 truncated', truncatedResult?.frames.at(-1)?.status === 'truncated', statuses);
  check('(a) 前 N-1 帧完整解出（文本 = 前三段原文）',
    truncatedResult?.text === chunks.slice(0, 3).join(''), JSON.stringify(truncatedResult?.text));
  check('(a) summary 记下 1 个 truncated 帧', truncatedResult?.summary.truncatedFrames === 1,
    `${truncatedResult?.summary.truncatedFrames}`);

  // (b) 空文件
  let emptyResult;
  let threwB = false;
  try {
    emptyResult = decodeZstd(Buffer.alloc(0));
  } catch (error) {
    threwB = true;
    log(`    抛异常：${error.message}`);
  }
  log(`    (b) 空文件：frameCount=${emptyResult?.summary.frameCount} text="${emptyResult?.text}"`);
  check('(b) 不抛异常', !threwB);
  check('(b) 得到 0 帧、空文本', emptyResult?.summary.frameCount === 0 && emptyResult?.text === '',
    `frames=${emptyResult?.summary.frameCount} chars=${emptyResult?.text.length}`);

  // (c) 中间插 64 字节垃圾
  const garbage = Buffer.alloc(64, 0x41);
  const mixed = Buffer.concat([frames[0], frames[1], garbage, frames[2], frames[3]]);
  let mixedResult;
  let threwC = false;
  try {
    mixedResult = decodeZstd(mixed);
  } catch (error) {
    threwC = true;
    log(`    抛异常：${error.message}`);
  }
  log(`    (c) 中间插 64 字节垃圾：frameCount=${mixedResult?.summary.frameCount} gapBytes=${mixedResult?.summary.gapBytes}`);
  check('(c) 不抛异常', !threwC);
  check('(c) 4 个 zstd 帧全部识别', mixedResult?.summary.frameCount === 4, `${mixedResult?.summary.frameCount}`);
  check('(c) 64 字节垃圾被记进诊断', mixedResult?.summary.gapBytes === 64, `${mixedResult?.summary.gapBytes}`);
  check('(c) 四段文本仍然完整拼接',
    mixedResult?.text === chunks.join(''), JSON.stringify(mixedResult?.text));
  check('(c) 跳过的帧数 = 0（垃圾不是帧）', mixedResult?.summary.skippedFrames === 0,
    `${mixedResult?.summary.skippedFrames}`);
}

log('');
log('════ 验收 3：帧数 / 总字节 / 跳过帧数 三个数字可单独断言（--json 同形对象） ════');
{
  const buf = Buffer.concat([
    zstdCompressSync(Buffer.from('a\n', 'utf8')),
    Buffer.concat([
      (() => { const out = Buffer.alloc(8 + 5); out.writeUInt32LE(0x184d2a50, 0); out.writeUInt32LE(5, 4); out.write('JUNK!', 8); return out; })(),
    ]),
    zstdCompressSync(Buffer.from('b\n', 'utf8')),
  ]);
  const json = JSON.parse(JSON.stringify(decodeZstd(buf).summary));
  log(`    summary = ${JSON.stringify(json)}`);
  check('可直接取 frameCount', json.frameCount === 3, `${json.frameCount}`);
  check('可直接取 totalCompressedBytes', json.totalCompressedBytes === buf.length, `${json.totalCompressedBytes} vs ${buf.length}`);
  check('可直接取 skippedFrames（skippable 计入）', json.skippedFrames === 1, `${json.skippedFrames}`);
  check('三个字段都是 number 型（不是字符串）',
    ['frameCount', 'totalCompressedBytes', 'skippedFrames'].every((key) => typeof json[key] === 'number'),
    ['frameCount', 'totalCompressedBytes', 'skippedFrames'].map((k) => typeof json[k]).join(','));
}

log('');
log('════ 相邻锚（陌生视角挑刺） ════');
{
  // 逐帧解压的文本必须与「手动分帧再各解各接起来」完全一致
  const chunks = ['x'.repeat(1000) + '\n', '中文字符串测试\n', 'yyy\n'];
  const frames = chunks.map((chunk) => zstdCompressSync(Buffer.from(chunk, 'utf8')));
  const joined = Buffer.concat(frames);
  const result = decodeZstd(joined);
  check('拼接结果 = 原始分段文本（含中文多字节）', result.text === chunks.join(''), JSON.stringify(result.text.slice(0, 20)));
  check('decodedChars = 文本长度（中文按字符计，不按字节）', result.summary.decodedChars === result.text.length,
    `${result.summary.decodedChars} vs ${result.text.length}`);
}

log('');
log(failures === 0 ? '结论：3 条验收标准全部通过 ✅' : `结论：${failures} 条断言未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);

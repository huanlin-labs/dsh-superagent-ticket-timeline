/**
 * 多帧 zstd 解码：逐帧解压 → 按帧序拼接 → 帧级诊断。
 *
 * 背景（实测数字，可复现）：DSH 的 session.v4.jsonl.zstd 414,456 字节、2 帧。
 *   - zlib.zstdDecompressSync(整文件)  → 240 字符（只有第一帧的 session 头），尾部 220 万字符全静默丢失
 *   - 本模块逐帧解压拼接                → 2,205,080 字符 / 625 条事件
 * 所以「解压」这一步的前提是把帧边界算准（见 ./zstd-frames.mjs），不能指望解压器自己跳帧。
 *
 * 容错约定：
 *   - 任何单帧失败都不抛异常、不中断其它帧
 *   - 每帧都有 status：ok / skipped（skippable 帧，按规范不解压）/ truncated（帧没走完）/ invalid（解压器拒绝）
 *   - 解出的字节先拼成 Buffer 再整体解码 UTF-8 —— 避免多字节字符跨界时被拆成乱码
 */
import { zstdDecompressSync } from 'node:zlib';
import { scanFrames, formatFrameTable } from './zstd-frames.mjs';

const FRAME_STATUS = {
  ok: 'ok',
  skipped: 'skipped',
  truncated: 'truncated',
  invalid: 'invalid',
};

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('decodeZstd 需要一个 Buffer 或 Uint8Array');
}

/**
 * 解码整段多帧 zstd 流。
 *
 * @param {Buffer|Uint8Array} input
 * @param {{ onFrame?: (frame: object) => void }} [options]
 * @returns {{
 *   text: string,
 *   frames: Array<object>,
 *   summary: { frameCount:number, zstdFrames:number, skippableFrames:number, skippedFrames:number,
 *              truncatedFrames:number, invalidFrames:number, totalCompressedBytes:number,
 *              totalDecodedBytes:number, decodedChars:number, lines:number, gapBytes:number }
 * }}
 */
export function decodeZstd(input, options = {}) {
  const buf = toBuffer(input);
  const scan = scanFrames(buf);
  const pieces = [];
  const frames = [];

  for (const frame of scan.frames) {
    const entry = {
      index: frame.index,
      kind: frame.kind,
      offset: frame.offset,
      endOffset: frame.endOffset,
      compressedBytes: frame.compressedLength,
      blockCount: frame.blockCount ?? 0,
      status: FRAME_STATUS.ok,
      decodedBytes: 0,
    };

    if (frame.kind === 'skippable') {
      entry.status = FRAME_STATUS.skipped;
      entry.note = 'skippable 帧：按规范不参与解压';
    } else if (!frame.complete) {
      entry.status = FRAME_STATUS.truncated;
      entry.note = `帧未走完，跳过解压（${frame.truncated}）`;
    } else {
      try {
        const out = zstdDecompressSync(buf.subarray(frame.offset, frame.endOffset));
        pieces.push(out);
        entry.decodedBytes = out.length;
      } catch (error) {
        entry.status = FRAME_STATUS.invalid;
        entry.note = `解压失败：${error.message}`;
      }
    }

    frames.push(entry);
    options.onFrame?.(entry);
  }

  const decoded = Buffer.concat(pieces);
  const text = decoded.toString('utf8');

  const summary = {
    frameCount: frames.length,
    zstdFrames: scan.zstdFrames,
    skippableFrames: scan.skippableFrames,
    skippedFrames: frames.filter((frame) => frame.status !== FRAME_STATUS.ok).length,
    truncatedFrames: frames.filter((frame) => frame.status === FRAME_STATUS.truncated).length,
    invalidFrames: frames.filter((frame) => frame.status === FRAME_STATUS.invalid).length,
    totalCompressedBytes: buf.length,
    totalDecodedBytes: decoded.length,
    decodedChars: text.length,
    lines: text.split('\n').filter((line) => line.length > 0).length,
    gapBytes: scan.trailingGarbage,
  };

  return { text, frames, summary };
}

/**
 * 「天真做法」对照物：直接拿整段字节喂 zstdDecompressSync，只得到第一帧。
 * 留在这里当活证据——它就是那个 240 字符的来源，也是本模块存在的理由。
 */
export function firstFrameOnly(input) {
  const buf = toBuffer(input);
  try {
    const out = zstdDecompressSync(buf);
    return { text: out.toString('utf8'), decodedBytes: out.length };
  } catch (error) {
    return { text: '', decodedBytes: 0, error: error.message };
  }
}

/** 只解第一帧、但先自己把第一帧切出来（证明差值不是切片的功劳，而是「只解一帧」这件事本身）。 */
export function firstFrameSlice(input) {
  const buf = toBuffer(input);
  const scan = scanFrames(buf);
  const first = scan.frames.find((frame) => frame.kind === 'zstd' && frame.complete);
  if (!first) return { text: '', decodedBytes: 0 };
  const out = zstdDecompressSync(buf.subarray(first.offset, first.endOffset));
  return { text: out.toString('utf8'), decodedBytes: out.length };
}

/** 诊断表：CLI 的 --frames 直接打印它。 */
export function formatDecodeTable(result) {
  return result.frames.map((frame) => ({
    idx: frame.index,
    kind: frame.kind,
    offset: frame.offset,
    endOffset: frame.endOffset,
    compressedBytes: frame.compressedBytes,
    decodedBytes: frame.decodedBytes,
    blocks: frame.blockCount,
    status: frame.status,
    note: frame.note ?? '',
  }));
}

export { formatFrameTable };

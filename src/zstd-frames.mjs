/**
 * zstd 帧边界扫描器（不依赖任何解压器）
 *
 * 为什么需要它：DSH 的会话日志是「多帧拼接」的 zstd 文件——每写入一批事件就 append 一个新帧。
 * Node 自带的 zlib.zstdDecompressSync(buffer) 只解第一帧就返回，后面的所有事件被静默丢掉。
 * 实测 session.v4.jsonl.zstd（414,456 B）整文件解压只得 240 字符（就是第一帧的 session 头），
 * 而逐帧解压拼接应得 2,205,080 字符。所以必须先自己把帧边界算出来。
 *
 * 本模块只做「算边界」这一件事：读 magic、读 Frame_Header_Descriptor、逐块跳 block header，
 * 直到遇见 last_block=1，得到下一帧的起始偏移。压缩数据的解压是另一个模块的事。
 *
 * 支持的格式（zstd v0.8+ 帧格式）：
 *   帧 magic        28 B5 2F FD                      —— 小端读作 0xFD2FB528
 *   skippable magic 50..5F 2A 4D 18                  —— 高 28 位为 0x184D2A50..0x184D2A5F
 *   Frame_Header_Descriptor  1 字节：
 *     bit 7-6 FCS_flag | bit 5 Single_Segment | bit 4 unused | bit 3 reserved
 *     bit 2 Content_Checksum | bit 1-0 Dictionary_ID_flag
 *   随后 Window_Descriptor（Single_Segment=0 时才有）、Dictionary_ID（0/1/2/4 字节）、
 *   Frame_Content_Size（0/1/2/4/8 字节，由 FCS_flag 与 Single_Segment 共同决定）
 *   块头 3 字节（小端）：bit0 Last_Block | bit2-1 Block_Type | bit23-3 Block_Size
 *     Block_Type: 0=Raw(块体=Block_Size) 1=RLE(块体=1) 2=Compressed(块体=Block_Size) 3=保留
 *   最后一个块之后若有 Content_Checksum，再 4 字节
 */

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_PREFIX = 0x184d2a50;

const BLOCK_RAW = 0;
const BLOCK_RLE = 1;
const BLOCK_COMPRESSED = 2;
const BLOCK_RESERVED = 3;

const BLOCK_TYPE_NAMES = ['raw', 'rle', 'compressed', 'reserved'];

/** 帧未能走到结尾的原因。 */
export const TRUNCATION = {
  header: 'truncated-header',
  body: 'truncated-block',
  checksum: 'truncated-checksum',
};

const isSkippableMagic = (value) => (value & SKIPPABLE_MASK) === SKIPPABLE_PREFIX;

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('scanFrames 需要一个 Buffer 或 Uint8Array');
}

/**
 * 解析单个 zstd 帧头，返回 block 区起点与头部信息；头部不完整时返回 {truncated}。
 */
function parseFrameHeader(buf, offset, limit) {
  const need = 4 + 1;
  if (offset + need > limit) return { truncated: TRUNCATION.header };
  const fhd = buf[offset + 4];
  const fcsFlag = fhd >>> 6;
  const singleSegment = ((fhd >>> 5) & 1) === 1;
  const contentChecksum = ((fhd >>> 2) & 1) === 1;
  const dictIdFlag = fhd & 3;
  const dictIdBytes = [0, 1, 2, 4][dictIdFlag];

  let fcsBytes;
  if (fcsFlag === 0) fcsBytes = singleSegment ? 1 : 0;
  else if (fcsFlag === 1) fcsBytes = 2;
  else if (fcsFlag === 2) fcsBytes = 4;
  else fcsBytes = 8;

  const windowBytes = singleSegment ? 0 : 1;
  const headerLength = 5 + windowBytes + dictIdBytes + fcsBytes;
  if (offset + headerLength > limit) return { truncated: TRUNCATION.header };

  let cursor = offset + 5 + windowBytes;
  const dictionaryId = dictIdBytes === 0 ? 0 : Number(buf.readUIntLE(cursor, dictIdBytes));
  cursor += dictIdBytes;

  let contentSize;
  if (fcsBytes === 1) contentSize = buf.readUInt8(cursor);
  else if (fcsBytes === 2) contentSize = buf.readUInt16LE(cursor) + 256;
  else if (fcsBytes === 4) contentSize = buf.readUInt32LE(cursor);
  else if (fcsBytes === 8) contentSize = Number(buf.readBigUInt64LE(cursor));

  return {
    headerLength,
    fcsFlag,
    singleSegment,
    contentChecksum,
    dictIdFlag,
    dictionaryId,
    contentSize,
    blockOffset: offset + headerLength,
  };
}

/** 从 block 区起点逐块跳过，返回该帧的结尾偏移与块统计。 */
function walkBlocks(buf, blockOffset, limit, contentChecksum) {
  let cursor = blockOffset;
  let blockCount = 0;
  const blockTypes = new Set();

  for (;;) {
    if (cursor + 3 > limit) return { truncated: TRUNCATION.body, blockCount, blockTypes };
    const header = buf.readUIntLE(cursor, 3);
    const last = (header & 1) === 1;
    const type = (header >>> 1) & 3;
    const size = header >>> 3;
    if (type === BLOCK_RESERVED) {
      return { truncated: 'reserved-block-type', blockCount, blockTypes };
    }
    blockTypes.add(BLOCK_TYPE_NAMES[type]);
    blockCount += 1;
    const bodyBytes = type === BLOCK_RLE ? 1 : size;
    cursor += 3 + bodyBytes;
    if (cursor > limit) return { truncated: TRUNCATION.body, blockCount, blockTypes };
    if (last) break;
  }

  if (contentChecksum) {
    if (cursor + 4 > limit) return { truncated: TRUNCATION.checksum, blockCount, blockTypes };
    cursor += 4;
  }
  return { endOffset: cursor, blockCount, blockTypes };
}

/**
 * 扫描整段字节流，返回每一帧的起止偏移与头部诊断。
 *
 * @param {Buffer|Uint8Array} input
 * @returns {{frameCount:number, zstdFrames:number, skippableFrames:number, frames:Array<object>,
 *            gaps:Array<{offset:number,length:number}>, trailingGarbage:number}}
 */
export function scanFrames(input) {
  const buf = toBuffer(input);
  const limit = buf.length;
  const frames = [];
  const gaps = [];
  let cursor = 0;

  while (cursor < limit) {
    // 找不到 magic 的字节：记成空洞，继续往后找，不影响已识别的帧
    if (cursor + 4 > limit) {
      gaps.push({ offset: cursor, length: limit - cursor });
      cursor = limit;
      break;
    }
    const magic = buf.readUInt32LE(cursor);

    if (isSkippableMagic(magic)) {
      if (cursor + 8 > limit) {
        frames.push({
          index: frames.length,
          kind: 'skippable',
          offset: cursor,
          endOffset: limit,
          compressedLength: limit - cursor,
          payloadOffset: cursor + 8,
          payloadLength: 0,
          complete: false,
          truncated: TRUNCATION.header,
          skipped: true,
          note: 'skippable 帧头不完整，不参与解压',
        });
        cursor = limit;
        break;
      }
      const size = buf.readUInt32LE(cursor + 4);
      const payloadOffset = cursor + 8;
      const endOffset = Math.min(payloadOffset + size, limit);
      frames.push({
        index: frames.length,
        kind: 'skippable',
        offset: cursor,
        endOffset,
        compressedLength: endOffset - cursor,
        payloadOffset,
        payloadLength: endOffset - payloadOffset,
        declaredPayloadLength: size,
        complete: endOffset === payloadOffset + size,
        truncated: endOffset === payloadOffset + size ? undefined : TRUNCATION.body,
        skipped: true,
        note: 'skippable 帧：按规范整段跳过，不参与解压',
      });
      cursor = endOffset;
      continue;
    }

    if (magic !== ZSTD_MAGIC) {
      // 逐字节前进，直到遇到下一个可能的 magic（或走完）
      const start = cursor;
      cursor += 1;
      while (cursor + 4 <= limit && buf.readUInt32LE(cursor) !== ZSTD_MAGIC
        && !isSkippableMagic(buf.readUInt32LE(cursor))) cursor += 1;
      if (cursor + 4 > limit) {
        gaps.push({ offset: start, length: limit - start });
        cursor = limit;
      } else {
        gaps.push({ offset: start, length: cursor - start });
      }
      continue;
    }

    const header = parseFrameHeader(buf, cursor, limit);
    if (header.truncated) {
      frames.push({
        index: frames.length,
        kind: 'zstd',
        offset: cursor,
        endOffset: limit,
        compressedLength: limit - cursor,
        complete: false,
        truncated: header.truncated,
        skipped: false,
      });
      cursor = limit;
      break;
    }

    const walked = walkBlocks(buf, header.blockOffset, limit, header.contentChecksum);
    const endOffset = walked.endOffset ?? limit;
    frames.push({
      index: frames.length,
      kind: 'zstd',
      offset: cursor,
      endOffset,
      compressedLength: endOffset - cursor,
      headerLength: header.headerLength,
      payloadOffset: header.blockOffset,
      payloadLength: endOffset - header.blockOffset,
      singleSegment: header.singleSegment,
      fcsFlag: header.fcsFlag,
      contentSize: header.contentSize,
      contentChecksum: header.contentChecksum,
      dictionaryId: header.dictionaryId,
      blockCount: walked.blockCount,
      blockTypes: [...walked.blockTypes],
      complete: walked.endOffset !== undefined,
      truncated: walked.truncated,
      skipped: false,
    });

    if (walked.endOffset === undefined) {
      cursor = limit;
      break;
    }
    cursor = walked.endOffset;
  }

  const zstdFrames = frames.filter((frame) => frame.kind === 'zstd');
  return {
    frameCount: frames.length,
    zstdFrames: zstdFrames.length,
    skippableFrames: frames.length - zstdFrames.length,
    frames,
    gaps,
    trailingGarbage: gaps.reduce((sum, gap) => sum + gap.length, 0),
  };
}

/** 把扫描结果排成一张可打印的对齐表，供 CLI 与人工核对帧边界。 */
export function formatFrameTable(scan) {
  const rows = scan.frames.map((frame) => ({
    idx: frame.index,
    kind: frame.kind,
    offset: frame.offset,
    endOffset: frame.endOffset,
    bytes: frame.compressedLength,
    blocks: frame.kind === 'zstd' ? frame.blockCount : '-',
    types: frame.kind === 'zstd' ? frame.blockTypes.join('+') : '-',
    ok: frame.complete ? 'ok' : frame.truncated,
  }));
  return rows;
}

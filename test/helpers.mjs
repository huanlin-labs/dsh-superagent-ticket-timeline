/**
 * 测试共用构造器。文件名不带 .test，所以 `node --test test/` 不会把它当用例文件。
 */
import { zstdCompressSync } from 'node:zlib';

/** 固定基准时间，避免用例依赖当前时间。 */
export const T0 = Date.parse('2026-09-01T00:00:00.000Z');

/** 第 i 分钟（i 从 0 起）——保证时间戳严格递增。 */
export const ts = (index) => new Date(T0 + index * 60_000).toISOString();

/** 造一条 Ticket 事件。 */
export function ev(index, type, extra = {}) {
  return { at: ts(index), type, ...extra };
}

/** 包成合法的 Ticket 事件流文档。 */
export function ticketDoc(events, ticket = { id: 'tk-test', title: '测试用票据' }) {
  return { declaredEventCount: events.length, ticket, events };
}

/** 两帧 zstd（每帧内容可指定）。 */
export function twoFrames(first = '第一帧\n', second = '第二帧\n') {
  const a = zstdCompressSync(Buffer.from(first, 'utf8'));
  const b = zstdCompressSync(Buffer.from(second, 'utf8'));
  return { a, b, both: Buffer.concat([a, b]) };
}

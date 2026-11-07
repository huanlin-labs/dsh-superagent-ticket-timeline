/**
 * 脱敏的验收面：泄露断言 + 可逆对照表。
 *
 * 两个问题分开回答：
 *   1. 「真漏没漏」—— 不能靠"我觉得假名挺安全"，要拿原始敏感串在产物里逐串查找。
 *      findLeaks/auditLeaks 就是这条可执行检查：给 needles + 产物，报每条命中次数。
 *   2. 「能不能倒回去」—— mapping 里存 真值→假名，unmapText 反向替换；
 *      默认不导出、不落盘，只有显式给 mapOut 路径才写文件。
 *
 * 顺序细节：反向替换按假名长度**从长到短**做，避免 `m-abc@mask.invalid` 被更短的
 * `m-abc` 抢先替换后留下残渣。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRedactor } from './redact.mjs';

/** mapping 文件的格式版本；将来改结构时靠它做兼容。 */
export const MAPPING_VERSION = 1;

/**
 * 在一批产物里逐串查找敏感串。
 * @param {string[]} needles 原始敏感串清单
 * @param {Array<{name?:string,text:string}>} haystacks 脱敏后的产物
 * @returns {{clean:boolean, findings:Array<{needle:string, hits:Array<{name:string,count:number}>, total:number}>}}
 */
export function findLeaks(needles, haystacks) {
  if (!Array.isArray(needles)) throw new TypeError('findLeaks 需要敏感串数组');
  const findings = [];
  for (const needle of needles) {
    if (typeof needle !== 'string' || needle === '') throw new TypeError('敏感串必须是非空字符串');
    const hits = [];
    let total = 0;
    for (const haystack of haystacks) {
      const text = haystack.text ?? '';
      let count = 0;
      let from = 0;
      for (;;) {
        const at = text.indexOf(needle, from);
        if (at === -1) break;
        count += 1;
        from = at + needle.length;
      }
      if (count > 0) hits.push({ name: haystack.name ?? '(unnamed)', count });
      total += count;
    }
    findings.push({ needle, hits, total });
  }
  return { clean: findings.every((finding) => finding.total === 0), findings };
}

/** 同上，但漏了就抛 —— 用在不允许"先放行再报告"的地方。 */
export function assertNoLeaks(needles, haystacks) {
  const report = findLeaks(needles, haystacks);
  if (!report.clean) {
    const detail = report.findings
      .filter((finding) => finding.total > 0)
      .map((finding) => `「${finding.needle}」命中 ${finding.total} 次（${finding.hits.map((hit) => `${hit.name}×${hit.count}`).join('、')}）`)
      .join('；');
    const error = new Error(`脱敏产物仍含敏感串：${detail}`);
    error.name = 'LeakError';
    error.report = report;
    throw error;
  }
  return report;
}

/**
 * 导出可逆对照表。不写文件，只产出数据（要不要落盘由调用方决定）。
 * 刻意不含时间戳：同一输入两次导出应得到**逐字节相同**的 JSON，便于做 diff / 签名。
 */
export function exportMapping(redactor, options = {}) {
  return {
    version: MAPPING_VERSION,
    salt: redactor.salt,
    note: options.note ?? '真值→假名对照表；含原始敏感信息，勿随产出一起分发',
    entries: redactor.entries(),
  };
}

/** 稳定序列化：条目按 类型+原值 排序，缩进两格，末尾换行。 */
export function serializeMapping(mapping) {
  const sorted = [...mapping.entries].sort((a, b) =>
    a.type === b.type ? a.original.localeCompare(b.original) : a.type.localeCompare(b.type));
  const doc = { ...mapping, entries: sorted };
  return JSON.stringify(doc, null, 2) + '\n';
}

/** 把对照表写成文件（唯一会落盘的地方，显式调用才发生）。 */
export function writeMappingFile(path, mapping) {
  writeFileSync(path, serializeMapping(mapping), 'utf8');
  return path;
}

/** 读回对照表，并做最小校验。 */
export function readMappingFile(path) {
  const raw = readFileSync(path, 'utf8');
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`mapping 文件不是合法 JSON：${error.message}`);
  }
  if (doc?.version !== MAPPING_VERSION) {
    throw new TypeError(`mapping 版本不认识：${doc?.version}（本程序支持 ${MAPPING_VERSION}）`);
  }
  if (!Array.isArray(doc.entries)) throw new TypeError('mapping 缺 entries 数组');
  return doc;
}

/**
 * 反向还原：把假名换回真值。
 * 按假名长度降序替换，避免短假名先吃掉长假名的一部分。
 */
export function unmapText(text, mapping) {
  if (typeof text !== 'string') throw new TypeError('unmapText 需要字符串');
  const pairs = [...mapping.entries]
    .filter((entry) => entry?.alias && entry?.original)
    .sort((a, b) => b.alias.length - a.alias.length);
  let output = text;
  for (const { alias, original } of pairs) {
    if (!output.includes(alias)) continue;
    output = output.split(alias).join(original);
  }
  return output;
}

/**
 * 按原始值猜主体类型（用于"清单驱动"的强制脱敏）。
 * 只做保守判断：猜不出就当用户名。
 */
export function inferType(value) {
  if (/^[A-Za-z]:\\|^\/(?:home|Users|root|opt|srv|var|tmp|etc)\//.test(value)) return 'path';
  if (/@/.test(value)) return 'email';
  if (/^(?:ghp|gho|ghu|ghs|ghr|github_pat)_|^sk-/.test(value)) return 'token';
  if (/^ch-[0-9a-f-]{20,}$/i.test(value)) return 'session';
  if (/^\\\\/.test(value)) return 'host';
  return 'user';
}

/**
 * 清单驱动的强制脱敏：把清单里的真值（若文本里还残留）无条件替换成假名。
 *
 * 为什么需要它：自动规则只能认出"长得像"的东西。正文里裸写的用户名（"由 alice 发起"）
 * 既不是路径也不是邮箱，自动规则认不出——而这类恰恰是清单里明令要保护的。
 * 顺序：长串优先，避免 `C:\Users\x\…` 被裸的 `x` 抢先替换后留下残骸。
 *
 * @param {string} text 已做过自动脱敏的文本
 * @param {Array<string|{value:string,type?:string}>} needles 原始敏感串清单
 * @param {object} redactor createRedactor() 实例（与自动脱敏共用同一张映射表）
 */
export function applyNeedles(text, needles, redactor) {
  let output = text;
  const normalized = needles
    .map((needle) => (typeof needle === 'string'
      ? { value: needle, type: inferType(needle) }
      : { value: needle?.value, type: needle?.type ?? inferType(needle?.value) }))
    .filter((needle) => typeof needle.value === 'string' && needle.value !== '')
    .sort((a, b) => b.value.length - a.value.length);

  for (const { value, type } of normalized) {
    if (!output.includes(value)) continue;
    output = output.split(value).join(redactor.alias(type, value));
  }
  return output;
}

/**
 * 一次完整的「脱敏文档」操作：给出原文，返回脱敏文本；
 * 只有显式传 mapOut 路径时才写对照表文件，否则**不碰磁盘**。
 *
 * @param {{ text: string, redactor?: object, mapOut?: string|null, note?: string,
 *           needles?: Array<string|object> }} params
 * @returns {{ text: string, mapping: object, mappingPath: string|null }}
 */
export function redactDocument({ text, redactor, mapOut = null, note, needles = [] }) {
  const machine = redactor ?? createRedactor();
  // 两段式：先按规则认得的自动脱敏，再按清单强制收口
  const auto = machine.redactText(text);
  const redacted = needles.length ? applyNeedles(auto, needles, machine) : auto;
  const mapping = exportMapping(machine, note ? { note } : {});
  if (mapOut) {
    writeMappingFile(mapOut, mapping);
    return { text: redacted, mapping, mappingPath: mapOut };
  }
  return { text: redacted, mapping, mappingPath: null };
}

/** 目录里是否存在看起来像对照表的文件（验收「不得落盘」用）。 */
export function mappingFileExists(path) {
  return existsSync(path);
}

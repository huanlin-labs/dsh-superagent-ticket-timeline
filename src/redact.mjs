/**
 * 稳定假名映射（脱敏的第一步）。
 *
 * 设计要点：
 *   1. 同一真值恒得同名 —— 以 `类型 + 真值` 为键维护 Map，进程内稳定；哈希是纯函数，跨运行也稳定。
 *   2. 假名形似真实值 —— 按类型给前缀（user- / repo- / ch- / tok- / host- / C:/work/），
 *      时间线读起来不破戏，而不是一堆 ████。
 *   3. 不同真值不撞名 —— 8 位哈希理论上可能撞，所以撞了就加 `-2`、`-3`… 后缀，
 *      并把它记进 collisions，绝不靠概率过日子。
 *   4. 假名对原值零包含 —— 哈希只输出 [0-9a-f]，前缀是固定词，因此假名不可能包含真值片段；
 *      这一点由验收脚本对每条映射逐一断言，而不是"我觉得不会"。
 *
 * 本模块只管"映射与替换"；可逆对照表导出（--map-out）与泄露断言属于下一个小类。
 */

/** 支持的主体类型与前缀模板。`h` 是 8 位哈希，`n` 是撞名时的序号后缀。 */
export const SUBJECT_TYPES = {
  // 头部用 `C:/wk/`（6 字符窗口内不出现 `/work/` 这类与真路径重合的片段）
  path: { prefix: 'C:/wk/', template: (h, n) => `C:/wk/${h}${n}` },
  user: { prefix: 'user-', template: (h, n) => `user-${h}${n}` },
  email: { prefix: 'm-', template: (h, n) => `m-${h}@mask.invalid` },
  token: { prefix: 'tok-', template: (h, n) => `tok-${h}${n}` },
  repo: { prefix: 'repo-', template: (h, n) => `repo-${h}${n}` },
  session: { prefix: 'ch-', template: (h, n) => `ch-${h}${n}` },
  host: { prefix: 'host-', template: (h, n) => `host-${h}${n}` },
  ip: { prefix: 'ip-', template: (h, n) => `ip-${h}${n}` },
};

export const SUBJECT_TYPE_LIST = Object.keys(SUBJECT_TYPES);

/** FNV-1a 32 位：无依赖、确定性、分布够用（配合撞名后缀）。 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const hex8 = (text) => fnv1a(text).toString(16).padStart(8, '0');

/**
 * 文本级识别规则（按顺序应用，先吃掉大结构再处理小片段）。
 * 覆盖边界说明见 README：裸 `owner/name` 与裸主机名无法与普通路径/单词可靠区分，
 * 这两类需要显式调用 alias('repo'|'host', 原值)。
 */
const TEXT_RULES = [
  // 邮箱（先做，避免后面的规则把 @ 前后拆开）
  { type: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // 令牌：GitHub / OpenAI 风格
  { type: 'token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}\b/g },
  { type: 'token', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  // DSH 会话 id（ch-<uuid>）
  { type: 'session', pattern: /\bch-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  // Windows 绝对路径（含 \Users\<name> 一类，整段吃掉，用户名自然一起隐去）
  // 尾部排除中英文标点：否则「index.ts（用于验证…）」会把中文括号与汉字一起吞进"路径"里，
  // 导致同一路径在不同语境下被当成两个不同真值、拿到两个不同假名。
  { type: 'path', pattern: /[A-Za-z]:\\[^\s"'`<>|,;()（）【】\[\]：:；，。、]*/g },
  // UNC 路径：\\HOST\share\...
  { type: 'host', pattern: /\\\\[A-Za-z0-9._-]+\\/g },
  // Unix 风格家目录 / 系统路径
  { type: 'path', pattern: /(?:^|[\s"'(=])(\/(?:home|Users|root|opt|srv|var|tmp|etc)\/[^\s"'`<>|,;)]+)/g },
  // IPv4（可带端口：10.8.0.14:6379 → ip-xxxxxxxx:6379；端口本身不算敏感，保留）
  // 放在最后：前面的规则都吃不到纯点分数字，不会被抢走。
  {
    type: 'ip',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\b/g,
  },
];

/** 创建一台脱敏机。`salt` 固定即跨运行稳定；改 salt 会整体换一套假名（有意为之）。 */
export function createRedactor(options = {}) {
  const salt = options.salt ?? 'dsh-ticket-timeline/v1';
  const forward = new Map(); // `${type}\u0000${value}` → alias
  const reverse = new Map(); // alias → { type, value }
  const usedAliases = new Set();
  const collisions = [];

  function assertType(type) {
    if (!SUBJECT_TYPES[type]) {
      throw new TypeError(`未知主体类型：${type}（可用：${SUBJECT_TYPE_LIST.join(' / ')}）`);
    }
  }

  /** 取得（必要时生成）某个真值的假名。 */
  function alias(type, value) {
    assertType(type);
    if (typeof value !== 'string' || value === '') throw new TypeError('alias 需要非空字符串真值');

    const key = `${type}\u0000${value}`;
    const existing = forward.get(key);
    if (existing) return existing;

    const spec = SUBJECT_TYPES[type];
    const hash = hex8(`${salt}\u0000${type}\u0000${value}`);
    let candidate = spec.template(hash, '');
    let suffix = 1;
    while (usedAliases.has(candidate)) {
      suffix += 1;
      candidate = spec.template(hash, `-${suffix}`);
      if (suffix === 2) collisions.push({ type, value, hash, alias: candidate });
    }

    forward.set(key, candidate);
    reverse.set(candidate, { type, value });
    usedAliases.add(candidate);
    return candidate;
  }

  /** 把一段文本里识别得到的主体全部换成假名。 */
  function redactText(text) {
    if (typeof text !== 'string' || text === '') return text ?? '';
    let output = text;
    for (const rule of TEXT_RULES) {
      output = output.replace(rule.pattern, (match, ...groups) => {
        const captured = typeof groups[0] === 'string' ? groups[0] : null;
        const subject = captured ?? match;
        // 关键：假名本身可能长得像被识别的模式（如 m-xxxx@mask.invalid 仍是邮箱），
        // 已经是假名的一律原样放回，否则第二次脱敏会把假名再脱一次 —— 不幂等。
        if (usedAliases.has(subject)) return match;
        const replaced = alias(rule.type, subject);
        return captured ? match.replace(captured, replaced) : replaced;
      });
    }
    return output;
  }

  return {
    salt,
    alias,
    redactText,
    /** 已生成的映射（供下一个小类做可逆对照表 / 泄露断言）。 */
    entries: () => [...forward.entries()].map(([key, value]) => {
      const [type, ...rest] = key.split('\u0000');
      return { type, original: rest.join('\u0000'), alias: value };
    }),
    stats: () => ({
      subjects: forward.size,
      byType: Object.fromEntries(SUBJECT_TYPE_LIST.map((type) => [
        type,
        [...forward.keys()].filter((key) => key.startsWith(`${type}\u0000`)).length,
      ])),
      collisions: collisions.length,
    }),
    collisions: () => [...collisions],
  };
}

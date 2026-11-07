/**
 * 「稳定假名映射」小类验收脚本
 * 三条验收标准逐条断言，任何一条不满足即非零退出。
 */
import { createRedactor, SUBJECT_TYPES, SUBJECT_TYPE_LIST } from '../src/redact.mjs';

let failures = 0;
const log = (line) => console.log(line);
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  →  ${detail}` : ''}`);
};

log('════ 验收 1：同一真值在多份输入里得到完全相同的假名 ════');

// 三份「文件」：内容不同、但有重叠的真值
const FILE_A = [
  '用户 zhaorui-wu 在 C:\\Users\\zhaorui-wu\\项目\\导出模块\\index.ts 改了限流',
  '报错联系 zhaorui-wu@example.com，仓库 acme/export-api，token ghp_9f8e7d6c5b4a3210',
].join('\n');
const FILE_B = [
  'again: C:\\Users\\zhaorui-wu\\项目\\导出模块\\index.ts 同一文件',
  'mailto zhaorui-wu@example.com ; repo acme/export-api ; 会话 ch-98359750-b64a-4b4a-a7fc-82aa9be0c5f9',
].join('\n');
const FILE_C = [
  'token 又出现一次：ghp_9f8e7d6c5b4a3210（日志粘贴）',
  'host: build01.corp',
].join('\n');

// 同一个 redactor 处理三份输入 —— 这是"跨文件一致"的实现前提
const shared = createRedactor();
const outA = shared.redactText(FILE_A);
const outB = shared.redactText(FILE_B);
const outC = shared.redactText(FILE_C);
log('    A →', outA);
log('    B →', outB);
log('    C →', outC);

const pathAlias = shared.alias('path', 'C:\\Users\\zhaorui-wu\\项目\\导出模块\\index.ts');
const emailAlias = shared.alias('email', 'zhaorui-wu@example.com');
const tokenAlias = shared.alias('token', 'ghp_9f8e7d6c5b4a3210');
const sessionAlias = shared.alias('session', 'ch-98359750-b64a-4b4a-a7fc-82aa9be0c5f9');
const repoAlias = shared.alias('repo', 'acme/export-api');

check('同一路径在 A、B 两份文件里都是同一个假名',
  outA.includes(pathAlias) && outB.includes(pathAlias), pathAlias);
check('同一邮箱在 A、B 里同名', outA.includes(emailAlias) && outB.includes(emailAlias), emailAlias);
check('同一 token 在 A、C 里同名（跨文件）',
  outA.includes(tokenAlias) && outC.includes(tokenAlias), tokenAlias);
check('会话 id 在 B 里被替换成 ch- 前缀假名',
  outB.includes(sessionAlias) && sessionAlias.startsWith('ch-'), sessionAlias);
check('显式登记的 repo 也能取出稳定假名', repoAlias.startsWith('repo-'), repoAlias);

// 另起一台新 redactor（独立进程/独立文件的典型情形），仍应得到同名 —— 哈希是纯函数
const fresh = createRedactor();
check('换一台 redactor（模拟另一次运行）同名同值仍得同一假名',
  fresh.alias('email', 'zhaorui-wu@example.com') === emailAlias
  && fresh.alias('token', 'ghp_9f8e7d6c5b4a3210') === tokenAlias,
  `${fresh.alias('email', 'zhaorui-wu@example.com')} / ${emailAlias}`);

// 同类型下不同值必须不同名（不是"一类一个名"）
const otherPath = shared.alias('path', 'C:\\Users\\zhaorui-wu\\项目\\别的文件.ts');
check('同类型不同真值得到不同假名', otherPath !== pathAlias, `${otherPath} ≠ ${pathAlias}`);

log('');
log('════ 验收 2：1000 个不同真值 → 1000 个不同假名 ════');
{
  const redactor = createRedactor();
  const PER_TYPE = 1000;
  const aliasesByType = {};
  let totalTruths = 0;

  for (const type of SUBJECT_TYPE_LIST) {
    const set = new Set();
    for (let i = 0; i < PER_TYPE; i += 1) {
      const truth = `${type}-value-${String(i).padStart(4, '0')}`;
      set.add(redactor.alias(type, truth));
      totalTruths += 1;
    }
    aliasesByType[type] = set;
    log(`    ${type.padEnd(8)} ${set.size}/${PER_TYPE} 个不同假名（示例 ${[...set][0]}）`);
  }

  check('每类型 1000 个真值 → 1000 个不同假名',
    SUBJECT_TYPE_LIST.every((type) => aliasesByType[type].size === PER_TYPE),
    SUBJECT_TYPE_LIST.map((type) => `${type}:${aliasesByType[type].size}`).join(' '));

  const all = new Set();
  for (const set of Object.values(aliasesByType)) for (const alias of set) all.add(alias);
  check('跨类型也不撞名（7 × 1000 = 7000 个唯一假名）', all.size === totalTruths,
    `${all.size} / ${totalTruths}`);
  check('stats 统计与真实调用一致',
    redactor.stats().subjects === totalTruths, `${redactor.stats().subjects}`);
  check('无碰撞后缀被触发（说明哈希在这个规模够用）',
    redactor.stats().collisions === 0, `${redactor.stats().collisions}`);

  // 类型前缀确实分开了不同类：按类型给出"必须有的头部/尾部"再断言，而不是拿模板函数自己比自己
  const EXPECT_HEAD = { path: 'C:/wk/', user: 'user-', email: 'm-', token: 'tok-', repo: 'repo-', session: 'ch-', host: 'host-', ip: 'ip-' };
  const EXPECT_TAIL = { email: '@mask.invalid' };
  const headOk = SUBJECT_TYPE_LIST.every((type) => [...aliasesByType[type]][0].startsWith(EXPECT_HEAD[type]));
  const tailOk = Object.entries(EXPECT_TAIL).every(([type, tail]) => [...aliasesByType[type]][0].endsWith(tail));
  check(`类型前缀/尾缀已生效（${SUBJECT_TYPE_LIST.length} 类各自可辨）`, headOk && tailOk,
    SUBJECT_TYPE_LIST.map((type) => `${type}:${[...aliasesByType[type]][0]}`).join(' | '));
}

log('');
log('════ 追加：碰撞后缀分支（7000 样本未触发，必须逼出来才算验过） ════');
{
  // 关键：alias() 内部已加后缀，所以"假名是否重复"永远测不出碰撞 ——
  // 必须读 collisions()。另外注意两点实测教训：
  //   ① 别在循环里调 stats()：它要遍历全部键，会退化成 O(n²)；
  //   ② 顺序串（probe-0, probe-1…）在 FNV-1a 下 30 万个都不撞，要用伪随机值（固定种子保证可复现）。
  const redactor = createRedactor();
  let seed = 0x2f6e2b1;
  const nextSuffix = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed.toString(36);
  };
  let probeCount = 0;
  for (let i = 0; i < 300000; i += 1) {
    redactor.alias('user', `probe-${nextSuffix()}-${i}`);
    probeCount += 1;
    if (redactor.collisions().length > 0) break;   // 别在这里调 stats()
  }
  const collisions = redactor.collisions();
  log(`    探针 ${probeCount} 个真值 → 记录 ${collisions.length} 次哈希碰撞`);
  check('碰撞分支可达（探针把 32 位哈希撞出来）', collisions.length > 0,
    collisions[0] ? `hash=${collisions[0].hash}` : `${probeCount} 样本内未撞`);

  if (collisions.length > 0) {
    const { hash, value: second } = collisions[0];
    const sameHash = redactor.entries().filter((entry) => entry.alias.includes(hash));
    const plain = sameHash.find((entry) => !entry.alias.endsWith('-2'));
    const suffixed = sameHash.find((entry) => entry.alias.endsWith('-2'));
    log(`    同哈希两个真值：${plain?.original} → ${plain?.alias} ；${suffixed?.original} → ${suffixed?.alias}`);
    check('撞名后加 -2 后缀，两值仍得不同假名',
      Boolean(plain) && Boolean(suffixed) && plain.alias !== suffixed.alias && suffixed.original === second,
      `${plain?.alias} / ${suffixed?.alias}`);
    check('回查仍稳定（同值恒同名）',
      redactor.alias('user', plain.original) === plain.alias
      && redactor.alias('user', suffixed.original) === suffixed.alias);
  }
}

log('');
log('════ 验收 3：假名对原值零包含 ════');
{
  const redactor = createRedactor();
  const truths = [
    ['path', 'C:\\Users\\zhaorui-wu\\项目\\导出模块\\index.ts'],
    ['path', '/home/zhaorui-wu/work/export/index.ts'],
    ['user', 'zhaorui-wu'],
    ['email', 'zhaorui-wu@example.com'],
    ['token', 'ghp_9f8e7d6c5b4a3210'],
    ['token', 'sk-live-9f8e7d6c5b4a3210zz'],
    ['repo', 'acme/export-api'],
    ['session', 'ch-98359750-b64a-4b4a-a7fc-82aa9be0c5f9'],
    ['host', 'build01.corp'],
  ];
  let violations = 0;
  for (const [type, truth] of truths) {
    const alias = redactor.alias(type, truth);
    const contained = alias.includes(truth);
    if (contained) violations += 1;
    log(`    ${type.padEnd(8)} ${alias.padEnd(22)} ⊄ ${truth.slice(0, 40)}${truth.length > 40 ? '…' : ''} → ${contained ? '包含！' : 'ok'}`);
  }
  check('每条假名都不包含其原值', violations === 0, `${violations} 条违规`);

  // 更强的检查：假名里不得出现原值的任何 6 字符以上连续片段
  let fragmentHits = 0;
  for (const [type, truth] of truths) {
    const alias = redactor.alias(type, truth);
    for (let i = 0; i + 6 <= truth.length; i += 1) {
      if (alias.includes(truth.slice(i, i + 6))) fragmentHits += 1;
    }
  }
  check('假名里不含原值的任何 6 字符片段（比"零包含"更严）', fragmentHits === 0, `${fragmentHits} 处`);

  // 1000 组随机真值同样验一遍
  const bulk = createRedactor();
  let bulkViolations = 0;
  for (let i = 0; i < 1000; i += 1) {
    const truth = `敏感原值-${i}-abcdefgh`;
    const alias = bulk.alias(i % 2 ? 'user' : 'repo', truth);
    if (alias.includes(truth)) bulkViolations += 1;
  }
  check('1000 组批量真值也零包含', bulkViolations === 0, `${bulkViolations}`);
}

log('');
log('════ 相邻锚（陌生视角挑刺） ════');
{
  const redactor = createRedactor();
  // 幂等：同一段文本反复脱敏结果不变
  const once = redactor.redactText(FILE_A);
  const twice = redactor.redactText(once);
  check('对已脱敏文本再脱敏不再变化（幂等）', once === twice);

  // 不含敏感内容的文本原样返回
  const plain = '这段文本没有路径、邮箱、令牌';
  check('无敏感内容的文本原样返回', redactor.redactText(plain) === plain);

  // 空输入与非法输入
  check('空字符串安全返回', redactor.redactText('') === '');
  let threw = false;
  try { redactor.alias('nope', 'x'); } catch (error) { threw = error instanceof TypeError; }
  check('未知类型抛 TypeError', threw);

  // 换 salt = 换整套假名（刻意如此，要能验证）
  const otherSalt = createRedactor({ salt: 'another/v1' });
  check('换 salt 后同名值改假名（salt 是唯一的稳定前提）',
    otherSalt.alias('email', 'zhaorui-wu@example.com') !== redactor.alias('email', 'zhaorui-wu@example.com'));

  // entries() 能拿回 原值→假名（下一个小类做可逆表要用）
  const entries = redactor.entries();
  check('entries() 返回 {type, original, alias} 三元组',
    entries.length > 0 && entries.every((entry) => entry.type && entry.original && entry.alias),
    `${entries.length} 条`);
}

log('');
log(failures === 0 ? '结论：3 条验收标准全部通过 ✅' : `结论：${failures} 条断言未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);

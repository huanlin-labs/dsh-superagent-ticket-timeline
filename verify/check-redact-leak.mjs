/**
 * 「泄露断言与可逆对照表」小类验收脚本
 * 三条验收标准逐条断言，任何一条不满足即非零退出。
 */
import { mkdirSync, readdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRedactor } from '../src/redact.mjs';
import {
  findLeaks, assertNoLeaks, exportMapping, serializeMapping, writeMappingFile,
  readMappingFile, unmapText, redactDocument,
} from '../src/redact-audit.mjs';

let failures = 0;
const log = (line) => console.log(line);
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  →  ${detail}` : ''}`);
};

/** 工作区规则要求临时件落在 D:\临时\；这里自建自清。 */
const TMP_ROOT = join(process.env.SystemDrive ?? 'D:', '临时', 'ticket-timeline-verify');
const workDir = join(TMP_ROOT, `run-${process.pid}`);
if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

// 待脱敏的三份「文件」——刻意把四类敏感串都塞进去
const DOCS = [
  {
    name: 'ticket.log',
    text: [
      'ticket tk-blocked 由 zhaorui-wu 在 C:\\Users\\zhaorui-wu\\项目\\导出模块\\index.ts 发起',
      '汇报 blocked：缺 Redis 凭据（联系 zhaorui-wu@example.com）',
    ].join('\n'),
  },
  {
    name: 'session.log',
    text: [
      'token 泄露演练：ghp_9f8e7d6c5b4a3210',
      '工作目录 /home/zhaorui-wu/work/export ；会话 ch-98359750-b64a-4b4a-a7fc-82aa9be0c5f9',
    ].join('\n'),
  },
  {
    name: 'notes.md',
    text: '同一路径再出现一次：C:\\Users\\zhaorui-wu\\项目\\导出模块\\index.ts（用于验证跨文件一致）',
  },
];

// 四类原始敏感串清单（用户名 / 路径 / 邮箱 / token）
const SENSITIVE = [
  'zhaorui-wu',                                   // 用户名（会作为邮箱/路径的一部分反复出现）
  'C:\\Users\\zhaorui-wu\\项目\\导出模块\\index.ts', // Windows 绝对路径
  '/home/zhaorui-wu/work/export',                  // Unix 绝对路径
  'zhaorui-wu@example.com',                        // 邮箱
  'ghp_9f8e7d6c5b4a3210',                          // token
  'ch-98359750-b64a-4b4a-a7fc-82aa9be0c5f9',       // 会话 id（附赠一类）
];

log('════ 验收 1：四类敏感串在未开 map-out 的产物里逐串 0 命中 ════');
const redactor = createRedactor();
const redactedDocs = DOCS.map((doc) => ({ name: doc.name, text: redactDocument({ text: doc.text, redactor, needles: SENSITIVE }).text }));
for (const doc of redactedDocs) {
  log(`    ${doc.name} → ${doc.text.replace(/\n/g, ' ⏎ ').slice(0, 150)}`);
}

const report = findLeaks(SENSITIVE, redactedDocs);
for (const finding of report.findings) {
  log(`    「${finding.needle.slice(0, 44)}${finding.needle.length > 44 ? '…' : ''}」命中 ${finding.total} 次`);
  check(`  逐串零命中：${finding.needle.slice(0, 30)}${finding.needle.length > 30 ? '…' : ''}`,
    finding.total === 0, `${finding.total} 次`);
}
check('整体判定 clean = true', report.clean === true);

// 跨文件同名：ticket.log 与 notes.md 里是同一路径，必须得到同一假名
{
  const inTicket = (redactedDocs[0].text.match(/C:\/wk\/[0-9a-f]+/g) ?? [])[0];
  const inNotes = (redactedDocs[2].text.match(/C:\/wk\/[0-9a-f]+/g) ?? [])[0];
  check('跨文件同一路径得到同一假名', Boolean(inTicket) && inTicket === inNotes, inTicket + ' vs ' + inNotes);
}

// 反向验证：检查器本身得能抓住泄露（否则"零命中"没有意义）
{
  const dirty = [...redactedDocs, { name: 'leaky.log', text: '不小心留下 ghp_9f8e7d6c5b4a3210' }];
  const dirtyReport = findLeaks(SENSITIVE, dirty);
  const tokenFinding = dirtyReport.findings.find((finding) => finding.needle === 'ghp_9f8e7d6c5b4a3210');
  check('（自检）故意泄露时检查器能抓到，且指出来源文件',
    dirtyReport.clean === false && tokenFinding.total === 1 && tokenFinding.hits[0].name === 'leaky.log',
    `clean=${dirtyReport.clean} hits=${tokenFinding.total}/${tokenFinding.hits[0]?.name}`);

  let threw = null;
  try { assertNoLeaks(SENSITIVE, dirty); } catch (error) { threw = error; }
  check('（自检）assertNoLeaks 在有泄露时抛 LeakError 并带报告',
    threw?.name === 'LeakError' && threw?.report?.clean === false && /命中 1 次/.test(threw.message),
    threw?.name ?? '未抛');
}

log('');
log('════ 验收 2：mapping.json 往返（脱敏 → 还原 → 逐字节相同） ════');
{
  const machine = createRedactor();
  const mapPath = join(workDir, 'mapping.json');

  for (const doc of DOCS) {
    const out = redactDocument({ text: doc.text, redactor: machine, mapOut: mapPath, needles: SENSITIVE });
    const restored = unmapText(out.text, out.mapping);
    const originalBuf = Buffer.from(doc.text, 'utf8');
    const restoredBuf = Buffer.from(restored, 'utf8');
    const identical = originalBuf.equals(restoredBuf);
    log(`    ${doc.name}: 原文 ${originalBuf.length}B → 脱敏 ${Buffer.byteLength(out.text, 'utf8')}B → 还原 ${restoredBuf.length}B ${identical ? '一致' : '不一致'}`);
    check(`  ${doc.name} 还原后与原文逐字节相同`, identical,
      `${restoredBuf.length}B vs ${originalBuf.length}B`);
  }

  // 落盘的 mapping 再读回来，同样能还原（证明文件本身可逆）
  const onDisk = readMappingFile(mapPath);
  const restoredFromFile = unmapText(redactedDocs[1].text, onDisk);
  check('从 mapping.json 读回后仍能还原且逐字节相同',
    Buffer.from(restoredFromFile, 'utf8').equals(Buffer.from(DOCS[1].text, 'utf8')),
    `${onDisk.entries.length} 条对照`);

  // 序列化确定性：同样输入两次导出，字节完全相同（便于 diff / 校验）
  const a = serializeMapping(exportMapping(machine));
  const b = serializeMapping(exportMapping(machine));
  check('mapping 序列化确定性（两次导出逐字节相同）', a === b, `${a.length}B`);

  // 长假名优先：邮件的假名带 @mask.invalid，若被更短假名抢先替换会留残渣
  check('反向替换按长度降序，未留残渣（无 mask.invalid 残留）',
    !restoredFromFile.includes('mask.invalid'));

  // mapping 里确实存的是"真值→假名"，不是空壳
  check('mapping 条目含真值与假名（各 ≥4 类）',
    new Set(onDisk.entries.map((entry) => entry.type)).size >= 4 && onDisk.entries.every((entry) => entry.original && entry.alias),
    `${onDisk.entries.length} 条 / ${new Set(onDisk.entries.map((entry) => entry.type)).size} 类`);
}

log('');
log('════ 验收 3：未给 mapOut 时不落任何映射文件 ════');
{
  const quietDir = join(workDir, 'quiet');
  mkdirSync(quietDir, { recursive: true });
  const before = readdirSync(quietDir);

  // 只脱敏、不给 mapOut —— 反复跑 5 次，确认磁盘一点动静都没有
  let allPathsNull = true;
  for (let i = 0; i < 5; i += 1) {
    const machine = createRedactor();
    for (const doc of DOCS) {
      const out = redactDocument({ text: doc.text, redactor: machine, needles: SENSITIVE }); // 无 mapOut
      if (out.mappingPath !== null) allPathsNull = false;
    }
  }
  const after = readdirSync(quietDir);
  log(`    ${quietDir} 目录内容：[${after.join(', ') || '空'}]（调用前 ${before.length} 项）`);
  check('未给 mapOut 时目录里没有新增任何文件', after.length === before.length,
    `${before.length} → ${after.length}`);
  check('未给 mapOut 时每次返回的 mappingPath 都是 null', allPathsNull);

  // 显式给出 mapOut 才写：反过来验证"开关真的有效"，不是永远不写
  const explicitPath = join(quietDir, 'mapping.json');
  redactDocument({ text: DOCS[0].text, redactor: createRedactor(), mapOut: explicitPath });
  check('显式给 mapOut 时才写出文件（开关有效）', existsSync(explicitPath));
  const written = readFileSync(explicitPath, 'utf8');
  check('写出的文件是合法 mapping（version + entries）',
    JSON.parse(written).version === 1 && Array.isArray(JSON.parse(written).entries));
}

log('');
log('════ 相邻锚（陌生视角挑刺） ════');
{
  // 空清单 / 空产物不炸
  check('空敏感串清单 → clean=true', findLeaks([], redactedDocs).clean === true);
  check('空产物清单 → clean=true', findLeaks(SENSITIVE, []).clean === true);

  // 敏感串清单里混入非字符串要报错，不能静默跳过
  let threw = false;
  try { findLeaks(['ok', 42], redactedDocs); } catch (error) { threw = error instanceof TypeError; }
  check('敏感串清单含非字符串时抛 TypeError', threw);

  // mapping 版本不认识要报错
  const badPath = join(workDir, 'bad-mapping.json');
  writeFileSync(badPath, JSON.stringify({ version: 99, entries: [] }), 'utf8');
  let versionThrew = false;
  try { readMappingFile(badPath); } catch (error) { versionThrew = error instanceof TypeError; }
  check('mapping 版本不认识时抛 TypeError（不硬读下去）', versionThrew);

  // unmap 对不含假名的文本原样返回
  check('unmap 对无假名文本原样返回',
    unmapText('这段没有假名', exportMapping(createRedactor())) === '这段没有假名');

  // writeMappingFile 是唯一落盘点：它返回路径
  const p = writeMappingFile(join(workDir, 'direct.json'), exportMapping(createRedactor()));
  check('writeMappingFile 返回写入路径且文件存在', existsSync(p) && p.endsWith('direct.json'));
}

// 直接使用顶部 import 的 writeFileSync

log('');
log(failures === 0 ? '结论：3 条验收标准全部通过 ✅' : `结论：${failures} 条断言未通过 ❌`);

// 自建自清：验收完把自己的临时目录删掉（只删自己创建的 run-<pid>）
rmSync(workDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);

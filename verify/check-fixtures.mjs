/**
 * 「三份 fixture」小类验收脚本
 * 三条验收标准逐条断言：终态三分、每份三件事（人类消息 / 报告序列 / 敏感串）、目录声明。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseTicketStream } from '../src/ticket-events.mjs';
import { reduceStream, stageAt, stageSequence } from '../src/ticket-stage.mjs';

let failures = 0;
const log = (line) => console.log(line);
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  →  ${detail}` : ''}`);
};

const DIR = 'fixtures';
const load = (name) => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

/** 敏感串探测器：每一类都给出命中的字面值，便于人看。 */
const SENSITIVE = [
  ['Windows 路径', /[A-Za-z]:\\\\?[^\s"，。；、）]+/g],
  ['邮箱', /[\w.+-]+@[\w-]+\.[\w.]+/g],
  ['访问令牌', /\b(?:ghp|gho|github_pat)_[A-Za-z0-9]{8,}\b/g],
  ['内网 IP', /\b\d{1,3}(?:\.\d{1,3}){3}:\d+\b/g],
  ['裸用户名', /\bzhaorui-wu\b/g],
];

function findSensitive(doc) {
  const text = JSON.stringify(doc);
  const hits = [];
  for (const [label, pattern] of SENSITIVE) {
    const found = [...new Set(text.match(pattern) ?? [])];
    if (found.length) hits.push({ label, values: found });
  }
  return hits;
}

log('════ 验收 1：三份 fixture 的终态（completed / 恢复后 ready / resumed） ════');
const EXPECT = {
  'ticket-happy.json': { narrative: '顺利到底', minAssignments: 1, maxAssignments: 1, mustPass: [], mustNot: ['person/blocked'], dropped: false },
  'ticket-blocked-retry.json': { narrative: '阻塞后恢复', minAssignments: 1, maxAssignments: 1, mustPass: ['person/blocked'], mustNot: [], dropped: false },
  'ticket-dropped-resumed.json': { narrative: 'dropped 后被唤醒', minAssignments: 2, maxAssignments: 2, mustPass: [], mustNot: [], dropped: true },
};

const parsedByName = {};
for (const [name, expect] of Object.entries(EXPECT)) {
  const doc = load(name);
  const parsed = parseTicketStream(doc, { source: name });
  parsedByName[name] = { doc, parsed };

  const steps = reduceStream(parsed);
  const state = steps.at(-1).state;
  const stages = stageSequence(parsed).map((entry) => entry.stage); // stage 本身就是 id 字符串
  const stageIds = [...new Set(stages)];
  const last = parsed.events.at(-1);
  const finalStage = stageAt(parsed, last.at).id;
  const assignments = [...new Set(parsed.events.filter((e) => e.assignmentId).map((e) => e.assignmentId))];
  const humanInputs = parsed.events.filter((e) => e.type === 'input.trigger' && e.human);
  const reports = parsed.events.filter((e) => e.type.startsWith('report.'));
  const blockedIdx = parsed.events.findIndex((e) => e.type === 'report.blocked');
  const droppedIdx = parsed.events.findIndex((e) => e.type === 'report.dropped');

  log(`    ${name}`);
  log(`      outcome=${state.ended?.outcome} by=${state.ended?.by} 末段=${finalStage} 事件=${parsed.events.length} 报告=${reports.length} assignment=${assignments.join(',')}`);
  log(`      阶段序列=${stageIds.join(' → ')}`);

  check(`  ${name} 解析通过且 declaredEventCount 对账一致`,
    parsed.events.length === doc.declaredEventCount, `${parsed.events.length} = ${doc.declaredEventCount}`);
  check(`  ${name} 终态 outcome=completed`, state.ended?.outcome === 'completed', String(state.ended?.outcome));
  check(`  ${name} 末段 stage=person/review（latestReport=ready）`, finalStage === 'person/review', finalStage);
  check(`  ${name} assignment 个数=${expect.minAssignments}`, assignments.length >= expect.minAssignments && assignments.length <= expect.maxAssignments, assignments.join(','));
  for (const stage of expect.mustPass) {
    check(`  ${name} 中途经过 ${stage}`, stageIds.includes(stage), stageIds.join(' → '));
  }
  for (const stage of expect.mustNot) {
    check(`  ${name} 全程没进过 ${stage}`, !stageIds.includes(stage), stageIds.join(' → '));
  }

  if (name === 'ticket-blocked-retry.json') {
    const blockedEvent = parsed.events[blockedIdx];
    const humanAfterBlocked = humanInputs.find((h) => parsed.events.indexOf(h) > blockedIdx);
    const readyEvent = parsed.events.find((e) => e.type === 'report.ready');
    const stageBlocked = stageAt(parsed, blockedEvent.at).id;
    const stageAfterHuman = humanAfterBlocked ? stageAt(parsed, humanAfterBlocked.at).id : '(人类消息缺失)';
    const stageReady = stageAt(parsed, readyEvent.at).id;
    check('  blocked 之后出现了人类消息', Boolean(humanAfterBlocked));
    check('  blocked 那一刻 stage = person/blocked', stageBlocked === 'person/blocked', stageBlocked);
    check('  人类消息到达后立刻离开 blocked（回到 working）', stageAfterHuman === 'working', stageAfterHuman);
    check('  最终 ready 让 stage 变为 person/review', stageReady === 'person/review', stageReady);
  }
  if (expect.dropped) {
    const humanAfter = humanInputs.some((h) => parsed.events.indexOf(h) > droppedIdx);
    const reDispatched = parsed.events.slice(droppedIdx).some((e) => e.type === 'assignment.started');
    check('  ① 有 report.dropped 且其后出现人类消息（唤醒）',
      droppedIdx >= 0 && humanAfter, `dropped@${droppedIdx}`);
    check('  ② 唤醒后重新派发了新的 assignment', reDispatched);
    check('  ③ ready 出现在 dropped 之后（复活成功）',
      stages.slice(droppedIdx).includes('person/review'), stages.slice(droppedIdx).join(','));
    check('  ④ 这张单由人结束（by=human）', state.ended?.by === 'human', String(state.ended?.by));
  }
}

log('');
log('════ 验收 2：每份至少 1 个人类消息 / 1 次报告序列 / 1 处敏感串 ════');
for (const [name, { doc, parsed }] of Object.entries(parsedByName)) {
  const humans = parsed.events.filter((e) => e.type === 'input.trigger' && e.human === true);
  const reports = parsed.events.filter((e) => e.type.startsWith('report.'));
  const states = reports.map((e) => e.state);
  const sensitive = findSensitive(doc);
  const kinds = sensitive.map((s) => `${s.label}×${s.values.length}`);

  log(`    ${name}`);
  log(`      人类消息=${humans.length} 报告序列=${states.join('→')} 敏感串=${kinds.join(' ')}`);

  check(`  ${name} 至少 1 条人类消息（input.trigger + human=true）`, humans.length >= 1, `${humans.length} 条`);
  check(`  ${name} 报告序列 ≥2 条且最后一条是 ready`,
    reports.length >= 2 && states.at(-1) === 'ready', states.join('→'));
  check(`  ${name} 至少 1 处敏感串`, sensitive.length >= 1, kinds.join(' / '));
  // 敏感串得是"会被人随手贴进日志"的那几类，且不能只有裸用户名撑数
  check(`  ${name} 敏感串覆盖 ≥2 个类别（路径 / 邮箱 / 令牌 / IP / 用户名）`,
    sensitive.length >= 2, kinds.join(' / '));
}

log('');
log('════ 验收 3：目录里有"这是合成数据"的声明 ════');
{
  const readmePath = join(DIR, 'README.md');
  let readme = '';
  try { readme = readFileSync(readmePath, 'utf8'); } catch { readme = ''; }
  check('fixtures/README.md 存在', readme.length > 0, `${readme.length} 字`);
  check('README 明写「合成数据」', readme.includes('合成数据'));
  check('README 明写「不是真实日志」', readme.includes('不是真实日志'));
  check('README 声明不对应任何真实会话/Ticket',
    readme.includes('不对应任何真实会话') && readme.includes('真实 Ticket'));
  check('README 给每份 fixture 都写了剧情与终态',
    ['ticket-happy.json', 'ticket-blocked-retry.json', 'ticket-dropped-resumed.json'].every((f) => readme.includes(f)));

  // 每份 fixture 自己也带声明（单独传出去不失上下文）
  for (const name of Object.keys(EXPECT)) {
    const doc = load(name);
    check(`  ${name} 文件内带 _synthetic 声明`,
      typeof doc._synthetic === 'string' && doc._synthetic.includes('合成数据'));
  }

  // 目录里不许混进别的东西（三份 json + 一份 README，边界清楚）
  const entries = readdirSync(DIR).sort();
  check('目录内容恰好是三份 fixture + README',
    entries.length === 4 && entries.filter((f) => f.endsWith('.json')).length === 3,
    entries.join(', '));
}

log('');
log('════ 相邻锚（陌生视角挑刺） ════');
{
  // 时间戳必须严格递进（真实日志允许同毫秒，手工编排不该倒流）
  for (const [name, { parsed }] of Object.entries(parsedByName)) {
    const times = parsed.events.map((e) => e.atMs);
    check(`  ${name} 时间戳严格递增`, times.every((t, i) => i === 0 || t > times[i - 1]),
      `${parsed.events[0].at} → ${parsed.events.at(-1).at}`);
  }

  // 三份的剧情确实不同（不是换标题的三胞胎）
  const signatures = Object.values(parsedByName).map(({ parsed }) =>
    parsed.events.map((e) => e.type).join('>'));
  check('三份 fixture 的事件签名互不相同', new Set(signatures).size === 3);

  // 文本是人话：每条 summary/note 都不许是占位符
  for (const [name, { parsed }] of Object.entries(parsedByName)) {
    const texts = parsed.events
      .map((e) => e.summary ?? e.note ?? e.text ?? e.title ?? '')
      .filter(Boolean);
    const lazy = texts.filter((t) => /TODO|xxx|lorem|占位|示例文本|test/i.test(t));
    check(`  ${name} 没有占位式文案`, lazy.length === 0, lazy.join(' | ') || `${texts.length} 条都是人话`);
    check(`  ${name} 每条叙述性文本长度 ≥ 8 字`,
      texts.every((t) => t.length >= 8), texts.map((t) => t.length).join(','));
  }
}

log('');
log(failures === 0 ? '结论：3 条验收标准全部通过 ✅' : `结论：${failures} 条断言未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);

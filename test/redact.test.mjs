/**
 * 第四块：脱敏稳定性与往返
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor } from '../src/redact.mjs';
import { redactDocument, unmapText, exportMapping } from '../src/redact-audit.mjs';

const PATH = 'C:\\Users\\alice\\项目\\导出模块\\index.ts';
const EMAIL = 'alice@example.com';
const TOKEN = 'ghp_9f8e7d6c5b4a3210';

test('稳定性：同一 salt 下，同一真值永远映射到同一假名', () => {
  const redactor = createRedactor({ salt: 'salt-A' });
  assert.equal(redactor.alias('path', PATH), redactor.alias('path', PATH));
});

test('稳定性：不同 salt 下，同一真值映射到不同假名（假名不可跨环境对照）', () => {
  const a = createRedactor({ salt: 'salt-A' }).alias('path', PATH);
  const b = createRedactor({ salt: 'salt-B' }).alias('path', PATH);
  assert.notEqual(a, b, '换 salt 后假名必须变，否则跨项目可撞库');
});

test('假名形如 <类型前缀><8位十六进制>，不带原值片段', () => {
  const redactor = createRedactor({ salt: 'salt-A' });
  const alias = redactor.alias('path', PATH);
  assert.match(alias, /^C:\/wk\/[0-9a-f]{8}$/);
  assert.equal(alias.includes('alice'), false);
});

test('四类敏感串各自脱敏成对应前缀', () => {
  const redactor = createRedactor({ salt: 'salt-A' });
  const out = redactDocument({ text: `${PATH} ${EMAIL} ${TOKEN} 用户 alice`, redactor }).text;
  assert.equal(out.includes('alice-wu@'), false, '邮箱不该原样保留');
  assert.equal(out.includes('ghp_'), false, '令牌不该原样保留');
  assert.match(out, /m-[0-9a-f]{8}@mask\.invalid/, '邮箱应替换为 m-<hash>@mask.invalid');
  assert.match(out, /tok-[0-9a-f]{8}/, '令牌应替换为 tok-<hash>');
});

test('往返：脱敏后 unmapText 能还原出原文关键片段', () => {
  const redactor = createRedactor({ salt: 'salt-A' });
  const { text, mapping } = redactDocument({ text: `${PATH} / ${EMAIL} / ${TOKEN}`, redactor });
  assert.notEqual(text, `${PATH} / ${EMAIL} / ${TOKEN}`, '先确认真的改了');
  const back = unmapText(text, mapping);
  assert.ok(back.includes(PATH), `应还原出路径，实际：${back}`);
  assert.ok(back.includes(EMAIL), `应还原出邮箱，实际：${back}`);
  assert.ok(back.includes(TOKEN), `应还原出令牌，实际：${back}`);
});

test('幂等：对已脱敏文本再跑一次，不会二次变形', () => {
  const redactor = createRedactor({ salt: 'salt-A' });
  const once = redactDocument({ text: `${PATH} ${EMAIL}`, redactor }).text;
  const twice = redactDocument({ text: once, redactor }).text;
  assert.equal(twice, once);
});

test('对照表带版本号与盐，且条数等于见过的真值数', () => {
  const redactor = createRedactor({ salt: 'salt-A' });
  redactDocument({ text: `${PATH} ${EMAIL}`, redactor });
  const mapping = exportMapping(redactor);
  assert.equal(mapping.version, 1);
  assert.equal(mapping.salt, 'salt-A');
  assert.equal(mapping.entries.length, 2);
  for (const entry of mapping.entries) {
    assert.ok(entry.original && entry.alias && entry.type, '每条都要有 original/alias/type');
    assert.notEqual(entry.original, entry.alias);
  }
});

// ── IP 脱敏（补：原文只覆盖路径/邮箱/令牌/用户名，IP 会漏）──────────
test('IP 也脱敏：IPv4 → ip-<hash>，端口保留且同值同假名', () => {
  const redactor = createRedactor({ salt: 'salt-A' });
  const out = redactDocument({ text: 'A 连 10.8.0.14:6379，B 也是 10.8.0.14', redactor }).text;
  assert.equal(out.includes('10.8.0.14'), false, '真 IP 不该留在产物里');
  const aliases = out.match(/ip-[0-9a-f]{8}/g) ?? [];
  assert.equal(aliases.length, 2, '两处 IP 应各换一次');
  assert.equal(aliases[0], aliases[1], '同一 IP 必须是同一个假名');
  assert.ok(out.includes(`${aliases[0]}:6379`), '端口不属于敏感信息，要保留');
});

test('IP 往返：unmapText 能还原回真地址', () => {
  const redactor = createRedactor({ salt: 'salt-A' });
  const original = '连 10.8.0.14:6379';
  const { text, mapping } = redactDocument({ text: original, redactor });
  assert.notEqual(text, original);
  assert.equal(unmapText(text, mapping), original);
});
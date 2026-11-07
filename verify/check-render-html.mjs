/**
 * 「单文件 HTML」小类验收脚本
 * 三条验收标准逐条断言（第 3 条在浏览器里另做，见报告）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTicketStream } from '../src/ticket-events.mjs';
import { renderHtmlTimeline, jsonForScript, buildHtmlModel } from '../src/render-html.mjs';
import { SAMPLES } from './lib/sample-tickets.mjs';

let failures = 0;
const log = (line) => console.log(line);
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  →  ${detail}` : ''}`);
};

const rendered = SAMPLES.map((sample) => {
  const parsed = parseTicketStream(sample.doc, { source: sample.name });
  return { name: sample.name, parsed, html: renderHtmlTimeline(parsed) };
});

log('════ 验收 1：文件内不出现任何 http(s) 资源引用 ════');
{
  const PATTERNS = [
    ['http(s):// 协议字面量', /https?:\/\//],
    ['带 src 的标签', /\ssrc\s*=/i],
    ['href 指向外链', /href\s*=\s*["']?https?:/i],
    ['CSS @import', /@import/i],
    ['CSS url(...)', /url\s*\(/i],
    ['协议相对引用 //cdn', /["'(]\/\/[a-z0-9]/i],
    ['<link> 标签', /<link\b/i],
    ['<iframe>/<object>/<embed>', /<(iframe|object|embed)\b/i],
  ];
  for (const { name, html } of rendered) {
    for (const [label, pattern] of PATTERNS) {
      const hit = html.match(pattern);
      check(`  ${name} 不含${label}`, !hit, hit ? hit[0] : '0 命中');
    }
  }

  // 自查：这份检查器真能抓到外链（否则"0 命中"没意义）
  const dirty = rendered[0].html.replace('</head>', '<link rel="stylesheet" href="https://cdn.example.com/x.css"></head>');
  check('（自检）故意塞 CDN 时扫描器能抓到',
    /https?:\/\//.test(dirty) && /<link\b/i.test(dirty));

  // 数据里若有 URL，也必须被转义消化掉（无损）
  const withUrl = {
    declaredEventCount: 2,
    ticket: { id: 'tk-url', title: '带 URL 的票据' },
    events: [
      { at: '2026-09-04T01:00:00.000Z', type: 'ticket.created', ticketId: 'tk-url', title: '带 URL 的票据', decisionId: 'd', strength: 'explicit' },
      { at: '2026-09-04T01:01:00.000Z', type: 'input.note', text: '参考 https://example.com/a/b?x=1 与 http://x.test/y' },
    ],
  };
  const urlParsed = parseTicketStream(withUrl, { source: 'url' });
  const urlHtml = renderHtmlTimeline(urlParsed);
  check('数据含 URL 时文件里仍搜不到 http://', !/https?:\/\//.test(urlHtml));
  const urlModel = JSON.parse(
    urlHtml.match(/<script type="application\/json" id="ticket-data">([\s\S]*?)<\/script>/)[1].replace(/\\\//g, '/'),
  );
  check('但 JSON 解析后 URL 原样还回（转义无损）',
    urlModel.items[1].raw.text === '参考 https://example.com/a/b?x=1 与 http://x.test/y',
    urlModel.items[1].raw.text);
}

log('');
log('════ 验收 2：fixture 每条事件在数据块里都有对应 id，条数一致 ════');
{
  for (const { name, parsed, html } of rendered) {
    const match = html.match(/<script type="application\/json" id="ticket-data">([\s\S]*?)<\/script>/);
    check(`  ${name} 有内联数据块`, Boolean(match));
    const data = JSON.parse(match[1]);

    const businessCount = parsed.events.length;
    const idsFromData = data.items.map((item) => item.id);
    const idsFromBody = [...html.matchAll(/<li class="ev[^"]*" id="(ev-\d+)"/g)].map((m) => m[1]);

    log(`    ${name}: 事件 ${businessCount} 条 / 数据块 ${data.items.length} 条 / 正文 li ${idsFromBody.length} 个`);
    check(`  ${name} 数据块条数 = 事件条数`, data.items.length === businessCount,
      `${data.items.length} vs ${businessCount}`);
    check(`  ${name} 正文 li 条数 = 事件条数`, idsFromBody.length === businessCount,
      `${idsFromBody.length} vs ${businessCount}`);
    check(`  ${name} id 连续无缺（ev-0 … ev-${businessCount - 1}）`,
      idsFromData.every((id, i) => id === `ev-${i}`) && idsFromBody.join() === idsFromData.join());

    // 每条 id 在数据块与正文都对得上，且原始事件完整（可折叠展示用）
    const allRawOk = data.items.every((item, i) => item.raw && item.raw.type === parsed.events[i].type
      && item.raw.at === parsed.events[i].at);
    check(`  ${name} 每条 item 都带完整原始事件且与原文一致`, allRawOk);
  }
}

log('');
log('════ 相邻锚（陌生视角挑刺） ════');
{
  const { html, parsed } = rendered[1];

  // 自包含：样式与脚本都在文件内，且只有一个 JSON 数据块
  check('样式内联（<style> 存在，无外部样式表）', /<style>[\s\S]+<\/style>/.test(html) && !/<link\b/i.test(html));
  check('脚本内联（有行为脚本，且不含 src）',
    /<script>\s*\(function \(\)/.test(html) && !/<script[^>]*\ssrc/i.test(html));
  const jsonBlocks = [...html.matchAll(/<script type="application\/json"/g)];
  check('数据块恰好一个', jsonBlocks.length === 1, `${jsonBlocks.length} 个`);

  // 结构要件
  check('粘性时间戳（CSS position:sticky）', /\.ev \.t\{position:sticky/.test(html));
  check('原始事件可折叠（details/summary）',
    (html.match(/<details>/g) ?? []).length === parsed.events.length);
  check('报告事件有独立视觉重量（ev--report 类）',
    /ev--report \.sum\{font-weight:600\}/.test(html) && /ev--report/.test(html));
  check('左栏筛选：阶段 / 类别 / 仅人类介入 三类控件齐备',
    /data-role="stage"/.test(html) && /data-role="cat"/.test(html) && /id="humanOnly"/.test(html));
  check('顶部概览数字（当前阶段 / 跨度 / 事件 / 人类介入 / 失败 / 重试 / 状态）',
    ['当前阶段', '跨度', '事件', '人类介入', '失败', '重试', 'Ticket 状态'].every((label) => html.includes(`<span>${label}</span>`)));
  check('深浅色跟随系统 + 手动切换',
    /prefers-color-scheme: dark/.test(html) && /data-theme="auto"/.test(html) && /id="theme"/.test(html));

  // JSON 转义是无损的：把数据块还原后与 model 完全一致
  const raw = html.match(/<script type="application\/json" id="ticket-data">([\s\S]*?)<\/script>/)[1];
  const roundTrip = JSON.parse(raw.replace(/\\\//g, '/'));
  const model = buildHtmlModel(parsed);
  check('数据块 JSON 往返与 buildHtmlModel 完全一致（转义无损）',
    JSON.stringify(roundTrip) === JSON.stringify({
      meta: model.meta, stages: model.stages, categories: model.categories, items: model.items,
    }));

  // 转义函数本身的边界：</script> 不能把块提前闭合
  const evil = jsonForScript({ x: '</script><b>x</b>' });
  check('jsonForScript 顶住 </script> 注入（< 被转义）', !evil.includes('</script>'), evil.slice(0, 40));
  check('jsonForScript 输出仍是合法 JSON', JSON.parse(evil.replace(/\\\//g, '/')).x === '</script><b>x</b>');

  // 生成浏览器验证用的真实文件（不是测试桩，是给人双击的那份）
  const outDir = join('examples');
  mkdirSync(outDir, { recursive: true });
  for (const { name, html: h } of rendered) {
    writeFileSync(join(outDir, `ticket-${name}.html`), h, 'utf8');
  }
  check('三份示例 HTML 已落盘（examples/ticket-*.html）',
    rendered.every((item) => item.html.length > 2000),
    rendered.map((item) => `${item.name}:${item.html.length}B`).join(' '));
}

log('');
log(failures === 0 ? '结论：验收 1、2 全部通过 ✅（验收 3 见浏览器截图）' : `结论：${failures} 条断言未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);

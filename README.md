# dsh-superagent Ticket 日志时间线

把 **dsh-superagent 的 Ticket 事件流** 或 **DSH 的多帧 zstd 会话日志**，变成一条**脱敏、可直读的时间线** ——
CLI 一行出结论，单文件 HTML 双击可看。

> 面向：手里只有原始日志、却要回答「这个 Ticket 到底发生了什么」的人（排查者 / 评审者 / 面试官）。

---

## 1. 这是什么 / 不是什么

**是**

- 一个**零依赖**的 Node 工具（只用 Node 内置模块，无 `npm install`，无网络）。
- 把两类原始数据投影成**同一种时间线条目**（`{id, at, atMs, source, kind, subject, summary, rawRef}`），按时间轴混排。
- 提供**终端文本**与**单文件 HTML**两种视图，和一个**机读 JSON 出口**。
- 脱敏：路径 / 用户名 / 邮箱 / token 等换成**稳定假名**，可选导出「假名↔真值」对照表做**可逆还原**。

**不是**

- ❌ 不是 dsh-superagent 运行时的一部分，**不连它、不改它**；
- ❌ 不做**因果推断**：只呈现「哪一刻发生了什么」，不解释「为什么」；
- ❌ 不做日志采集 / 上传 / 聚合：全程本地，不联网；
- ❌ 不是通用日志查看器：事件语义**专为 003-execution.md 的 Ticket 模型**写死。

---

## 2. 30 秒上手（三步，照抄可跑）

前置：**Node ≥ 22.15**（用到内置 `zlib` 的 zstd 支持），零第三方依赖。

```bash
# 1) Ticket 事件流 → 机读 JSON（脱敏时间线 + 原始事件）
node bin/ticket-timeline.mjs ticket fixtures/ticket-blocked-retry.json --json > demo.json

# 2) JSON → 单文件 HTML（自包含，无外链）
node bin/ticket-timeline.mjs render --in demo.json --out demo.html

# 3) 打开（Windows: start demo.html ｜ macOS: open demo.html ｜ Linux: xdg-open demo.html）
```

实测产出（本机复现过）：`demo.json` **7,379 字节** → `demo.html` **23,417 字节 / 10 条事件**，
HTML 里搜不到 `http://` / `https://`，`id="ev-0"…"ev-9"` 共 **10 个**条目。

不想生成文件、只想看结论：

```bash
node bin/ticket-timeline.mjs ticket fixtures/ticket-blocked-retry.json --no-color
node bin/ticket-timeline.mjs ticket fixtures/ticket-blocked-retry.json --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.frameCount,o.entries.length,o.meta.currentStage)})"
```

三路子命令各带 `--help`：`ticket` / `session` / `render`。

---

## 3. 两种数据源

### 3.1 Ticket 事件流（JSON，多为 fixture / 上游导出）

```json
{ "declaredEventCount": 10,
  "ticket": { "id": "tk-…", "title": "…", "decisionId": "…", "strength": "explicit" },
  "events": [ { "at": "2026-09-09T14:02:11.000Z", "type": "ticket.created", "…": "…" } ] }
```

识别 16 种事件（`ticket.created` / `assignment.started|ended` / `report.progress|waiting|ready|blocked|failed|dropped` /
`input.trigger|note` / `delivery.failed|delivered` / `attention.raised|cleared` / `ticket.ended`）。
`declaredEventCount` 是本工具的对账钩子（数量不符即报错）；**真实数据缺它也能跑**。

### 3.2 DSH 会话日志（多帧 `.zstd`，真实数据）

```bash
node bin/ticket-timeline.mjs session ~/.dsh/sessions/<会话目录>/session.v4.jsonl.zstd --json
```

读本机**真实**日志：多帧 zstd → 逐行 JSON → 投影成会话事件条目。**这是唯一吃真数据的一路。**

---

## 4. 多帧 zstd 为什么是坑（本作品的核心动机）

`zlib.zstdDecompressSync(整个文件)` **只解第一帧**，剩下的帧**静默丢弃** —— 不报错，只给你一小截。
真实会话日志是**多帧拼起来的**（每帧 ~128 KB 压缩块），于是「天真做法」拿到的内容少得离谱：

| 样本（本机真实文件，`session.v4.jsonl.zstd`） | 数值 |
|---|---|
| 文件字节 | **414,456 B** |
| 扫描出的帧数 | **2 帧**（zstd 2 / skippable 0） |
| 逐帧解压后总字节 | **2,205,320 B** |
| 总字符 / 行数 | **1,976,071 字符 / 626 行** |
| 天真做法（整段喂 `zstdDecompressSync`） | **240 字符** |
| 差距 | **约 8,233 倍** |

极端样本更夸张：一个 **110,151,963 B** 的会话文件有 **17,952 帧**，逐帧解出 **194,267,892 字符**，
天真做法只有 **191 字符**（约 101 万倍）。

> 注意区分：**字节 ≠ 字符**。上表 2,205,320 是解压后的**字节数**，1,976,071 才是**字符数**（中文一个字 3 字节）。

本工具的做法（`src/zstd-frames.mjs` + `src/zstd-decode.mjs`）：

1. 按 magic（`28 B5 2F FD`）与块头**扫出每帧边界**，识别 skippable 帧（`0x184D2A50..5F`）；
2. **逐帧**解压，按帧拼字节、最后整体做一次 UTF-8 解码（跨帧不会切坏多字节字符）；
3. 坏输入**如实记账**而不是崩：截断帧标 `status:"truncated"`、计入 `summary.truncatedFrames`；
   尾部垃圾计入 `trailingGarbage`；一帧都没有就报「0 帧」。

---

## 5. 阶段推导规则表（8 态，**有条有序 · 首条命中即止**）

阶段不是事件直接给的，是**状态机**（`src/ticket-stage.mjs`）按 003-execution.md 的表推出来的。
判定顺序**从下往上**看这张表：越靠上越优先。

| 优先级 | stage | 成立条件（当前状态） |
|---:|---|---|
| 1 | `person/delivery` | 有**未清除**的投递失败（`delivery.failed` 后未 `delivered`） |
| 2 | `person/answer` | 有**待答复**的 Attention（`attention.raised` 未 `cleared`） |
| 3 | `person/review` | 最新报告是 `ready` |
| 4 | `person/blocked` | 最新报告是 `blocked` **且**此后没有人类消息 |
| 5 | `person/failed` | 最新报告是 `failed` **且**此后没有人类消息 |
| 6 | `working/queued` | 还没有 assignment（"No Assignment"） |
| 7 | `idle` | 最新报告是 `waiting`，或 assignment 已结束 |
| 8 | `working` | 兜底 |

两条容易踩的规则（都有测试盯着）：

- `blocked` / `failed` 会被**人类消息解除**：`input.trigger`（human）一到，立刻回 `working`；
- `ticket.ended` 不会把 `ready` 挤掉 —— 因为「最新报告是 ready」这条优先于兜底。

---

## 6. 脱敏规则与逆转

**换什么**（`src/redact.mjs`）：Windows/Unix 路径 → `C:/wk/<hash8>`；邮箱 → `m-<hash8>@mask.invalid`；
token（`ghp_…` 等）→ `tok-<hash8>`；裸用户名 / 仓库 / 频道 / 主机 → `<类型>-<hash8>`。

- **稳定**：同一 salt 下，同一真值永远得到同一假名（跨文件、跨次数一致）；
- **不可跨环境对照**：换 salt，假名全变；
- **幂等**：对已脱敏文本再跑一次不再变形；
- **零包含**：假名里不含原值任何片段；
- **碰撞有后缀**：真撞上了会加 `-2` 并计入 `collisions()`（用 84,921 个真值真撞出来过）。

**逆转**（`src/redact-audit.mjs` 的 `unmapText`）：

```bash
# 脱敏输出的同时把「假名↔真值」对照表落盘（默认不落盘！）
node bin/ticket-timeline.mjs ticket fixtures/ticket-blocked-retry.json --map-out mapping.json > redacted.txt
```

`redacted.txt` 里五类敏感串（路径 / 邮箱 / 令牌 / 用户名 / **IPv4**）**逐串 0 命中**（实测：`alice@example.com` / `ghp_9f8e…` / `10.8.0.14` 全部搜不到）。
**还原（CLI 闭环）**：`unmap` 子命令吃「已脱敏的文本」+ 对照表，把假名换回真值。

```bash
node bin/ticket-timeline.mjs unmap --in redacted.txt --map mapping.json --out restored.txt
```

实测：`redacted.txt` 里五类敏感串 0 命中 → `restored.txt` 里真值全回来（含 `10.8.0.14`、邮箱、令牌）。
`--out` 省略时直接打到 stdout，方便接管道。

也可以直接调库（同一套逻辑，`src/redact-audit.mjs`）：

```js
import { unmapText } from './src/redact-audit.mjs';
const mapping = JSON.parse(readFileSync('mapping.json', 'utf8'));
const original = unmapText(redactedText, mapping);   // 假名 → 真值，往返逐字节相同
```

**出口范围**（三条路径都过同一套脱敏，实测 0 命中）：

| 出口 | 脱敏方式 |
|---|---|
| 终端文本 | 渲染完整体过一次 |
| `--json` | **结构化**逐字符串脱敏后再 `JSON.stringify`（不拿正则扫 JSON 文本） |
| 单文件 HTML | 整份 HTML 过一次 |

> 教训：一开始图省事，对**序列化后的 JSON 文本**跑正则，路径规则会把 `\"file_path\": \"…\"` 里的转义引号一起吃掉，
> 产物变成非法 JSON（`npm run verify` 当场抓到）。现在改成按对象遍历，结构不可能被破坏。

---

## 7. 目录结构

```text
bin/ticket-timeline.mjs      CLI 薄壳（真逻辑在 src/cli.mjs，测试可直接 import）
src/
  zstd-frames.mjs            帧边界扫描（不含解压）
  zstd-decode.mjs            逐帧解压 + 容错记账 + 天真做法对照物
  ticket-events.mjs          16 种事件的定义与解析（含 declaredEventCount 对账）
  ticket-stage.mjs           8 阶段状态机（有序规则表）
  timeline.mjs               两类源 → 统一条目 → 全序排序
  redact.mjs                 稳定假名
  redact-audit.mjs           泄露断言 / 对照表导出 / 逆转
  render-text.mjs            终端时间线（等宽、CJK 按 2 列、NO_COLOR）
  render-html.mjs            单文件 HTML（数据内联、零外链）
  cli.mjs                    SPEC 驱动的子命令与 JSON 出口
fixtures/                    3 份**合成** Ticket 事件流 + README（声明非真实日志）
examples/                    3 份已生成好的单文件 HTML（双击即看）
test/                        node:test 用例（6 个 *.test.mjs，共 49 例）+ helpers.mjs
verify/                      分阶段验收脚本（11 个 check-*.mjs）
```

---

## 8. 测试怎么跑

```bash
npm test      # node --test → 49 个用例，全绿；不需要网络、不需要安装依赖
npm run verify # 11 个验收脚本 → 397 条断言，全绿（含真实会话日志用例）
```

- 真实样本用例在**文件缺失时 `skip` 而非 `fail`**（把 `USERPROFILE` 指到空目录复跑：49 tests / 42 pass / 0 fail / **7 skipped**，退出码 0）；
- 断网可跑：`test/`、`src/`、`verify/lib/` 共 19 个文件里**没有任何** `http/https/net/tls/dns/fetch` 引用；
- 断言一律用 `node:assert/strict`，失败信息自带 `actual` / `expected`（例如 `actual:"实际值" expected:"期望值" operator:"strictEqual"`）。

---

## 9. 12 小时时间盒：做了什么 / 故意没做什么

**做了**

1. 多帧 zstd 的**帧边界扫描 + 逐帧解压 + 容错记账**（截断 / 垃圾 / 零帧都不崩）；
2. Ticket 事件流解析（16 种事件、`declaredEventCount` 对账、可读错误定位到「第 N 条事件缺 X」）；
3. **8 阶段状态机**（有序规则表 + 三条优先级反例 + 人类消息解除 blocked）；
4. 两类源 → **统一时间线条目**，三项全序（`atMs` → 源优先级 → 序号），排序与输入顺序无关；
5. **稳定假名脱敏**（路径 / 邮箱 / 令牌 / 用户名 / IPv4）+ 对照表导出/逆转 + 泄露断言（三条出口——终端 / JSON / HTML——都过同一套）；
6. 终端时间线（100 列不错行、列宽恒等、`NO_COLOR` 生效）；
7. **单文件 HTML**（数据内联、零外链、深浅色、阶段/类别/仅人类介入筛选、原始事件折叠）；
8. CLI 三子命令 + 机读 JSON 出口 + 中文错误提示（无裸堆栈）；
9. 3 份**合成** fixture（完成 / 阻塞恢复 / dropped 后唤醒）+ 目录声明；
10. `node:test` 49 用例 + `verify/` 397 条断言。
11. **`unmap` 子命令**（把脱敏文本还原，命令行闭环）+ **`session --only person|assistant|tool|turn`** 过滤 + **`--raw`** 不折叠。

**故意没做（以及为什么）**

- ❌ **不做实时尾巴**（`--follow`）：时间盒内它只增加并发与文件轮转的复杂度，不增加「看懂一条时间线」的价值；
- ❌ **不接 dsh-superagent 运行时**：本机没有它的运行数据，硬接就是编；
- ❌ **不做跨会话关联 / 因果图**：需要 Ticket↔Session 的真实外键，我没有可靠样本；
- ❌ **不做 Web 服务 / 数据库**：单文件 HTML 已经满足「双击可看、可发给别人」；
- ❌ **不做大文件流式解压**：现在整文件进内存（最大样本 110 MB 能跑，但没有增量解码）；
- ❌ **没做 IPv6 / 内网域名泛化**：IPv4 已脱敏，IPv6 长地址与裸内网域名仍原样留（见 §10）；
- ❌ **没有为 Windows 打包 `.exe`**：Node 脚本 + `npm test` 已足够复现。

---

## 10. 已知边界（诚实交代）

- **fixture 是合成的**：`fixtures/` 三份 Ticket 事件流由本作品作者按 003 语义手写，**不是真实日志**，
  不对应任何真实会话 / 用户 / 仓库（目录 README 与每份文件内 `_synthetic` 字段都写了这句）。
  真实数据只有 `session` 子命令读的本机 `.zstd`。
- **脱敏覆盖五类，不含 IPv6**：路径 / 邮箱 / 令牌 / 用户名 / **IPv4**（含 `10.8.0.14:6379` 这种带端口的，端口保留）都会换假名；
  IPv6 长地址与裸内网域名**仍会原样留**，要覆盖得再扩 `src/redact.mjs` 的 `TEXT_RULES`。
- 时间戳按 UTC 显示（`at` 字段原样是 ISO-8601 UTC）。
- HTML 版与终端版的**摘要文案是两套**（终端要短、HTML 可长），但阶段与时长同源。
- `stats()` / `entries()` 每次调用是 O(n)，**不要在循环里反复调**（会退化成 O(n²)，我踩过）。

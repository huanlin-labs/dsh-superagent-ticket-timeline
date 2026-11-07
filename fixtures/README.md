# fixtures —— **合成数据，不是真实日志**

⚠️ 本目录下三份 `ticket-*.json` **全部是手工编排的合成数据**：

- 由本作品作者按 `dsh-superagent-prototype/docs/003-execution.md` 的事件语义逐条手写，
  **不对应任何真实会话、真实 Ticket、真实用户或真实仓库**；
- 项目名、工单号、IP、路径、邮箱、令牌**都是编的**，唯一目的是让脱敏功能有东西可演；
- 本机从未跑过 dsh-superagent 运行时，**没有任何真实 Ticket 数据参与生成**；
- 三份文件的 `_synthetic` 字段里也各写了一遍同样的声明（防止单独传出去后失去上下文）。

真实 DSH 侧的输入在另一个子命令里：`ticket-timeline session <session.v*.jsonl.zstd>`
读的是本机 `~/.dsh/sessions/` 下真实的多帧 zstd 会话日志——那才是真数据。

---

## 三份 fixture 各自考什么

| 文件 | 剧情 | 考查点 | 终态 |
|---|---|---|---|
| `ticket-happy.json` | 建单 → 派发 → 两次 progress → 人类给阈值 → ready → 结束 | 顺利到底的基线；无阻塞无重派 | `outcome=completed`，末段 `person/review`，1 个 assignment |
| `ticket-blocked-retry.json` | 建单 → progress → **blocked（缺凭据）** → 人类给地址 → progress → ready → 结束 | 阻塞被人话解除、回到 working 再 ready | `outcome=completed`，**经过 `person/blocked` 后恢复到 ready**，1 个 assignment |
| `ticket-dropped-resumed.json` | 建单 → progress → **dropped（超时盒）** → 隔夜人类消息唤醒 → 重新派发 as-2 → progress → ready → 由人结束 | 掉线后被人类消息唤醒续跑 | `outcome=completed`，**`report.dropped` 之后由人唤醒**，2 个 assignment，`by=human` |

「终态」在本作品里的口径（三份都按它判）：
`ticket.ended.outcome` + 末段 stage（`stageAt` 算出的最后一个阶段）+ 关键转折（是否经过 blocked / dropped、assignment 个数）。

## 埋进去的敏感串（供脱敏演示，全部是假的）

| 类型 | 出现位置 | 字面值 |
|---|---|---|
| Windows 路径 + 用户名 | `ticket-happy.json` 第 5 条 progress | `C:\Users\zhaorui-wu\项目\导出模块\index.ts` |
| Windows 路径 | `ticket-dropped-resumed.json` 第 8 条 progress | `D:\工作区\实习\产出\归档脚本\run.ps1` |
| 邮箱 | `ticket-blocked-retry.json` 第 5 条人类消息、`ticket-dropped-resumed.json` 第 9 条 ready | `zhaorui-wu@example.com` |
| 访问令牌 | `ticket-blocked-retry.json` 第 5 条人类消息 | `ghp_9f8e7d6c5b4a3210` |
| IP + 端口 | `ticket-blocked-retry.json` 第 5 条人类消息 | `10.8.0.14:6379` |

演示脱敏：

```bash
node bin/ticket-timeline.mjs ticket fixtures/ticket-blocked-retry.json --no-color
node bin/ticket-timeline.mjs ticket fixtures/ticket-blocked-retry.json --json > /tmp/x.json
node bin/ticket-timeline.mjs render --in /tmp/x.json --out /tmp/x.html
```

## 与真实事件流的差别（诚实交代）

- 时间戳是**均匀偏稀疏**的手工编排，真实日志里同一毫秒可能挤好几条；
- 只有一条工作线的故事，真实 Ticket 会有更多 `attention.raised` / `delivery.failed` 之类的岔路；
- `declaredEventCount` 字段是本作品解析器的对账钩子（数量不符即报错），
  **003 文档里没有要求真实日志带这个字段**——真实数据缺它也能跑。

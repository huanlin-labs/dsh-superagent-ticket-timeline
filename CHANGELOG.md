# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号用 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] — 2026-11-07

首个公开版本。零依赖 Node CLI：把 dsh-superagent 的 Ticket 事件流或 DSH 多帧 zstd 会话日志，变成可直读的时间线（终端 / 单文件 HTML / JSON 三条出口），全程脱敏。

### 新增
- `ticket <fixture.json>`：读 Ticket 事件流，输出「概览 + 逐事件时间线 + 三行结论」（起点→终点 / 卡点 / 结果）。
- `session <file.zstd>`：读 DSH 会话日志，**多帧**扫描 + 逐帧解压 + 事件投影；默认折叠低信息事件并显示折叠条数。
- `render --in <json> --out <html>`：把 JSON 产物渲染成**零外链单文件 HTML**（深色/浅色随系统）。
- `unmap --in <redacted.txt> --map <mapping.json>`：用对照表把已脱敏文本还原成真值（`--unmap` 的命令行闭环）。
- `--only person|assistant|tool|turn` 与 `--raw`：只看某一类事件 / 不折叠。
- 稳定假名脱敏：路径、邮箱、令牌、用户名、**IPv4**（端口保留）；`--map-out` 导出对照表，`--unmap` 可逆。
- 8 阶段规则表（`person/delivery` → `person/answer` → `person/review` → `person/blocked` → `person/failed` → `working/queued` → `idle` → `working`），首条命中即止。

### 已验证
- `npm test`：**49 用例**全绿（`node --test`，零第三方依赖）。
- `npm run verify`：**397 条断言**全绿（11 个 check 脚本）。
- 多帧实测：真实样本 `414,456 B / 2 帧` → `2,205,320 字节 = 1,976,071 字符`；整段解压只得 `240 字符`（差约 8,233 倍）。极端样本 `110,151,963 B / 17,952 帧`。
- 脱敏三出口（终端 / JSON / HTML）实测敏感串 0 命中；`unmap` 往返逐字节相同。

### 已知限制
- 只脱敏 **IPv4**：IPv6 长地址与裸内网域名仍原样保留。
- `fixtures/` 三份是**手写合成**数据（带 `_synthetic` 标记），不是真实日志。
- 不接 dsh-superagent 运行时：只读离线文件（事件流 JSON / 会话日志 zstd）。
- `--only` 只支持单值；没有 `--grep`、没有实时 tail、没有流式解压。

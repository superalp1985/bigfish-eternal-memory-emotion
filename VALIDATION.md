# BigFish for DeepSeek Harness：实测记录 / Validation

本文记录的是原来的完整 BigFish 应用，不包含 WorkBuddy 原生插件的验收。
WorkBuddy 的实装记录见 [docs/WORKBUDDY.md](docs/WORKBUDDY.md)。

以下记录来自 2026-11-03 的文本版本验证。Windows，Node 24.22.1，DSH 0.2.1-rc.2，
dsh-dafeiyu 0.1.23。使用隔离会话、虚构人物和测试约定。

2026-11-04 的 DSH 0.2.2-alpha.3、多模态原件和扩大记忆预算更新按用户要求未重新运行测试；不要把下列旧版数字当作新附件路径的验证结果。

## 真实长对话

| 项目 | 结果 |
| --- | --- |
| 对话量 | 80 轮，160 条消息，11,227 个字符 |
| 默认容量 | 600 条事件 / 64,000 字符；近期内容预算 16,000 字符 |
| 自动压缩 | 19 次；未调用手动压缩 |
| 压缩后活动内容 | 14,179–20,977 字符 |
| 每轮结束时的工作区 | 均在配置预算内 |
| 回忆检查 | 12/12 个预设检查通过 |
| 第 40 轮后重启 | 同 session ID、情感、工作快照、统计一致 |
| 启动 / 读取会话 | 1,880 ms / 4 ms |
| 第 70 轮后备份恢复 | 140 ms；状态一致；继续完成 10 轮 |
| FAME 记录 | 双方各 80 条，共 160 条 |
| 原文核对 | 160 条逐条匹配，无丢轮和重复消息 |
| 原生角色联动 | 80 次回复完成信号 |
| 每轮总处理延迟 | 中位数 4,095 ms；P95 15,373 ms |

预设回忆检查覆盖称呼、茶口味更正、项目改名、时间调整、暗号更新、
手账原话和物件细节。检查使用回复中的预设匹配条件，完整回复可供人工复核；
它不是开放问题的通用准确率评估。

第 1、41、71、80 轮通过真实网页输入框发送，其余通过同一服务器的本地
聊天接口发送。全部回复来自真实模型调用。截图为实际测试页面。

- [完整中文对话](docs/validation/conversation.zh-CN.md)
- [逐轮指标与检查结果](docs/validation/metrics.json)
- [桌面截图](docs/assets/conversation-desktop.png)
- [小屏截图](docs/assets/conversation-mobile.png)

## 内存采样

| 轮次 | JS 堆 MiB（GC 后） | 进程驻留内存 MiB |
| --- | --- | --- |
| 1 | 88.08 | 283.20 |
| 20 | 90.16 | 181.79 |
| 40 | 88.92 | 199.50 |
| 41 | 88.33 | 291.77 |
| 60 | 88.73 | 193.62 |
| 70 | 88.95 | 201.04 |
| 71 | 88.75 | 199.11 |
| 80 | 89.16 | 223.61 |

第 40 轮之后按计划重启；表中覆盖两段独立进程。JS 堆和驻留内存是不同指标。
这是有限场景下的采样，不证明无限时长的资源上界。

## 自动测试

53 项存储与 API 测试、30 项真实 DSH 核心集成测试通过。集成测试使用确定性模型流。
覆盖归档、检索隔离、中文长查询、压缩、同 ID 重建、缓存、
FAME、备份验证、恢复、自动重试、位置迁移及边界异常。

```powershell
# Install.cmd 完成运行环境安装后，在仓库根目录执行
$env:PATH = "$PWD\runtime\node;" + $env:PATH
node --test tests/*.test.mjs
node --expose-gc --test tests/dsh.integration.mjs
```

复用已有 DSH 时，请使用该安装目录里的 Node 24。

堆回收用例中，活动日志从 572 条变为 9 条，释放约 4.19 MB，
WeakRef 确认旧 Agent 和 Session 已被回收。LRU 用例创建 24 个会话，
同时加载上限设为 2，峰值为 2，并确认 22 个旧 Agent 被回收。

## 界面与迁移

Playwright + Edge 检查桌面 1440×960 和小屏 390×844。
页面无横向溢出、图片缺失或运行时错误。

独立迁移实测还覆盖了完整 Windows ZIP：在另一个目录解压安装，
使用包内运行环境恢复原会话，保留记忆和双方情感，并继续真实模型对话。
该项与上面的 80 轮测试是独立实验。

源码安装在一份没有预装运行环境的独立目录中验证：从官方源下载并校验
Node 24.22.1，安装指定版本的 DSH 与角色组件，启动服务并通过接口创建
记忆会话。没有复用原项目的 node_modules、运行环境或会话库。

## 测试范围

原始 DSH Agent 核心和日常会话没有改动。历史保存在插件自己的 SQLite 库。
这次旧版验证当时不包含外部附件迁移、Windows 注销登录和无限时长运行。附件路径已在 2026-11-04 加入，但按用户要求未重新运行验证，因此不把它计入上述结论。

## English

The completed live scenario used 80 turns and 160 messages, with 19 automatic
compactions under the default budgets. All 12 scheduled recall checks passed.
The same session, emotional states and working snapshot survived the planned
restart and backup restore. Raw messages were compared individually with the
sent prompts and actual replies.

The automated suites passed 53 storage/API tests and 30 DSH integration tests.
The integration suite uses real DSH core objects with deterministic model streams.
The live model scenario is separate. See the linked transcript and metrics for
the precise test scope; the results do not establish perfect recall or unlimited runtime.

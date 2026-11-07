# 图片与素材

README 中的 `cover.svg`、`apps-overview.svg`、`install-flow.svg`、`workbuddy-architecture.svg`、
`continuity.svg`、`emotions.svg`、`architecture.svg`、`validation.svg` 和
`migration.svg` 为本项目原创矢量排版与信息图。
结构图是工作机制示意；指标图取自 2026-11-03 完成的 80 轮实测。

`apps-overview.svg` 同时作为 README 首屏，说明“一套共享记忆内核、两个应用入口”：原
BigFish for DeepSeek Harness 与 BigFish for WorkBuddy 分别安装、分别使用
数据目录，不能把两者误认成同一个入口。

`install-flow.svg` 描述 WorkBuddy 原生插件的三步安装路径。
`workbuddy-architecture.svg` 描述 Hooks 旁路归档、MCP 按需召回、
SQLite 与 SHA-256 媒体库之间的关系。两者都是架构示意，不是宿主界面截图。

`conversation-desktop.png` 和 `conversation-mobile.png` 是真实测试界面截图，
显示的是专门构造的虚构人物、偏好和约定。截图不是 AI 生成的界面效果图。

界面中的角色缩略图来自随 `dsh-dafeiyu@0.1.23` 分发的 dsh-pet 素材。
保留上游来源说明与许可：

- [上游素材说明原文](../public/BIGFISH_ASSET_LICENSE.md)
- [dsh-pet MIT 许可](../public/dsh-pet-LICENSE.txt)
- [dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu)
- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)

本项目没有将上游说明中的历史限制素材作为新的 README 插画重新分发。

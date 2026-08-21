# zcode-relay 工程入口

zcode-relay 是我们的 ZCode 代理产品工程。

当前组成：

- 根目录：zcode-api 运行时核心，负责协议接入、请求转换、SSE、Responses、MCP 和上游转发。
- panel/zcode2api/：管理面板来源，负责账号池可视化、运行状态、额度和策略控制。
- readme/：本项目的上下文、路线图、工程契约、变更账本和验证证据。

## 恢复顺序

1. 阅读 DEVELOPMENT.md。
2. 阅读 CONTEXT.md。
3. 阅读 agents/engineering-contract.md。
4. 阅读 plans/current-roadmap.md。
5. 从 logs/change-ledger.md 恢复最近变更和验证状态。
6. 以源码、测试、配置和真实运行结果为最终依据。

## 来源

| 组件 | 来源 | 纳入提交 |
|---|---|---|
| 核心 | https://github.com/TriDefender/zcode-api.git | f6aa1471b858a2d6a3c1a2fcd77019d319b94613 |
| 面板 | https://github.com/liu5269/zcode2api.git | 925e929ccb9dddc6c9aa73b30d369090f1e59722 |

两个来源分别保留为 Git remote：upstream-core 与 upstream-panel。

## 安全边界

不把 API Key、JWT、Cookie、OAuth token、生产配置、账号数据库或真实请求体写入 Git、日志、测试夹具和报告。


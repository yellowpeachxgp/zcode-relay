# zcode-relay 变更账本

## 2026-08-22：建立组合仓库与工程契约

- 操作：从 TriDefender/zcode-api 克隆核心，基线为 f6aa1471b858a2d6a3c1a2fcd77019d319b94613。
- 操作：通过 Git subtree 纳入 liu5269/zcode2api 到 panel/zcode2api，来源为 925e929ccb9dddc6c9aa73b30d369090f1e59722。
- 操作：添加 upstream-core、upstream-panel 和自有 origin 远程。
- 决策：核心拥有账号池和运行状态，面板只通过内部控制 API 管理。
- 约束：主线程完成全部工作，不使用 subagent。
- 证据：git log --graph、git remote -v、git status --short --branch。
- 未完成：账号池、故障转移、控制 API、面板适配和全量验证。


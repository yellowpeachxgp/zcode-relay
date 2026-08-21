# zcode-relay 变更账本

## 2026-08-22：建立组合仓库与工程契约

- 操作：从 TriDefender/zcode-api 克隆核心，基线为 f6aa1471b858a2d6a3c1a2fcd77019d319b94613。
- 操作：通过 Git subtree 纳入 liu5269/zcode2api 到 panel/zcode2api，来源为 925e929ccb9dddc6c9aa73b30d369090f1e59722。
- 操作：添加 upstream-core、upstream-panel 和自有 origin 远程。
- 决策：核心拥有账号池和运行状态，面板只通过内部控制 API 管理。
- 约束：主线程完成全部工作，不使用 subagent。
- 证据：git log --graph、git remote -v、git status --short --branch。
- 未完成：故障转移、控制 API、面板适配和全量验证。

## 2026-08-22：完成核心账号池最小状态机

- 修改：新增 src/auth/pool-types.ts 和 src/auth/pool.ts。
- 行为：按 provider round-robin，支持租约、最大并发、禁用、冷却、额度耗尽、认证失效和 challenge 状态。
- 安全：账号快照只返回 credentialMasked，测试确认完整假凭据不会出现在 JSON。
- 验证：bun test src/auth/pool.test.ts，4 pass、0 fail。
- 未完成：AuthManager 接入、请求故障转移、控制 API、面板适配和全量验证。

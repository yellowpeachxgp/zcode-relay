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

## 2026-08-22：AuthManager 接入账号租约

- 修改：AuthManager 支持注入 AccountPool，并增加 acquireCredential。
- 兼容：无账号池时保留原有单凭据 getCredential 行为；账号池模式要求显式使用租约。
- 安全：控制面可获得账号池对象，但账号快照仍只返回脱敏凭据。
- 验证：bun test src/auth/pool.test.ts src/auth/manager.test.ts，23 pass、0 fail；bun x tsc --noEmit，退出码 0。
- 未完成：请求故障转移、控制 API、面板适配和全量验证。

## 2026-08-22：接入代理请求级账号故障转移

- 修改：新增 `src/proxy/failover.ts` 与 `src/proxy/failover.test.ts`；代理 handler 在每个上游尝试前按租约重建凭据、请求头和请求对象。
- 行为：对 401、402、429、5xx 和网络异常按账号标记并切换；客户端 4xx 不切换；响应流完成或提前结束时释放租约。
- 安全：调试与控制路径继续使用现有脱敏逻辑，不返回完整凭据。
- 验证：`bun test src/proxy/failover.test.ts`，4 pass、0 fail；包含真实 `proxyRequest` 链路的 429→第二账号回归；`bun x tsc --noEmit` 退出码 0；`git diff --check` 通过。
- 未完成：内部控制 API、面板适配、持久化、全量验证和推送。

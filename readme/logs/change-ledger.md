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

## 2026-08-22：完成核心控制 API 与加密账号持久化

- 修改：新增 `src/server/internal-routes.ts`；接入独立控制密钥、账号增删改、启用/禁用、运行摘要、用量摘要、重复凭据幂等和脱敏响应。
- 修改：新增 `src/auth/account-store.ts`，使用 AES-GCM 加密账号凭据，文件权限为 `0600`；核心启动时恢复账号池，管理变更后持久化。
- 修改：`control.enabled`、`control.adminKey`、账号存储路径、冷却时间和并发策略进入配置；公开代理密钥与控制密钥禁止复用。
- 验证：`bun test src/auth/account-store.test.ts src/server/internal-routes.test.ts src/server/server.test.ts src/config/loader.test.ts`，47 pass、0 fail；核心真实进程冒烟验证控制鉴权、创建、运行摘要和脱敏列表通过。
- 未完成：面板核心客户端、Compose、核心全量验证和推送。

## 2026-08-22：zcode2api 切换为核心控制面适配

- 修改：新增 `panel/zcode2api/app/core_client.py`；核心模式下管理 API 和 `/v1/messages`、`/v1/models` 均经核心转发，核心不可用明确返回 503。
- 安全：面板核心模式跳过本地账号额度轮询，不导出或导入本地凭据；核心账号凭据只在核心加密存储中保存。
- 修改：新增 `docker-compose.zcode-relay.yml`、核心/面板健康检查和私有服务网络；Compose 使用环境变量注入密钥，不把密钥写入仓库。
- 验证：面板核心客户端 `pytest`，4 pass、0 fail；`python3 -m compileall -q panel/zcode2api` 通过；临时环境变量下 `docker compose -f docker-compose.zcode-relay.yml config` 通过；核心定向回归 101 pass、0 fail；`bun x tsc --noEmit` 和 `git diff --check` 通过。
- 验证补充：修正集成测试使用不存在的 `config.test.yaml`，改用仓库内 `config.example.yaml` 作为测试模板；补齐 Responses 路由账号池接入和 token usage 累计；`bun test` 全量为 526 pass、0 fail；真实核心进程再次验证无鉴权 `/health` 与控制 `/internal/runtime` 均 200；真实上游专用账号验证仍不执行。
- 未完成：provider quota 周期刷新、独立控制 listener 和远程推送。

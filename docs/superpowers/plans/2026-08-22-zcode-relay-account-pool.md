# zcode-relay Account Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan on the main thread with test-driven development and verification checkpoints. Do not use subagents.

**Goal:** 将 zcode-api 的单凭据运行时扩展为按 provider 隔离的多账号池，并让 zcode2api 面板通过内部控制 API 管理核心。

**Architecture:** 在 src/auth/ 增加核心账号池与持久化边界，把 AuthManager 改成按请求解析账号租约；src/proxy/handler.ts 在可重试错误时释放并切换账号，同时保留现有协议转换；src/server/ 增加独立鉴权的内部控制路由。面板新增 Python 核心客户端，在配置开启时把账号与状态请求转发到核心。

**Tech Stack:** Bun 1.3、TypeScript、Node HTTP、Bun test、FastAPI、Python 3、SQLite、Docker Compose。

---

### Task 1: 核心账号池领域模型

**Files:**
- Create: src/auth/pool-types.ts
- Create: src/auth/pool.ts
- Test: src/auth/pool.test.ts

- [ ] 写失败测试，覆盖同 provider round-robin、禁用/冷却跳过、租约释放和 provider 隔离。
- [ ] 运行 bun test src/auth/pool.test.ts，确认因模块不存在或行为缺失失败。
- [ ] 实现最小 AccountPool：add、list、remove、setEnabled、acquire、release、markFailure、markSuccess。
- [ ] 为账号定义 active/cooling/exhausted/invalid/challenge/disabled 状态，并保证失败状态不会跨 provider 污染。
- [ ] 运行针对性测试并确认通过。
- [ ] 提交 feat: 增加核心账号池领域模型。

### Task 2: AuthManager 接入账号租约

**Files:**
- Modify: src/auth/manager.ts
- Modify: src/auth/types.ts
- Test: src/auth/manager.test.ts

- [ ] 先新增失败测试，证明 manager 能按 provider 返回下一个租约，而不是固定同一凭据。
- [ ] 运行 bun test src/auth/manager.test.ts，确认新测试失败。
- [ ] 保留单账号构造兼容行为，将内部凭据源抽象为 CredentialPool。
- [ ] 新增 acquireCredential(provider) 和租约释放接口，避免公开路由直接依赖账号存储实现。
- [ ] 运行 manager、pool 测试和原有 auth 测试。
- [ ] 提交 feat: 让认证管理器支持账号租约。

### Task 3: 请求故障转移与 usage 事件边界

**Files:**
- Modify: src/proxy/handler.ts
- Modify: src/server/routes-anthropic.ts
- Modify: src/server/routes-openai.ts
- Modify: src/server/routes-responses.ts
- Test: src/proxy/failover.test.ts
- Test: src/integration.test.ts

- [ ] 写失败集成测试：第一个假上游账号返回 429 或 5xx，第二个账号成功；401 客户端错误不触发切换；流式响应头发送后不切换。
- [ ] 运行定向测试确认失败原因是缺少账号池接入。
- [ ] 把一次请求的账号租约传入现有 proxy handler，成功、异常、abort 和响应流结束都释放租约。
- [ ] 只对可重试错误执行下一账号；保持原有转换器和 SSE 输出不变。
- [ ] 记录输入/输出 token usage 的统一事件接口，暂不把 quota 探测混入请求成功判定。
- [ ] 运行核心相关集成测试和类型检查。
- [ ] 提交 feat: 增加代理请求故障转移。

### Task 4: 核心内部控制 API

**Files:**
- Create: src/server/internal-routes.ts
- Modify: src/server/server.ts
- Modify: src/config/types.ts
- Modify: src/config/loader.ts
- Test: src/server/internal-routes.test.ts

- [ ] 写失败测试覆盖内部密钥、账号列表脱敏、创建/删除、启用/禁用和 runtime summary。
- [ ] 运行测试确认内部路由尚未存在。
- [ ] 实现独立内部路由和 JSON 合同；秘密只允许写入，不允许读取。
- [ ] 增加 control 配置：监听地址、端口、管理密钥和是否启用。
- [ ] 将核心账号池、策略和健康快照挂入 server options。
- [ ] 运行定向路由测试、核心全量测试和类型检查。
- [ ] 提交 feat: 增加核心内部控制 API。

### Task 5: zcode2api 远程核心适配

**Files:**
- Create: panel/zcode2api/app/core_client.py
- Modify: panel/zcode2api/app/settings.py
- Modify: panel/zcode2api/app/routes/admin_api.py
- Test: panel/zcode2api/tests/test_core_client.py
- Create: panel/zcode2api/requirements-dev.txt

- [ ] 写失败 Python 测试，覆盖核心请求鉴权、账号列表映射、创建和核心不可用错误。
- [ ] 运行 python3 -m pytest panel/zcode2api/tests/test_core_client.py -q，确认测试因适配器不存在而失败。
- [ ] 实现短超时 HTTP client，配置 ZCODE_CORE_URL、ZCODE_CORE_ADMIN_KEY 和启用开关。
- [ ] 在核心模式下让 admin API 的账号、状态、刷新、增删改和启禁用调用核心；禁止静默回退到本地流量代理。
- [ ] 运行 Python 编译检查、适配器测试和面板已有可执行检查。
- [ ] 提交 feat: 接入 zcode 核心控制面。

### Task 6: Compose、文档和发布门禁

**Files:**
- Create: docker-compose.zcode-relay.yml
- Modify: README.md
- Modify: readme/plans/current-roadmap.md
- Modify: readme/logs/change-ledger.md
- Create: readme/analysis/2026-08-22-phase1-verification.md

- [ ] 写 Compose 配置验证和配置样例，不包含真实密钥。
- [ ] 增加核心与面板健康检查、内部网络和数据卷。
- [ ] 运行 docker compose -f docker-compose.zcode-relay.yml config、git diff --check、核心测试、类型检查和面板检查。
- [ ] 记录每个命令的退出码、测试数量和已知限制。
- [ ] 使用中文提交信息提交阶段成果。
- [ ] 添加自有 origin 后推送 master，并核对本地与远程 SHA。


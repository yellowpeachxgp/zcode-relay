# zcode-relay 账号池与控制面设计

日期：2026-08-22

## 目标

将 zcode-api 从单账号代理扩展为可运营的多账号核心，并把
zcode-relay 管理面板作为可视化控制面。用户请求只进入核心，面板只读取和修改核心状态。

## 基线事实

- 核心来源：TriDefender/zcode-api，master，提交
  f6aa1471b858a2d6a3c1a2fcd77019d319b94613。
- 面板来源：liu5269/zcode2api，master，提交
  925e929ccb9dddc6c9aa73b30d369090f1e59722。
- 核心当前的 AuthManager 只保存一个 Credential。
- 核心请求处理在 src/proxy/handler.ts，公开路由在 src/server/server.ts。
- 面板当前在 panel/zcode2api/app/store.py 保存本地账号并由
  panel/zcode2api/app/routes/admin_api.py 提供管理 API。

## 架构

    管理员浏览器
        │
        ▼
    zcode-relay 管理面板
        │  内部管理密钥
        ▼
    zcode-api 控制路由 ── AccountPool ── Usage/Health
        │
        ▼
    现有 Proxy Handler / Translators / SSE
        │
        ▼
    Z.AI 或 BigModel

核心负责：

- 凭据持久化和解密；
- provider 维度账号池；
- 账号选择、租约、轮询、冷却和状态；
- 请求成功/失败统计；
- 账号级额度快照；
- 现有协议转换和上游转发。

面板负责：

- 账号新增、删除、启用和禁用；
- 运行状态和用量展示；
- 调度策略、刷新周期和核心连接配置；
- OAuth 交互入口；
- 不代理用户流量，不直接访问上游凭据。

## 账号模型

核心账号字段：

    id
    provider: zai | bigmodel
    credential: encrypted credential record
    mode: apikey | oauth
    enabled
    status: active | cooling | exhausted | invalid | challenge | disabled
    coolingUntil
    lastSuccessAt
    lastFailureAt
    lastErrorClass
    requestCount
    failureCount
    usage: inputTokens/outputTokens/updatedAt
    quota: provider-specific redacted snapshot
    createdAt
    updatedAt

核心响应永远只返回 credentialMasked，不返回原始秘密。

## 请求流程

1. 公开路由识别 provider 和客户端格式。
2. AccountPool 按 provider、启用状态、健康状态和冷却时间筛选账号。
3. 创建租约，按 round-robin 或策略权重选择账号。
4. 复用现有 proxyRequest() 构造请求、转换 body、注入上游认证和转发流。
5. 根据 HTTP 状态、错误类型和流结束状态更新账号。
6. 只有可重试的上游错误才切换下一个账号。
7. 成功响应释放租约并记录请求 usage；客户端断开也必须释放租约。

不可重试：

- 客户端鉴权失败；
- 请求体非法；
- 模型或参数错误；
- 已经向客户端发送响应头后的流式中断。

可重试：

- 上游 401/403 且确认是账号凭据失效；
- 402 或明确额度耗尽；
- 429；
- 建连失败、连接重置和上游 5xx。

验证码、WAF challenge 单独进入 challenge，不直接等价于 invalid。

## 内部控制 API

控制 API 与公开代理鉴权分离，默认关闭并要求独立管理密钥。核心启动后控制 API 绑定独立 listener，公开 listener 不再暴露 `/internal/*`；Compose 中控制 listener 只在服务网络内可达，不能复用公开代理密钥。

    GET    /internal/health
    GET    /internal/runtime
    GET    /internal/accounts
    POST   /internal/accounts
    PUT    /internal/accounts/:id
    DELETE /internal/accounts/:id
    POST   /internal/accounts/:id/enable
    POST   /internal/accounts/:id/disable
    POST   /internal/accounts/:id/check
    POST   /internal/accounts/check
    GET    /internal/usage/summary
    GET    /internal/usage/accounts/:id
    GET    /internal/policy
    PUT    /internal/policy
    POST   /internal/runtime/reload

控制 API 的写请求具有幂等语义：

- 重复新增相同凭据返回已存在账号，但不返回秘密；
- 重复启用或禁用返回当前状态；
- 删除不存在账号返回明确的 404；
- 刷新额度失败只更新检查状态，不删除账号。

## 面板适配

第一阶段在面板中增加核心客户端模块，使用
ZCODE_CORE_URL 和 ZCODE_CORE_ADMIN_KEY 连接核心。面板的账号、状态和刷新接口优先调用核心；面板 SQLite 只保存面板配置和连接信息，不保存第二套运行时账号状态。

当核心连接不可用时，面板必须显示“核心不可用”，不能悄悄回退到本地账号池继续对外提供流量。

OAuth 约束：OAuth auth-code、token exchange、Coding Plan API Key 解析和账号池写入全部由核心完成。面板只保存 flow id，承接 provider 回调后转发 `code/state` 到核心；access token、JWT 和 API Key 不经过面板响应，也不写入面板 SQLite。

## 持久化与安全

- 核心使用本地 AES-GCM 加密文件存储，账号凭据由控制密钥派生加密密钥；运行期状态保存在 AccountPool，凭据和启停状态在管理变更时持久化。
- quota monitor 按 provider 配置的 billing balance endpoint 周期巡检，余额耗尽会进入 exhausted，恢复后重新进入 active；未配置 endpoint 的 provider 保持 unknown，不伪造额度。
- 数据目录必须可挂载，数据库文件权限限制为服务用户。
- 日志只记录账号 ID、provider、状态和错误分类。
- 账号导出默认关闭；如实现导出，必须显式管理鉴权并全程脱敏。
- 管理密钥与公开代理密钥分离。

## 测试策略

必须有：

- 账号池状态和轮询单元测试；
- 租约释放和并发限制测试；
- 失败分类与切换测试；
- 控制 API 脱敏和鉴权测试；
- 公开路由接入账号池的集成测试；
- 面板核心客户端的 HTTP 契约测试；
- 核心原有测试和类型检查。

真实上游只在专用环境使用可撤销测试账号执行，不进入 CI，不进入仓库。

## 分阶段交付

### 阶段 1

账号池、轮询、租约、失败分类、核心控制 API 和面板客户端基础。

### 阶段 2

请求 usage、账号 quota、周期刷新、健康探针和面板统计。

### 阶段 3

面板页面切换到核心控制 API，Compose 联调，内部认证、配置热加载和灰度路由。

### 阶段 4

生产灰度、回滚、镜像固定、CI 发布和远程 SHA 对账。

## 验收标准

在没有真实凭据的本地测试中，必须证明：

1. 两个同 provider 假账号按轮询顺序被选择。
2. 一个账号遇到可重试错误后，下一账号接管。
3. 不可重试错误不会无意义地消耗账号池。
4. 禁用、冷却和失效账号不会被选择。
5. 租约在成功、失败、异常和客户端取消路径都释放。
6. 控制 API 不返回原始凭据。
7. 现有 Anthropic、OpenAI、Responses 和 SSE 测试行为保持。
8. 面板适配器能正确映射核心的列表、创建、启用/禁用和状态接口。

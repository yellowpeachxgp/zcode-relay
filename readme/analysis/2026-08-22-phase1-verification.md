# zcode-relay 阶段 1 验证报告

日期：2026-08-22

## 交付范围

- 核心 AccountPool：provider 隔离、round-robin、租约、并发限制、冷却、额度耗尽、凭证失效和 challenge 状态。
- 请求级故障转移：401、402、429、5xx、网络异常切换账号；客户端 4xx 不消耗账号池。
- Responses 路由接入账号租约、故障转移和 token usage 累计。
- 内部控制 API：独立管理密钥、账号增删改、启用/禁用、运行摘要、用量摘要、重复凭据幂等和脱敏。
- AES-GCM 加密账号存储：核心启动恢复账号，管理变更后保存，文件权限 0600。
- zcode2api 核心模式：账号管理、模型查询和 `/v1/messages` 流量通过核心；核心不可用明确返回 503，不回退到面板本地池。
- Compose：核心与面板服务、数据卷、健康检查、环境变量密钥注入和网络编排。

## 验证证据

| 检查 | 结果 |
|---|---|
| `bun test` | 526 pass、0 fail，36 个测试文件 |
| `bun x tsc --noEmit` | 通过 |
| `git diff --check` | 通过 |
| `pytest panel/zcode2api/tests/test_core_client.py -q` | 4 passed |
| `python3 -m compileall -q panel/zcode2api` | 通过 |
| `docker compose -f docker-compose.zcode-relay.yml config` | 通过，使用临时测试环境变量 |
| 真实核心进程 `/health` 冒烟 | 200 |
| 真实核心进程 `/internal/runtime` 冒烟 | 正确管理密钥下 200，返回脱敏运行摘要 |
| 账号池真实代理 429 回归 | 第一个账号冷却，第二个账号完成请求 |
| Responses 真实账号池 429 回归 | 第二个账号完成请求并累计 input/output tokens |
| 加密存储回归 | 凭据密文不可读，恢复成功，权限 0600 |

## 安全检查

- 测试和文档没有写入生产凭据、JWT、Cookie 或真实管理密钥。
- 核心 HTTP 响应只返回 `credentialMasked`，控制 API 不提供凭据读取接口。
- 面板核心模式禁止本地账号导入/导出，并关闭本地额度轮询。
- `auth.proxyApiKey` 与 `control.adminKey` 在配置校验中禁止复用。
- Compose 不含实际密钥，只从部署环境变量注入。

## 已知边界

- provider quota/余额探测和周期刷新已实现为可配置的 `QuotaMonitor`；未配置 endpoint 的 provider 保持 `unknown`，不会伪造额度。
- 控制 API 已绑定独立 listener；公开 listener 不暴露 `/internal/*`，Compose 中控制端口仅在服务网络内可达。
- 未使用真实上游账号执行测试，真实凭据不得进入 CI、日志或仓库。
- GitHub 对上游已有的 `Android-APP/.../libnode.so` 大文件给出 50 MB 建议警告，本次未改动该上游资产。

## 追加验证

- `bun test` 在加入 quota monitor 和独立 listener 后为 530 pass、0 fail，37 个测试文件。
- 独立 listener 回归确认：控制端口带管理密钥返回 200，公开端口访问 `/internal/health` 返回 404。

## 发布对账

- 本地分支：`master`
- 自有远程：`origin`
- 远程分支：`origin/master`
- 本次功能提交和远程 SHA：见 `readme/logs/change-ledger.md` 的最终推送门禁记录。

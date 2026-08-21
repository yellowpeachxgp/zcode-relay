# zcode-relay 开发与恢复

## 当前基线

- 工作目录：/Volumes/SN 770/Developer/zcode-relay
- 核心来源：upstream-core
- 面板来源：upstream-panel
- 当前核心基线：f6aa1471b858a2d6a3c1a2fcd77019d319b94613
- 当前面板基线：925e929ccb9dddc6c9aa73b30d369090f1e59722
- 工程策略：主线程独立完成，不使用 subagent。

## 工具链

核心运行时使用 Bun + TypeScript。面板来源使用 Python、FastAPI 和 Node 验证码求解器。

核心基线命令：

    bun install
    bun test
    bun x tsc --noEmit

面板基线命令：

    python3 -m compileall -q panel/zcode2api

面板完整运行需要安装 panel/zcode2api/requirements.txt 和
panel/zcode2api/captcha_node/package-lock.json 对应依赖；真实上游验证需要专用测试账号，不能使用生产凭据。

## 目录边界

- src/auth/：核心凭据类型、OAuth 和账号池。
- src/proxy/：请求转换、上游请求、故障分类和转发。
- src/server/：公开数据面路由和内部控制面路由。
- src/usage/：请求用量、账号额度和健康快照。
- panel/zcode2api/：面板来源及其远程核心适配。
- readme/：工程状态和证据，不保存秘密。

## 工作循环

1. 更新 readme/plans/current-roadmap.md。
2. 先写失败测试，再写最小实现。
3. 每个行为边界运行针对性测试。
4. 运行核心全量测试、类型检查和面板语法检查。
5. 更新 readme/logs/change-ledger.md，记录命令、结果和未解决风险。
6. git diff --check 后提交。
7. 推送后核对本地、远程和 GitHub 的 SHA。


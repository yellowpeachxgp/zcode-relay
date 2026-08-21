# zcode-relay 工程契约

## 工作方式

- 所有分析、设计、代码、测试、提交、推送和验收由主线程完成。
- 不调用 subagent，不把未复核的外部报告当作事实。
- 所有用户可见文字、注释、提交信息和工程文档使用中文；代码标识符保持英文。
- 不覆盖、删除或重置用户已有改动。

## 权威来源

按以下顺序判断事实：

1. 当前工作树源码和测试。
2. 当前运行进程、HTTP 响应和配置。
3. Git 提交、远程 ref 和锁文件。
4. 设计文档和 README。

如果源码和文档冲突，记录冲突并以源码为准。

## 凭据安全

- 不读取、打印、提交或复制真实 API Key、JWT、Cookie、OAuth token。
- 测试只使用形如 test-account-key 的假凭据。
- 日志、报告和 JSON 夹具中只保留凭据类型、长度、哈希前缀或脱敏占位符。
- 账号导出、内部 API 和异常响应不得返回完整秘密。

## 修改与验证

- 新行为遵循 TDD：先写测试，确认测试因行为缺失而失败，再写最小实现。
- 账号池、请求失败分类和控制 API 必须有确定性单元或集成测试。
- 修改后至少运行针对性测试、核心全量测试、TypeScript 类型检查、git diff --check。
- 面板修改至少运行 Python 编译检查；涉及依赖时运行对应测试或明确记录缺口。
- 不能用“看起来正常”替代命令输出和退出码。

## 状态与账本

每轮实质开发必须更新：

- readme/plans/current-roadmap.md
- readme/logs/change-ledger.md
- readme/analysis/ 下必要的代码事实或风险记录

提交前检查：

    git diff --check
    git status --short
    git log -1 --oneline

## 推送门禁

- 只推送到用户明确指定的 origin。
- 推送前确认工作树差异、测试证据和提交范围。
- 推送后核对 git rev-parse HEAD、git ls-remote origin HEAD 和目标分支 ref。


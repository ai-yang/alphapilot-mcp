# 验收记录

日期：2026-09-16。Node v22.14.0；MCP SDK server/client/node 2.0.0。

## 已执行

- 后端与因子 213 项：研究 API、任务运行时、幂等/取消、分页、检查点校验与目录重绑定、实例停止事件、中文日志游标。
- MCP 17 项：所有工具 Schema 和 HTTP 映射、权限/组交集、有限预算、幂等重试、超时/取消、结果上限、两种传输 × 两个协议、凭据隔离/撤销、凭据目录权限与符号链接拒绝、Host/Origin、流式文件传输、中文文件、校验失败时保留目标。
- stdio 和 HTTP 均通过 MCP `2025-11-25`、`2026-07-28` SDK 协议测试。
- 三个实际客户端均完成发现、验证表达式、提交、查询和取消，stdio/HTTP 均通过：

| 客户端 | 实际版本 | 验证方式 |
|---|---|---|
| Codex CLI | 0.154.0-alpha.6.2 | 原生 app-server 的 MCP 调用接口，无模型调用 |
| Claude Code | 2.1.273 | 实际 CLI，本地确定性 Anthropic 工具调用响应，无额外模型费用 |
| DeepSeek Harness MCP 插件 | 0.0.1-rc.1 | 官方 Cordis 插件与 ToolRegistry |

客户端兼容测试使用确定性 HTTP 后端，复现脚本在 acceptance/；不是用模型生成内容来判断协议是否兼容。各自的部署 URL/凭据仍需按实际环境配置。

## 真实 AlphaPilot 验收

通过 MCP stdio 连接迁移后的实际 AlphaPilot 进程和既有数据集 `baostock_cn:day:forward`、股票池 `arena_zz_v1`，由后端配置的真实模型执行一轮自主挖掘。

- 前 3 步任务：`61281090991c436d8c9e3fcb5235c1b4`。
- 检查点续跑后 2 步任务：`99ae1f44e2314ed8b22e90679cbeec20`。
- 完成 1 轮、3 个候选因子、2 个因子入库、1 个策略保存。
- 续跑任务关联 3 个 Run、39 个 Artifact，结果 availability=complete。
- 验证了重复提交同一任务、MCP 退出后任务继续、源 Run 保持不变、SHA-256 和大小校验后下载产物。
- 首次恢复暴露了旧 STOP_EVENT 初始化问题，已修复并补回归测试；失败任务保留为诊断记录。修复后复用同一第三步检查点，仅执行剩余两步，没有重新生成另一轮因子。

详细本地记录位于 AlphaPilot `git_ignore_folder/qa/mcp/mcp-resume-one-round-20260916-135952/report.json`。历史失败记录也保留。真实测试凭据已撤销，测试运行时已停止。

AFF/GP/RL、数据维护、报告提取、模拟信号和调度完成工具契约/映射及权限校验；本次未对这些功能分别运行真实计算。GUI 的共享任务由相同后端任务存储保证，本次未重复执行浏览器视觉验收。

## 交付验证

已生成 alphapilot-mcp-0.1.0.tgz，并在干净目录仅安装生产依赖；安装后的包通过实际 MCP 发现、验证、提交、查询、取消闭环（44 个默认核心工具）。

Docker 镜像 alphapilot-mcp:0.1.0 构建成功；容器内未安装 Python，MCP 调用闭环通过。GUI npm run typecheck、两仓库 OpenAPI SHA-256 一致性检查通过。

共 87 个具名工具，44 个默认核心工具，其他 43 个由部署配置启用。已提供锁定依赖、六份客户端配置模板、Dockerfile、CI 和可复现客户端验收脚本。源码仓库为 https://github.com/ai-yang/alphapilot-mcp；公共 npm 发布尚未执行。

## 本次重新运行的真实验收

2026-09-16 15:00 起重新执行一轮：前三步任务 f16d880a4faa41dbbbc361c5c6ab9c52，续跑任务 ef789eec27d24b4ba4f8462aba233a4e，均成功。3 个候选因子全部入库，1 个策略保存；续跑登记 3 个 Run 和 39 个 Artifact，结果完整。

分别认证的 stdio 和 HTTP 客户端看见相同任务；HTTP 提交的排队回测由 stdio 取消后，HTTP 查询为 cancelled。幂等提交、stdio 断开后继续计算、源运行保持不变、直接下载与 MCP HTTP 网关下载的大小/SHA-256 一致性均通过。

本次发现公共 AST 漏掉一元负号、执行解析器误拒绝相邻符号，已在 AlphaPilot 修复。修补后使用原表达式 ZSCORE(-TS_SUM($return,5)) 进行真实 single_ic 回测，任务 3ce8da2bd7814b2185622f266a59677e 成功，取得完整指标；未来引用 DELAY($close,-1) 仍被拒绝。MCP 同时修补凭据目录权限与符号链接校验，并补回归测试。

复现命令见 README；完整记录留在 AlphaPilot git_ignore_folder/qa/mcp/mcp-live-20260916-150028 和 mcp-unary-backtest-20260916-151538。没有将行情、凭据或运行日志提交到 Git。

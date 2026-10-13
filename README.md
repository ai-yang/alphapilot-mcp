# AlphaPilot MCP

独立的 [AlphaPilot](https://github.com/ai-yang/AlphaPilot) 研究工作台 MCP 服务。Node.js 22+，TypeScript，官方 MCP SDK v2。通过 HTTP 访问 `/api/v1`，不安装 AlphaPilot、Python、Qlib 或 Torch。

支持 Codex、Claude Code、DeepSeek Harness 的 stdio 和 Streamable HTTP；同一份工具定义兼容 MCP `2025-11-25` 和 `2026-07-28`。GUI 和 MCP 使用相同后端工作区，客户端退出不取消研究任务。

## 安装与启动

本仓库源码公开，可直接克隆并构建；尚未发布到公共 npm registry。使用本地源码或自行生成的 tarball 安装：

```sh
git clone https://github.com/ai-yang/alphapilot-mcp.git
cd alphapilot-mcp
npm ci
npm run build
node dist/cli.js --help
npm pack
npm install -g ./alphapilot-mcp-0.1.0.tgz
# 或不全局安装：
npx --yes --package ./alphapilot-mcp-0.1.0.tgz alphapilot-mcp --help
```

后端先启动 Portal 和研究任务运行时，通过 AlphaPilot 本地 `research_token` 管理命令，为每个客户端分别创建研究凭据。MCP 不提供凭据或实盘管理工具。

```sh
export ALPHAPILOT_BASE_URL=http://127.0.0.1:19901
export ALPHAPILOT_RESEARCH_TOKEN='本客户端的 AlphaPilot 研究凭据'
alphapilot-mcp doctor
alphapilot-mcp serve --transport stdio
```

MCP 不需要模型 API Key。自主挖掘使用 AlphaPilot 后端已配置的模型。环境变量需由启动器显式提供；程序不自动读取工作区 `.env`。stdio 的 stdout 仅用于协议，日志写 stderr。

`config --client codex --transport stdio` 会使用当前 Node 和已构建 CLI 的绝对路径生成可直接使用的配置，无需公共 npm 包。移动安装目录后请重新生成配置；仓库 `examples/` 中的绝对路径占位符需要替换为本机路径。

## 客户端配置

```sh
alphapilot-mcp config --client codex --transport stdio
alphapilot-mcp config --client claude-code --transport http
alphapilot-mcp config --client deepseek-harness --transport stdio
```

源码构建后也可使用 `node dist/cli.js config --client codex --transport stdio`。将输出加入 Codex 的 `~/.codex/config.toml`，并确保启动 Codex 的环境中存在 `ALPHAPILOT_BASE_URL` 和 `ALPHAPILOT_RESEARCH_TOKEN`；重启后在 CLI 中用 `/mcp` 检查连接。

配置模板见 [examples](examples)。命令只打印模板，不修改客户端配置、不启动任务。服务器名统一为 `alphapilot`。

- Codex：写入 `config.toml` 的 `mcp_servers.alphapilot`；HTTP 用 `bearer_token_env_var`。
- Claude Code：`.mcp.json` 中的 `mcpServers.alphapilot`，显式 `type: stdio/http`。
- DeepSeek Harness：Cordis YAML 使用 `@deepseek-ai/dsh-mcp-client`；显式传入 Token。Harness 会清理继承环境中的敏感变量，仅设置父进程环境还不够。

官方配置依据：[Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Claude Code](https://code.claude.com/docs/en/mcp)、[DeepSeek Harness](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/mcp/mcp-client/README.md)。实际验收版本见 [验收记录](docs/acceptance.md)。

## 工具范围

创建、更新、导入和删除股票池还需后端 `data:write` 权限，因为这些操作会更新数据集的 instruments。仅具备 `research:read,research:write,jobs:submit,jobs:cancel` 的凭据不会展示这些写入工具；读取股票池和使用已有股票池回测不受影响。

共 87 个具名工具，默认仅开启包含 44 个工具的 `core` 组。工具可见性取部署组、后端算法/功能能力和当前凭据权限的交集；模型不能通过参数解锁组。调用时重新检查凭据能力。

| 组 | 内容 | 默认 |
|---|---|---|
| core | 目录、表达式验证、因子/策略/股票池、四类挖掘、两类回测、任务控制、运行与产物 | 开启 |
| data | 下载、更新、转换、准备、复权、单股票刷新 | 关闭 |
| files | 资产导入导出、PDF 提取与审核入库、网关文件传输 | 关闭 |
| signals | 日频模拟会话、历史、资金调整、预览与推进 | 关闭 |
| schedules | 研究调度查询、创建、更新、暂停/恢复和手动触发 | 关闭 |
| cleanup | 资产、任务、运行、上传、行情记录的删除/裁剪 | 关闭 |

```sh
export ALPHAPILOT_MCP_GROUPS=core,data,files,signals,schedules
```

完整静态映射和权限见 [工具目录](docs/tools.md)。没有通用 HTTP、Python、Shell、模块执行、券商或交易工具。后端增加 API 不会自动增加 MCP 工具。

## 研究调用约定

先发现 `dataset_id`、`stock_pool_id`、`template_id` 和 `model_id`，再验证表达式。回测可以直接使用内联表达式：

```json
{
  "dataset_id": "baostock_cn:day:forward",
  "template_id": "combined",
  "model_id": "lgbm",
  "mode": "single_ic",
  "factor_source": {
    "type": "inline",
    "factors": [{"name": "reversal_5d", "expression": "0 - TS_SUM($return, 5)"}]
  },
  "parameters": {"benchmark": "SH000300"},
  "timeout_seconds": 3600,
  "idempotency_key": "research-intent-001"
}
```

以上作为 `submit_factor_backtest` 的参数。`parameters` 是固定字段对象；表达式语义由后端验证。任务工具只提交，立即返回 `job_id`；随后使用 `get_job`、`get_job_result`、`list_runs` 和 `list_artifacts`。

- `idempotency_key` 必填，原样映射 `Idempotency-Key`。响应丢失时返回 `SUBMISSION_UNCONFIRMED`，使用**完全相同输入和原键**重试。同键不同输入由后端返回 409。
- 只读请求和同键任务提交最多额外重试两次；其他写操作不重试。默认调用总预算 30 秒（`ALPHAPILOT_MCP_TIMEOUT_MS`），任务默认预算 3600 秒，遵守后端上限。
- 取消 MCP 调用只结束 HTTP 等待。停止业务任务必须调用 `cancel_job`。
- 查询到失败任务是成功查询，失败原因在任务数据中。表达式验证失败也作为正常验证结果返回。
- 更新/删除版本化资产、调度需 `expected_revision`，映射 `If-Match`。冲突时先重新读取版本。
- `preview_daily_signals` 不提交会话状态；`advance_daily_signals` 必须指定会话和日期。刷新行情还需 `data:write`。
- 调度复用同一任务 Schema；创建、恢复、手动触发不能绕过部署禁用的任务组。后端在触发时再次鉴权。
- `detail=full` 显式获取任务输入和运行明细；默认摘要。运行的完整产物清单用 `list_artifacts` 分页获取。
- 列表默认 20、最多 200；日志默认 8 KiB、最多 32 KiB；曲线默认 200 点，保留后端降采样标识。单次业务结果最多 64 KiB，超限明确报错，不静默截断或消耗游标。

所有工具同时返回相同的 JSON 文本及 `structuredContent`，含 `ok/data/error/meta`。保留后端错误码、请求 ID、重试建议；工具调用错误带 `isError: true`。详见 [接口与错误](docs/contract.md)。

## 私有 HTTP 部署

MCP Bearer 与 AlphaPilot Bearer 是两套凭据。每个 MCP 客户端映射到独立的后端凭据，不透传请求中的 Token 或身份。

```sh
export ALPHAPILOT_BASE_URL=http://127.0.0.1:19901
export ALPHAPILOT_CODEX_TOKEN='Codex 专用后端凭据'
export ALPHAPILOT_MCP_CREDENTIAL_DIR=/受保护目录/credentials
alphapilot-mcp credentials create codex --backend-token-env ALPHAPILOT_CODEX_TOKEN
alphapilot-mcp credentials list
alphapilot-mcp serve --transport http
# 撤销：alphapilot-mcp credentials revoke CREDENTIAL_ID
```

创建命令仅此一次输出 MCP Token；服务端文件只保存 SHA-256 哈希和后端环境变量名。支持 `--expires ISO_DATE`。凭据目录默认 `~/.config/alphapilot-mcp/credentials`，目录权限 0700、文件 0600；读到不安全权限会拒绝鉴权。

默认 `127.0.0.1:19902/mcp`。远程通过 HTTPS 网关，仅转发 `/mcp`、`/files/*`；根据需求开放 `/healthz` 和带认证的 `/readyz`。此版本为私有静态 Bearer，不提供公开 OAuth 登录。

设置 `ALPHAPILOT_MCP_ALLOWED_HOSTS=localhost,127.0.0.1,mcp.example.com`；有浏览器 Origin 时需用 `ALPHAPILOT_MCP_ALLOWED_ORIGINS` 列出完整 Origin。默认拒绝全部浏览器 Origin。不信任转发的身份头。

```sh
docker build -t alphapilot-mcp:0.1.0 .
# 容器到宿主机的后端 URL 按运行平台设置；挂载凭据目录，注入映射的后端环境变量。
docker run --rm -p 127.0.0.1:19902:19902 \
  --env-file /受保护目录/mcp.env \
  -v /受保护目录/credentials:/credentials:ro alphapilot-mcp:0.1.0
```

镜像以非 root 用户运行，挂载文件应允许其读取。MCP 容器不需要行情目录或 Python 环境。

## 文件传输

工具参数只接受 `upload_id` / `artifact_id`，文件不经过模型上下文。

```sh
alphapilot-mcp files upload ./report.pdf
alphapilot-mcp files download ARTIFACT_ID --output ./result.csv
```

本地使用 AlphaPilot URL/研究凭据直接传输。远程部署启用 `files` 组，并在客户端配置：

```sh
export ALPHAPILOT_MCP_URL=https://mcp.example.com/mcp
export ALPHAPILOT_MCP_TOKEN='本客户端的 MCP 凭据'
alphapilot-mcp doctor
alphapilot-mcp files upload ./factors.csv
```

上传 CSV/JSON/PDF，最大 50 MiB；下载校验大小和 SHA-256，经同目录临时文件原子替换目标。失败时保留原目标文件。文件传输预算 5 分钟；工具调用仍是 30 秒。

## 开发与契约更新

```sh
npm ci
npm run contract:generate
npm test
npm pack
```

`contract/openapi-v1.json` 是发布时固定的完整契约，`src/api.generated.ts` 由它生成。工具输入/输出校验从同一契约解析，注册表只允许明确登记的端点。升级后端时，复制新的 OpenAPI 后重新生成、审查差异并运行契约/协议测试。API 主版本不兼容时拒绝业务调用；缺少分页或恢复功能时禁用对应能力。

后端新增的检查点、分页和迁移兼容说明见 AlphaPilot 的 `docs/research/mcp-support.md`。没有可信检查点的历史会话不会通过文件时间推断恢复位置。

## 真实数据验收复现

在 AlphaPilot 的 Python 环境中执行 `python scripts/smoke_research_mcp.py`。默认读取同级 `alphapilot-mcp`，也可用 `MCP_REPOSITORY` 指定；先在 MCP 仓库运行 `npm ci && npm run build`。

该命令会使用后端已配置的真实模型和行情，运行一轮自主挖掘（3 步后续跑 2 步），并将因子和策略保存到当前工作区。要求任务运行时停止、没有活动任务和调度；使用临时研究凭据及本机端口，不发送渠道通知。验证 stdio/HTTP 共享任务、幂等提交、跨客户端取消、客户端断开后继续执行及两条文件下载通道。测试结束后撤销临时凭据；若仍有活动任务，保留运行时并提示显式处理。

默认使用 `baostock_cn:day:forward`、`arena_zz_v1`、`combined`、`lgbm` 和基准 `SH000300`。测试报告留在 AlphaPilot 的 `git_ignore_folder/qa/mcp/`，不上传行情、模型凭据或运行工作目录。

原表达式的独立真实回归可执行 `python scripts/smoke_research_mcp.py --scenario unary-backtest`：验证一元负号、拒绝未来引用、计算 IC 并通过 MCP 读取评估产物。

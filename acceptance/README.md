# 实际客户端验收

此目录是可选验收环境，不进入 MCP npm 包，也不参与生产安装。需要 Node 22+ 和 PATH 中的 Codex CLI。

在父目录执行 npm ci、npm run build 后，在此目录执行 npm ci，再运行 npm test 和 npm run test:http。默认使用父目录 tests/helpers.mjs 的确定性 HTTP 后端；每次启动临时端口和临时 MCP 凭据。

- Codex：使用原生 app-server 的 thread/start、mcpServerStatus/list、mcpServer/tool/call，不启动模型对话。
- Harness：加载官方 MCP 插件、Cordis、SystemPrompt 和 ToolRegistry，执行注册后的工具。
- Claude Code：实际 CLI 连接 MCP；本地 Anthropic 流式协议夹具按顺序生成工具调用，无付费模型请求。CLI 显式 --bare、--strict-mcp-config 和 MCP 工具允许列表。

每个客户端验证发现、表达式验证、提交、查询、取消，结果写在本目录 *-report.json；不修改用户全局客户端配置。该测试检验客户端协议与工具兼容性，真实行情/模型验收另见 docs/acceptance.md。

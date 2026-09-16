# MCP 契约

工具参数、枚举和约束来自固定 OpenAPI；模型参数不能包含后端地址、Token、本机路径、任意模型类或 pickle。

```typescript
type ToolResponse<T> = {
  ok: boolean;
  data: T | null;
  error: {code:string;message:string;details:unknown;retryable:boolean;request_id:string} | null;
  meta: {request_id:string;idempotency_key?:string;retry_after_seconds?:number};
};
```

提交工具的 data 为 `{job_id,status,run_ids}`。查询失败任务不触发工具错误。后端原始错误码不改写，唯有网络不确定的提交改为 `SUBMISSION_UNCONFIRMED`，并保留原键和原因。

| 适配层错误 | 行为 |
|---|---|
| INVALID_ARGUMENTS | 修正参数；本次没有发送业务请求 |
| API_VERSION_UNSUPPORTED | 服务只支持 API 主版本 1 |
| TOOL_UNAVAILABLE / FEATURE_UNAVAILABLE | 检查部署工具组、后端功能、凭据权限 |
| FORBIDDEN | 所选保存/数据刷新等参数需要额外权限 |
| SUBMISSION_UNCONFIRMED | 只使用同一输入和原幂等键重试 |
| REQUEST_TIMEOUT | 查询超时；业务任务继续运行 |
| UPSTREAM_UNAVAILABLE | 检查后端连接；读取可安全重试 |
| UPSTREAM_SCHEMA_MISMATCH | 后端响应与发布契约不符；检查版本 |
| RESULT_TOO_LARGE | 缩小 limit/max_points，使用摘要或文件 CLI；不使用失败响应推进游标 |
| CHECKSUM_MISMATCH | 文件下载损坏；目标文件保持原样 |

分页游标视作不透明字符串；日志游标是后端 UTF-8 字节偏移。调用方必须原样回传。返回大小按 JSON UTF-8 字节计算。`list_runs` 可按 job_id 筛选，`list_artifacts` 可组合 job_id/run_id 筛选。

研究权限：research:read、research:write、jobs:submit、jobs:cancel、data:write、signals:write、schedules:write。工具 annotations 仅供客户端展示，实际权限始终由 AlphaPilot 执行。

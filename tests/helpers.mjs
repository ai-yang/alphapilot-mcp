import { createServer } from "node:http";
import { contract } from "../dist/schema.js";
export const scopes = [
  "research:read",
  "research:write",
  "jobs:submit",
  "jobs:cancel",
  "data:write",
  "signals:write",
  "schedules:write",
];
export const caps = {
  api_version: "1.0.0",
  features: {
    run_job_filter: true,
    artifact_pagination: true,
    mining_checkpoint_resume: true,
    schedule_detail: true,
  },
  scopes,
  algorithms: [
    "mine",
    "mine_aff",
    "mine_gp",
    "mine_rl",
    "factor_backtest",
    "strategy_backtest",
    "data",
    "daily_signals",
    "report_factor_extract",
  ].map((kind) => ({
    kind,
    available: true,
    may_use_llm: false,
    required_dependencies: [],
  })),
  runtime: {
    running: false,
    heartbeat_at: null,
    draining: false,
    start_error: null,
  },
  limits: {
    page_default: 50,
    page_max: 200,
    log_bytes: 65536,
    upload_bytes: 52428800,
    max_queued: 100,
    max_running: 1,
    max_timeout_seconds: 86400,
  },
  budgets: {},
  job_schema: "/api/v1/openapi.json",
  dataset_policy: "latest_at_start",
  workspace_mode: "single_owner",
};
export async function backend() {
  const calls = [];
  const jobs = new Map();
  let count = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : undefined;
    calls.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Request-Id", "request-test");
    if (
      req.headers.authorization !== "Bearer backend-test" &&
      req.headers.authorization !== "Bearer reader-test"
    ) {
      res.writeHead(401);
      res.end(
        JSON.stringify({
          code: "UNAUTHENTICATED",
          message: "Revoked",
          retryable: false,
          request_id: "revoked",
        }),
      );
      return;
    }
    if (req.url === "/api/v1/capabilities") {
      res.end(
        JSON.stringify({
          ...caps,
          scopes:
            req.headers.authorization === "Bearer reader-test"
              ? ["research:read"]
              : scopes,
        }),
      );
      return;
    }
    if (req.url === "/api/v1/factors/validate") {
      res.end(
        JSON.stringify({
          results: body.expressions.map((expression) => ({
            expression,
            valid: false,
            normalized_expression: expression,
            normalization: "whitespace_trim",
            syntax_valid: false,
            temporal_valid: false,
            analysis: null,
            library_admission: null,
            issues: [
              {
                code: "INVALID_EXPRESSION",
                message: "Invalid test expression",
              },
            ],
          })),
        }),
      );
      return;
    }
    if (req.url === "/api/v1/jobs" && req.method === "POST") {
      const key = req.headers["idempotency-key"];
      const prev = jobs.get(key);
      if (prev && JSON.stringify(prev.input) !== JSON.stringify(body)) {
        res.writeHead(409);
        res.end(
          JSON.stringify({
            code: "IDEMPOTENCY_CONFLICT",
            message: "Conflict",
            retryable: false,
            request_id: "conflict",
          }),
        );
        return;
      }
      const job = prev?.job ?? {
        job_id: "job-" + ++count,
        kind: body.kind,
        status: "queued",
        created_at: new Date().toISOString(),
        normalized_input: body.input,
        budget: body.budget,
        progress: { stage: "queued" },
        run_ids: [],
        artifact_ids: [],
        source: "mcp",
        client_id: "mock",
      };
      jobs.set(key, { input: body, job });
      res.writeHead(202);
      res.end(JSON.stringify(job));
      return;
    }
    if (req.url.startsWith("/api/v1/jobs/job-")) {
      const job = [...jobs.values()][0]?.job;
      if (req.url.endsWith("/cancel")) job.status = "cancelled";
      res.end(JSON.stringify(job));
      return;
    }
    res.end(JSON.stringify({ items: [], next_cursor: null, total: 0 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    jobs,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

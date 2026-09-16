import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const report = { started_at: new Date().toISOString() };
const output = process.env.MCP_SMOKE_REPORT;
if (!output || !process.env.MCP_SMOKE_ID)
  throw new Error("MCP_SMOKE_REPORT and MCP_SMOKE_ID are required");
const client = new Client({ name: "real-unary-regression", version: "0.1.0" });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  return result.structuredContent.data;
}
const save = () => writeFile(output, JSON.stringify(report, null, 2));
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../dist/cli.js", import.meta.url).pathname, "serve"],
      env: { ...process.env, ALPHAPILOT_MCP_GROUPS: "core" },
      stderr: "inherit",
    }),
  );
  const expression = "ZSCORE(-TS_SUM($return,5))";
  report.validation = await call("validate_factors", {
    expressions: [expression, "DELAY($close,-1)"],
  });
  assert.equal(report.validation.results[0].valid, true);
  assert.equal(report.validation.results[1].valid, false);
  const pools = await call("list_stock_pools", { limit: 200 });
  const pool = pools.items.find((row) => row.name === "arena_zz_v1");
  assert.ok(pool, "Known real-data stock pool is required");
  const input = {
    dataset_id: "baostock_cn:day:forward",
    stock_pool_id: pool.id,
    template_id: "combined",
    model_id: "lgbm",
    mode: "single_ic",
    factor_source: {
      type: "inline",
      factors: [{ name: "unary_regression", expression }],
    },
    parameters: { benchmark: "SH000300", num_threads: 4 },
    timeout_seconds: 3600,
    idempotency_key: process.env.MCP_SMOKE_ID,
  };
  report.submitted = await call("submit_factor_backtest", input);
  await save();
  const deadline = Date.now() + 3700000;
  while (Date.now() < deadline) {
    report.job = await call("get_job", { job_id: report.submitted.job_id });
    if (
      ["succeeded", "failed", "cancelled", "lost"].includes(report.job.status)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  assert.equal(report.job.status, "succeeded", JSON.stringify(report.job));
  report.result = await call("get_job_result", {
    job_id: report.job.job_id,
    detail: "full",
  });
  assert.equal(report.result.availability, "complete");
  report.artifacts = await call("list_artifacts", {
    job_id: report.job.job_id,
    limit: 100,
  });
  assert.ok(report.artifacts.items.length > 0);
  const evaluation = report.artifacts.items.find(
    (item) => item.kind === "evaluation",
  );
  assert.ok(evaluation, "IC evaluation artifact is required");
  report.evaluation = await call("read_artifact_json", {
    artifact_id: evaluation.artifact_id,
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  await save();
  await client.close();
  console.log(
    JSON.stringify({
      event: "finished",
      status: report.status,
      report: output,
      error: report.error,
    }),
  );
}

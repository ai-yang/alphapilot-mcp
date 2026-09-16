import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHttp } from "../dist/http.js";
import { settings } from "../dist/config.js";
import { Credentials } from "../dist/auth.js";
import { downloadFile, fileRequest } from "../dist/files.js";
import { ApiClient } from "../dist/client.js";
const report = { started_at: new Date().toISOString(), steps: [] };
const reportPath = process.env.MCP_SMOKE_REPORT;
if (!reportPath || !process.env.MCP_SMOKE_ID)
  throw new Error("MCP_SMOKE_REPORT and MCP_SMOKE_ID are required");
const credentialDir = await mkdtemp(join(tmpdir(), "amcp-live-"));
let gateway, observer, remoteRequest;
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
async function connect() {
  const c = new Client(
    { name: "alphapilot-real-acceptance", version: "0.1.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../dist/cli.js", import.meta.url).pathname, "serve"],
      env: { ...process.env, ALPHAPILOT_MCP_GROUPS: "core" },
      stderr: "inherit",
    }),
  );
  return c;
}
let client = await connect();
async function call(name, args = {}, connection = client) {
  const r = await connection.callTool({ name, arguments: args });
  if (r.isError) throw new Error(JSON.stringify(r.structuredContent ?? r));
  return r.structuredContent.data;
}
async function wait(id) {
  let previous;
  const deadline = Date.now() + 3700000;
  while (Date.now() < deadline) {
    const j = await call("get_job", { job_id: id });
    if (j.status !== previous) {
      console.log(
        JSON.stringify({ event: "progress", job_id: id, status: j.status }),
      );
      previous = j.status;
    }
    if (["succeeded", "failed", "cancelled", "lost"].includes(j.status)) {
      if (j.status !== "succeeded") throw new Error(JSON.stringify(j));
      return j;
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error("Watchdog expired: job retained; inspect/cancel explicitly");
}
try {
  report.capabilities = await call("get_capabilities");
  if (process.env.MCP_SMOKE_OBSERVER_TOKEN) {
    const credentials = new Credentials(credentialDir);
    const identity = await credentials.create(
      "real-http-observer",
      "MCP_SMOKE_OBSERVER_TOKEN",
    );
    gateway = await serveHttp(
      settings({
        ALPHAPILOT_BASE_URL: process.env.ALPHAPILOT_BASE_URL,
        ALPHAPILOT_MCP_PORT: "0",
        ALPHAPILOT_MCP_CREDENTIAL_DIR: credentialDir,
        ALPHAPILOT_MCP_GROUPS: "core,files",
      }),
    );
    const remote = `http://127.0.0.1:${gateway.server.address().port}/mcp`;
    observer = new Client({ name: "real-http-observer", version: "0.1.0" });
    await observer.connect(
      new StreamableHTTPClientTransport(new URL(remote), {
        requestInit: { headers: { Authorization: `Bearer ${identity.token}` } },
      }),
    );
    remoteRequest = fileRequest(undefined, remote, identity.token);
    report.http_capabilities = await call("get_capabilities", {}, observer);
  }
  report.validation = await call("validate_factors", {
    expressions: ["TS_MEAN($close,10)/($close+1e-8)-1"],
  });
  const pools = await call("list_stock_pools", { limit: 200 });
  const pool = pools.items.find((p) => p.name === "arena_zz_v1");
  if (!pool) throw new Error("Known smoke stock pool unavailable");
  const input = {
    dataset_id: "baostock_cn:day:forward",
    stock_pool_id: pool.id,
    template_id: "combined",
    model_id: "lgbm",
    max_steps: 3,
    direction:
      "本次只做一轮功能验证。研究中证1000股票的短期量价反转，提出一个清晰假设并构造1到3个简洁因子，优先使用过去5到20个交易日的收盘价、成交量和收益率。仅使用系统支持的DSL与历史数据，不使用未来信息；完整执行计算、回测和反馈。",
    parameters: { benchmark: "SH000300", num_threads: 4 },
    save_factors_to_library: true,
    random_seed: 42,
    campaign_id: process.env.MCP_SMOKE_ID,
    timeout_seconds: 3600,
  };
  const first = process.env.MCP_SMOKE_EXISTING_JOB
    ? { job_id: process.env.MCP_SMOKE_EXISTING_JOB, status: "succeeded" }
    : await call("start_mining", {
        ...input,
        idempotency_key: input.campaign_id + "-3",
      });
  report.steps.push(first);
  await save();
  const repeat = process.env.MCP_SMOKE_EXISTING_JOB
    ? first
    : await call("start_mining", {
        ...input,
        idempotency_key: input.campaign_id + "-3",
      });
  if (repeat.job_id !== first.job_id) throw new Error("Idempotency failed");
  report.idempotency = true;
  if (observer) {
    const shared = await call("get_job", { job_id: first.job_id }, observer);
    if (shared.job_id !== first.job_id)
      throw new Error("Cross-client job visibility failed");
    const queued = await call(
      "submit_factor_backtest",
      {
        dataset_id: input.dataset_id,
        stock_pool_id: input.stock_pool_id,
        template_id: input.template_id,
        parameters: input.parameters,
        factor_source: {
          type: "inline",
          factors: [{ name: "cancel_probe", expression: "$close" }],
        },
        mode: "single_ic",
        idempotency_key: input.campaign_id + "-cancel-probe",
      },
      observer,
    );
    report.cancel_probe = queued.job_id;
    await save();
    await call("cancel_job", { job_id: queued.job_id });
    let cancelled;
    for (let attempt = 0; attempt < 30; attempt++) {
      cancelled = await call("get_job", { job_id: queued.job_id }, observer);
      if (cancelled.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (cancelled.status !== "cancelled")
      throw new Error("Cross-client cancellation failed");
    report.cross_client = {
      visible: true,
      cancelled_job_id: queued.job_id,
      status: cancelled.status,
    };
  }
  // A client exiting must not stop the durable backend job.
  await client.close();
  client = await connect();
  report.first_job = await wait(first.job_id);
  const runs = await call("list_runs", {
    job_id: first.job_id,
    limit: 200,
    detail: "full",
  });
  const source = runs.items.find((r) => r.metadata.checkpoint);
  if (!source) throw new Error("Complete checkpoint not discoverable");
  report.source_run = source;
  await save();
  const resumed = await call("start_mining", {
    ...input,
    max_steps: 2,
    resume_run_id: source.run_id,
    idempotency_key:
      input.campaign_id + "-2" + (process.env.MCP_SMOKE_RETRY ?? ""),
  });
  report.steps.push(resumed);
  await save();
  report.resumed_job = await wait(resumed.job_id);
  if (observer) {
    const sharedResult = await call(
      "get_job",
      { job_id: resumed.job_id },
      observer,
    );
    if (sharedResult.status !== "succeeded")
      throw new Error("HTTP client did not observe completed job");
    report.cross_client.completed_job_id = resumed.job_id;
  }
  report.result = await call("get_job_result", {
    job_id: resumed.job_id,
    detail: "full",
  });
  report.runs = await call("list_runs", {
    job_id: resumed.job_id,
    limit: 200,
    detail: "full",
  });
  const artifacts = await call("list_artifacts", {
    job_id: resumed.job_id,
    limit: 200,
  });
  report.artifacts = artifacts;
  if (!artifacts.items.length) throw new Error("No resumed run artifacts");
  const metadata =
    artifacts.items.find((a) => a.kind === "backtest_summary") ??
    artifacts.items[0];
  const request = fileRequest(
    new ApiClient(
      process.env.ALPHAPILOT_BASE_URL,
      process.env.ALPHAPILOT_RESEARCH_TOKEN,
    ),
  );
  report.download = await downloadFile(
    request,
    metadata.artifact_id,
    reportPath + ".artifact",
  );
  if (remoteRequest) {
    report.remote_download = await downloadFile(
      remoteRequest,
      metadata.artifact_id,
      reportPath + ".remote.artifact",
    );
    if (report.download.sha256 !== report.remote_download.sha256)
      throw new Error("Remote download differs");
  }
  const original = await call("get_run", {
    run_id: source.run_id,
    detail: "full",
  });
  if (JSON.stringify(original) !== JSON.stringify(source))
    throw new Error("Source run changed during resume");
  report.source_preserved = true;
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  await save();
  await client.close();
  if (observer) await observer.close();
  if (gateway) await gateway.close();
  await rm(credentialDir, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      event: "finished",
      status: report.status,
      report: reportPath,
      error: report.error,
    }),
  );
}

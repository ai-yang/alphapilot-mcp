import { fileURLToPath } from "node:url";
const acceptanceDir = fileURLToPath(new URL(".", import.meta.url));
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
import { gateway } from "./gateway.mjs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { backend } from "../tests/helpers.mjs";
import { writeFile } from "node:fs/promises";
const upstream = await backend();
const remote =
  process.env.TRANSPORT === "http" ? await gateway(upstream.url) : null;
const env = {
  ...process.env,
  ALPHAPILOT_BASE_URL: upstream.url,
  ALPHAPILOT_RESEARCH_TOKEN: "backend-test",
  NATIVE_MCP_TOKEN: remote?.token ?? "",
};
const child = spawn(
  "codex",
  remote
    ? [
        "-c",
        `mcp_servers.alphapilot.url="${remote.url}"`,
        "-c",
        'mcp_servers.alphapilot.bearer_token_env_var="NATIVE_MCP_TOKEN"',
        "app-server",
      ]
    : [
        "-c",
        'mcp_servers.alphapilot.command="node"',
        "-c",
        `mcp_servers.alphapilot.args=${JSON.stringify([cliPath, "serve"])}`,
        "-c",
        'mcp_servers.alphapilot.env_vars=["ALPHAPILOT_BASE_URL","ALPHAPILOT_RESEARCH_TOKEN"]',
        "-c",
        "mcp_servers.alphapilot.startup_timeout_sec=30",
        "app-server",
      ],
  { env, cwd: acceptanceDir, stdio: ["pipe", "pipe", "pipe"] },
);
let id = 0;
const pending = new Map();
let errors = "";
child.stderr.on("data", (c) => (errors += c));
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id !== undefined && pending.has(m.id)) {
    const { resolve, reject, timer } = pending.get(m.id);
    clearTimeout(timer);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
const rpc = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error("Timeout " + method));
    }, 90000);
    pending.set(key, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: key, method, params }) + "\n");
  });
const report = {
  client: "Codex",
  version: "0.154.0-alpha.6.2",
  transport: remote ? "http" : "stdio",
  backend: "deterministic HTTP fixture",
};
try {
  await rpc("initialize", {
    clientInfo: { name: "alphapilot-acceptance", version: "1" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  const start = await rpc("thread/start", {
    cwd: acceptanceDir,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const threadId = start.thread.id;
  const inventory = await rpc("mcpServerStatus/list", { threadId });
  report.inventory = inventory;
  const call = async (tool, args = {}) => {
    const r = await rpc("mcpServer/tool/call", {
      threadId,
      server: "alphapilot",
      tool,
      arguments: args,
    });
    if (r.isError) throw new Error(JSON.stringify(r));
    console.log(JSON.stringify({ tool, result: r }));
    return r;
  };
  await call("get_capabilities");
  await call("validate_factors", { expressions: ["invalid()"] });
  const submitted = await call("submit_factor_backtest", {
    dataset_id: "test",
    factor_source: {
      type: "inline",
      factors: [{ name: "close", expression: "$close" }],
    },
    idempotency_key: "codex-acceptance",
  });
  const job = [...upstream.jobs.values()][0].job;
  await call("get_job", { job_id: job.job_id });
  await call("cancel_job", { job_id: job.job_id });
  report.status = job.status === "cancelled" ? "passed" : "failed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  report.stderr = errors.slice(-4000);
} finally {
  await writeFile(
    `${acceptanceDir}codex-${remote ? "http" : "stdio"}-report.json`,
    JSON.stringify(report, null, 2),
  );
  child.stdin.end();
  child.kill("SIGTERM");
  if (remote) await remote.close();
  await upstream.close();
  console.log(
    JSON.stringify({
      client: report.client,
      status: report.status,
      error: report.error,
    }),
  );
}

if (report.status !== "passed") process.exitCode = 1;

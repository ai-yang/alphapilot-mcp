import { fileURLToPath } from "node:url";
const acceptanceDir = fileURLToPath(new URL(".", import.meta.url));
const cliPath =
  process.env.MCP_INSTALLED_CLI ??
  fileURLToPath(new URL("../dist/cli.js", import.meta.url));
import { gateway } from "./gateway.mjs";
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
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
        ...execFileSync(
          process.execPath,
          [cliPath, "config", "--client", "codex", "--transport", "stdio"],
          { encoding: "utf8" },
        )
          .trim()
          .split("\n")
          .slice(1)
          .flatMap((line) => ["-c", `mcp_servers.alphapilot.${line}`]),
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
  version: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
  node: process.version,
  tested_at: new Date().toISOString(),
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
  const server = inventory.data.find((item) => item.name === "alphapilot");
  assert.ok(server, "AlphaPilot must appear in Codex's MCP inventory");
  assert.equal(Object.keys(server.tools).length, 44);
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
  const validation = await call("validate_factors", {
    expressions: ["invalid()"],
  });
  assert.equal(validation.structuredContent.data.results[0].valid, false);
  const submitted = await call("submit_factor_backtest", {
    dataset_id: "test",
    factor_source: {
      type: "inline",
      factors: [{ name: "close", expression: "$close" }],
    },
    idempotency_key: "codex-acceptance",
  });
  const job = [...upstream.jobs.values()][0].job;
  assert.equal(submitted.structuredContent.data.job_id, job.job_id);
  const queried = await call("get_job", { job_id: job.job_id });
  assert.equal(queried.structuredContent.data.status, "queued");
  const cancelled = await call("cancel_job", { job_id: job.job_id });
  assert.equal(cancelled.structuredContent.data.status, "cancelled");
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

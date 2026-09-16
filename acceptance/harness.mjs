import { fileURLToPath } from "node:url";
const acceptanceDir = fileURLToPath(new URL(".", import.meta.url));
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
import { gateway } from "./gateway.mjs";
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRegistry } from "@deepseek-ai/dsh-tools";
import * as bridge from "@deepseek-ai/dsh-mcp-client";
import { backend } from "../tests/helpers.mjs";
import { writeFile } from "node:fs/promises";
const upstream = await backend();
const remote =
  process.env.TRANSPORT === "http" ? await gateway(upstream.url) : null;
const ctx = new Context();
const report = {
  client: "DeepSeek Harness MCP bridge",
  version: "0.0.1-rc.1",
  transport: remote ? "http" : "stdio",
  backend: "deterministic HTTP fixture",
};
try {
  new SystemPrompt(ctx, {});
  new ToolRegistry(ctx, {});
  await bridge.apply(
    ctx,
    remote
      ? {
          transport: "streamable-http",
          serverName: "alphapilot",
          url: remote.url,
          headers: { Authorization: `Bearer ${remote.token}` },
          toolCallTimeoutMs: 30000,
          failOnStartupError: true,
        }
      : {
          transport: "stdio",
          serverName: "alphapilot",
          command: "node",
          args: [cliPath, "serve"],
          env: {
            ALPHAPILOT_BASE_URL: upstream.url,
            ALPHAPILOT_RESEARCH_TOKEN: "backend-test",
          },
          cwd: acceptanceDir,
          toolCallTimeoutMs: 30000,
          failOnStartupError: true,
        },
  );
  const call = async (name, args = {}) => {
    const tool = ctx.tools.get("mcp__alphapilot__" + name);
    if (!tool) throw new Error("Tool unavailable " + name);
    const value = await tool.execute(args, {
      signal: new AbortController().signal,
    });
    if (value.structuredContent?.ok !== true)
      throw new Error(JSON.stringify(value));
    console.log(JSON.stringify({ tool: name, result: value }));
    return value.structuredContent.data;
  };
  await call("get_capabilities");
  await call("validate_factors", { expressions: ["invalid()"] });
  const job = await call("submit_factor_backtest", {
    dataset_id: "test",
    factor_source: {
      type: "inline",
      factors: [{ name: "close", expression: "$close" }],
    },
    idempotency_key: "harness-acceptance",
  });
  await call("get_job", { job_id: job.job_id });
  await call("cancel_job", { job_id: job.job_id });
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  report.stack = e.stack;
  console.error(e);
} finally {
  await ctx.fiber.dispose();
  if (remote) await remote.close();
  await upstream.close();
  await writeFile(
    `${acceptanceDir}harness-${remote ? "http" : "stdio"}-report.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}

if (report.status !== "passed") process.exitCode = 1;

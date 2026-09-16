import { fileURLToPath } from "node:url";
const acceptanceDir = fileURLToPath(new URL(".", import.meta.url));
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
import { gateway } from "./gateway.mjs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { writeFile, readFile } from "node:fs/promises";
import { backend } from "../tests/helpers.mjs";
const upstream = await backend();
const remote =
  process.env.TRANSPORT === "http" ? await gateway(upstream.url) : null;
let step = 0;
const apiCalls = [];
const plan = [
  ["get_capabilities", {}],
  ["validate_factors", { expressions: ["invalid()"] }],
  [
    "submit_factor_backtest",
    {
      dataset_id: "test",
      factor_source: {
        type: "inline",
        factors: [{ name: "close", expression: "$close" }],
      },
      idempotency_key: "claude-acceptance",
    },
  ],
  ["get_job", { job_id: "job-1" }],
  ["cancel_job", { job_id: "job-1" }],
];
const model = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks));
  } catch {
    res.end("{}");
    return;
  }
  apiCalls.push({
    path: req.url,
    stream: body.stream,
    tool_names: body.tools?.map((t) => t.name),
  });
  if (req.url.includes("count_tokens")) {
    res.setHeader("content-type", "application/json");
    res.end('{"input_tokens":100}');
    return;
  }
  const item = plan[step++];
  const name = item
    ? body.tools?.find((t) => t.name.endsWith("__" + item[0]))?.name
    : undefined;
  const content = item
    ? [
        {
          type: "tool_use",
          id: "tool-" + step,
          name: name ?? "mcp__alphapilot__" + item[0],
          input: item[1],
        },
      ]
    : [{ type: "text", text: "MCP acceptance finished." }];
  const stop = item ? "tool_use" : "end_turn";
  if (!body.stream) {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "msg-test-" + step,
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: {
      id: "msg-" + step,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  });
  if (item) {
    send("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tool-" + step,
        name: content[0].name,
        input: {},
      },
    });
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(item[1]),
      },
    });
  } else {
    send("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: content[0].text },
    });
  }
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const config = {
  mcpServers: {
    alphapilot: remote
      ? {
          type: "http",
          url: remote.url,
          headers: { Authorization: `Bearer ${remote.token}` },
        }
      : {
          type: "stdio",
          command: "node",
          args: [cliPath, "serve"],
          env: {
            ALPHAPILOT_BASE_URL: upstream.url,
            ALPHAPILOT_RESEARCH_TOKEN: "backend-test",
          },
        },
  },
};
const file = acceptanceDir + "claude-mcp.json";
await writeFile(file, JSON.stringify(config));
const report = {
  client: "Claude Code",
  version: "2.1.273",
  transport: remote ? "http" : "stdio",
  backend: "deterministic HTTP fixture",
  model: "local deterministic Anthropic tool-use fixture; no paid model calls",
};
try {
  const child = spawn(
    acceptanceDir + "node_modules/.bin/claude",
    [
      "--bare",
      "-p",
      "Run the MCP acceptance workflow.",
      "--mcp-config",
      file,
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__alphapilot__*",
      "--tools",
      "",
      "--output-format",
      "json",
      "--model",
      "claude-sonnet-4-6",
    ],
    {
      cwd: acceptanceDir,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "local-fixture-only",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.address().port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ENABLE_TOOL_SEARCH: "false",
      },
    },
  );
  let out = "",
    err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const timer = setTimeout(() => child.kill("SIGTERM"), 90000);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  clearTimeout(timer);
  report.exit_code = code;
  report.output = out;
  report.stderr = err;
  report.model_calls = apiCalls;
  report.backend_calls = upstream.calls.map((c) => ({
    method: c.method,
    url: c.url,
  }));
  report.status =
    [...upstream.jobs.values()][0]?.job.status === "cancelled"
      ? "passed"
      : "failed";
} finally {
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  if (remote) await remote.close();
  await upstream.close();
  await writeFile(
    `${acceptanceDir}claude-${remote ? "http" : "stdio"}-report.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      client: report.client,
      status: report.status,
      report: `${acceptanceDir}claude-${remote ? "http" : "stdio"}-report.json`,
    }),
  );
}

if (report.status !== "passed") process.exitCode = 1;

#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ApiClient, Failure } from "./client.js";
import { settings } from "./config.js";
import { buildServer } from "./server.js";
import { serveHttp } from "./http.js";
import { Credentials } from "./auth.js";
import { uploadFile, downloadFile, fileRequest } from "./files.js";
import { available, registry } from "./registry.js";
export function template(client: string, transport: string) {
  const command = process.execPath;
  const args = [
    fileURLToPath(import.meta.url),
    "serve",
    "--transport",
    "stdio",
  ];
  if (client === "codex")
    return transport === "http"
      ? `[mcp_servers.alphapilot]\nurl = "https://mcp.example.com/mcp"\nbearer_token_env_var = "ALPHAPILOT_MCP_TOKEN"\n`
      : `[mcp_servers.alphapilot]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nenv_vars = ["ALPHAPILOT_BASE_URL", "ALPHAPILOT_RESEARCH_TOKEN"]\nstartup_timeout_sec = 30\n`;
  if (client === "claude-code")
    return (
      JSON.stringify(
        {
          mcpServers: {
            alphapilot:
              transport === "http"
                ? {
                    type: "http",
                    url: "https://mcp.example.com/mcp",
                    headers: {
                      Authorization: "Bearer ${ALPHAPILOT_MCP_TOKEN}",
                    },
                  }
                : {
                    type: "stdio",
                    command,
                    args,
                    env: {
                      ALPHAPILOT_BASE_URL: "${ALPHAPILOT_BASE_URL}",
                      ALPHAPILOT_RESEARCH_TOKEN: "${ALPHAPILOT_RESEARCH_TOKEN}",
                    },
                  },
          },
        },
        null,
        2,
      ) + "\n"
    );
  if (client === "deepseek-harness")
    return (
      `- id: mcp-alphapilot\n  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: alphapilot\n` +
      (transport === "http"
        ? `    transport: streamable-http\n    url: https://mcp.example.com/mcp\n    headers:\n      Authorization: !!js '\u0060Bearer \u0024{process.env.ALPHAPILOT_MCP_TOKEN}\u0060'\n`
        : `    transport: stdio\n    command: ${JSON.stringify(command)}\n    args: ${JSON.stringify(args)}\n    env:\n      ALPHAPILOT_BASE_URL: !!js process.env.ALPHAPILOT_BASE_URL\n      ALPHAPILOT_RESEARCH_TOKEN: !!js process.env.ALPHAPILOT_RESEARCH_TOKEN\n`)
    );
  throw new Error("Supported clients: codex, claude-code, deepseek-harness");
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      transport: { type: "string", default: "stdio" },
      client: { type: "string" },
      output: { type: "string" },
      "backend-token-env": { type: "string" },
      expires: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const [command, subcommand, argument] = positionals;
  if (values.help || !command) {
    console.log(
      "alphapilot-mcp serve --transport stdio|http\nalphapilot-mcp doctor\nalphapilot-mcp config --client codex|claude-code|deepseek-harness --transport stdio|http\nalphapilot-mcp files upload FILE\nalphapilot-mcp files download ARTIFACT_ID --output FILE\nalphapilot-mcp credentials create CLIENT --backend-token-env ENV [--expires ISO_DATE]\nalphapilot-mcp credentials list\nalphapilot-mcp credentials revoke ID",
    );
    return;
  }
  if (!["stdio", "http"].includes(values.transport!))
    throw new Error("Transport must be stdio or http");
  if (command === "config") {
    process.stdout.write(template(values.client ?? "", values.transport!));
    return;
  }
  const config = settings();
  const client = () =>
    new ApiClient(config.base, config.token, "stdio", config.timeoutMs);
  if (command === "credentials") {
    const auth = new Credentials(config.credentialDir);
    const result =
      subcommand === "create"
        ? await auth.create(
            argument,
            values["backend-token-env"] ?? "",
            values.expires,
          )
        : subcommand === "revoke"
          ? await auth.revoke(argument)
          : subcommand === "list"
            ? await auth.list()
            : undefined;
    if (!result) throw new Error("Unknown credentials command");
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "serve") {
    if (values.transport === "http") {
      const handle = await serveHttp(config);
      console.error(
        JSON.stringify({
          event: "listening",
          transport: "http",
          host: config.host,
          port: config.port,
        }),
      );
      for (const signal of ["SIGINT", "SIGTERM"])
        process.once(signal, () => void handle.close());
    } else {
      const handle = serveStdio(() => buildServer(client(), config.enabled), {
        onerror: () =>
          console.error(JSON.stringify({ event: "protocol_error" })),
      });
      for (const signal of ["SIGINT", "SIGTERM"])
        process.once(signal, () => void handle.close());
    }
    return;
  }
  if (command === "doctor") {
    if (config.remote) {
      if (!config.remoteToken)
        throw new Error("ALPHAPILOT_MCP_TOKEN is required");
      const remote = new Client(
        { name: "alphapilot-doctor", version: "0.1.0" },
        { versionNegotiation: { mode: "auto" } },
      );
      try {
        await remote.connect(
          new StreamableHTTPClientTransport(new URL(config.remote), {
            requestInit: {
              headers: { Authorization: `Bearer ${config.remoteToken}` },
            },
          }),
        );
        const tools = await remote.listTools();
        const capabilities = await remote.callTool({
          name: "get_capabilities",
          arguments: {},
        });
        const datasets = await remote.callTool({
          name: "list_datasets",
          arguments: { limit: 200 },
        });
        console.log(
          JSON.stringify(
            {
              ok: !capabilities.isError && !datasets.isError,
              capabilities: capabilities.structuredContent,
              datasets: datasets.structuredContent,
              available_tools: tools.tools.map((t) => t.name),
            },
            null,
            2,
          ),
        );
        if (capabilities.isError || datasets.isError) process.exitCode = 1;
      } finally {
        await remote.close();
      }
      return;
    }
    const api = client();
    const caps = await api.capabilities();
    const datasets = await api.request("/api/v1/datasets?limit=200");
    console.log(
      JSON.stringify(
        {
          ok: true,
          api_version: caps.api_version,
          scopes: caps.scopes,
          features: caps.features,
          runtime: caps.runtime,
          datasets: datasets.data,
          enabled_groups: [...config.enabled],
          available_tools: registry
            .filter((t) => available(t, caps, config.enabled))
            .map((t) => t.name),
          disabled_tools: registry
            .filter((t) => !available(t, caps, config.enabled))
            .map((t) => t.name),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "files") {
    const request = fileRequest(
      config.remote ? undefined : client(),
      config.remote,
      config.remoteToken,
    );
    const result =
      subcommand === "upload"
        ? await uploadFile(request, argument)
        : subcommand === "download" && values.output
          ? await downloadFile(request, argument, values.output)
          : undefined;
    if (!result)
      throw new Error(
        "Use files upload FILE or files download ARTIFACT_ID --output FILE",
      );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error("Unknown command; run --help");
}
main().catch((e) => {
  console.error(
    JSON.stringify(
      e instanceof Failure
        ? e.error
        : { code: "CLI_ERROR", message: e.message },
    ),
  );
  process.exitCode = 1;
});

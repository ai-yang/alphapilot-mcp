import { homedir } from "node:os";
import { join } from "node:path";
import { failure } from "./client.js";
import { groups } from "./registry.js";
export function settings(env: NodeJS.ProcessEnv = process.env) {
  const enabled = new Set(
    (env.ALPHAPILOT_MCP_GROUPS ?? "core")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const name of enabled)
    if (!groups.includes(name as any))
      throw failure("INVALID_CONFIG", `Unknown tool group: ${name}`);
  const port = Number(env.ALPHAPILOT_MCP_PORT ?? 19902);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw failure("INVALID_CONFIG", "Invalid port");
  const timeoutMs = Number(env.ALPHAPILOT_MCP_TIMEOUT_MS ?? 30000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000)
    throw failure("INVALID_CONFIG", "Call timeout must be 100..120000 ms");
  return {
    base: env.ALPHAPILOT_BASE_URL ?? "http://127.0.0.1:19901",
    token: env.ALPHAPILOT_RESEARCH_TOKEN ?? "",
    enabled,
    timeoutMs,
    host: env.ALPHAPILOT_MCP_HOST ?? "127.0.0.1",
    port,
    allowedHosts: (
      env.ALPHAPILOT_MCP_ALLOWED_HOSTS ?? "localhost,127.0.0.1,[::1]"
    ).split(","),
    allowedOrigins: (env.ALPHAPILOT_MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .filter(Boolean),
    credentialDir:
      env.ALPHAPILOT_MCP_CREDENTIAL_DIR ??
      join(homedir(), ".config", "alphapilot-mcp", "credentials"),
    remote: env.ALPHAPILOT_MCP_URL,
    remoteToken: env.ALPHAPILOT_MCP_TOKEN,
  };
}

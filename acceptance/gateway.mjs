import { fileURLToPath } from "node:url";
const acceptanceDir = fileURLToPath(new URL(".", import.meta.url));
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHttp } from "../dist/http.js";
import { settings } from "../dist/config.js";
import { Credentials } from "../dist/auth.js";
export async function gateway(base) {
  const dir = await mkdtemp(join(tmpdir(), "amcp-native-"));
  process.env.NATIVE_BACKEND = "backend-test";
  const credential = await new Credentials(dir).create(
    "native-client",
    "NATIVE_BACKEND",
  );
  const handle = await serveHttp(
    settings({
      ALPHAPILOT_BASE_URL: base,
      ALPHAPILOT_MCP_PORT: "0",
      ALPHAPILOT_MCP_CREDENTIAL_DIR: dir,
    }),
  );
  return {
    url: `http://127.0.0.1:${handle.server.address().port}/mcp`,
    token: credential.token,
    close: async () => {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

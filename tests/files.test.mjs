import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  open,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { uploadFile, downloadFile, fileRequest } from "../dist/files.js";
import { ApiClient } from "../dist/client.js";
import { Credentials } from "../dist/auth.js";
import { serveHttp } from "../dist/http.js";
import { settings } from "../dist/config.js";
for (const remote of [false, true])
  test(
    `${remote ? "gateway" : "direct"} streaming upload/download validates checksum and preserves destination on corruption`,
    { timeout: 20000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "amcp-files-"));
      const data = Buffer.from("中文报告\n" + "factor,value\n".repeat(100000));
      let uploaded = 0;
      let corrupt = false;
      const backend = createServer(async (req, res) => {
        assert.equal(req.headers.authorization, "Bearer mapped-backend");
        if (req.method === "POST") {
          for await (const chunk of req) uploaded += chunk.length;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ upload_id: "upload-test" }));
        } else if (req.url.endsWith("/content"))
          res.end(corrupt ? Buffer.from("corrupt") : data);
        else {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              artifact_id: "artifact-test",
              size: data.length,
              sha256: createHash("sha256").update(data).digest("hex"),
            }),
          );
        }
      });
      await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${backend.address().port}`;
      let handle;
      let request;
      try {
        if (remote) {
          process.env.MCP_FILE_TEST = "mapped-backend";
          const auth = new Credentials(join(dir, "credentials"));
          const credential = await auth.create("file-client", "MCP_FILE_TEST");
          handle = await serveHttp(
            settings({
              ALPHAPILOT_BASE_URL: base,
              ALPHAPILOT_MCP_PORT: "0",
              ALPHAPILOT_MCP_CREDENTIAL_DIR: auth.directory,
              ALPHAPILOT_MCP_GROUPS: "core,files",
            }),
          );
          request = fileRequest(
            undefined,
            `http://127.0.0.1:${handle.server.address().port}/mcp`,
            credential.token,
          );
        } else request = fileRequest(new ApiClient(base, "mapped-backend"));
        const csv = join(dir, "input.csv");
        await writeFile(csv, data);
        assert.equal((await uploadFile(request, csv)).upload_id, "upload-test");
        assert.ok(uploaded > data.length);
        const output = join(dir, "output.csv");
        await downloadFile(request, "artifact-test", output);
        assert.deepEqual(await readFile(output), data);
        corrupt = true;
        await assert.rejects(
          downloadFile(request, "artifact-test", output),
          (e) => e.error.code === "CHECKSUM_MISMATCH",
        );
        assert.deepEqual(await readFile(output), data);
        assert.ok(!(await readdir(dir)).some((f) => f.endsWith(".part")));
        const large = await open(join(dir, "large.csv"), "w");
        await large.truncate(50 * 1024 * 1024 + 1);
        await large.close();
        await assert.rejects(
          uploadFile(request, join(dir, "large.csv")),
          (e) => e.error.code === "INVALID_UPLOAD",
        );
      } finally {
        if (handle) await handle.close();
        backend.closeAllConnections();
        await new Promise((resolve) => backend.close(resolve));
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

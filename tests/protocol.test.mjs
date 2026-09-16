import { request as httpRequest } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { serveHttp } from "../dist/http.js";
import { settings } from "../dist/config.js";
import { Credentials } from "../dist/auth.js";
import { backend } from "./helpers.mjs";
for (const transport of ["stdio", "http"])
  for (const revision of ["2025-11-25", "2026-07-28"])
    test(
      `${transport} ${revision}: discovery, validation, idempotent submit, query, cancel`,
      { timeout: 30000 },
      async () => {
        const upstream = await backend();
        const temp = await mkdtemp(join(tmpdir(), "amcp-test-"));
        let handle;
        const options = revision.startsWith("2026")
          ? { versionNegotiation: { mode: { pin: revision } } }
          : {};
        const client = new Client(
          { name: "acceptance-test", version: "1.0.0" },
          options,
        );
        try {
          let connection;
          if (transport === "stdio")
            connection = new StdioClientTransport({
              command: process.execPath,
              args: [
                new URL("../dist/cli.js", import.meta.url).pathname,
                "serve",
              ],
              env: {
                ...process.env,
                ALPHAPILOT_BASE_URL: upstream.url,
                ALPHAPILOT_RESEARCH_TOKEN: "backend-test",
              },
              stderr: "pipe",
            });
          else {
            process.env.MCP_TEST_BACKEND = "backend-test";
            const credentials = new Credentials(temp);
            const created = await credentials.create(
              "test-client",
              "MCP_TEST_BACKEND",
            );
            handle = await serveHttp(
              settings({
                ALPHAPILOT_BASE_URL: upstream.url,
                ALPHAPILOT_MCP_PORT: "0",
                ALPHAPILOT_MCP_CREDENTIAL_DIR: temp,
              }),
            );
            connection = new StreamableHTTPClientTransport(
              new URL(`http://127.0.0.1:${handle.server.address().port}/mcp`),
              {
                requestInit: {
                  headers: { Authorization: `Bearer ${created.token}` },
                },
              },
            );
          }
          await client.connect(connection);
          const tools = await client.listTools();
          assert.ok(
            tools.tools.find((t) => t.name === "submit_factor_backtest"),
          );
          assert.ok(!tools.tools.find((t) => t.name === "download_data"));
          const validation = await client.callTool({
            name: "validate_factors",
            arguments: { expressions: ["invalid()"] },
          });
          assert.equal(validation.isError, false, JSON.stringify(validation));
          assert.equal(
            validation.structuredContent.data.results[0].valid,
            false,
          );
          assert.deepEqual(
            JSON.parse(validation.content[0].text),
            validation.structuredContent,
          );
          const args = {
            dataset_id: "test",
            factor_source: {
              type: "inline",
              factors: [{ name: "close", expression: "$close" }],
            },
            idempotency_key: "intent-1",
          };
          const submitted = await client.callTool({
            name: "submit_factor_backtest",
            arguments: args,
          });
          assert.equal(submitted.isError, false, JSON.stringify(submitted));
          const id = submitted.structuredContent.data.job_id;
          const repeated = await client.callTool({
            name: "submit_factor_backtest",
            arguments: args,
          });
          assert.equal(repeated.structuredContent.data.job_id, id);
          const conflict = await client.callTool({
            name: "submit_factor_backtest",
            arguments: { ...args, mode: "multi_combined" },
          });
          assert.equal(conflict.isError, true);
          assert.equal(
            conflict.structuredContent.error.code,
            "IDEMPOTENCY_CONFLICT",
          );
          const job = await client.callTool({
            name: "get_job",
            arguments: { job_id: id },
          });
          assert.equal(job.structuredContent.data.status, "queued");
          assert.ok(!("normalized_input" in job.structuredContent.data));
          const cancelled = await client.callTool({
            name: "cancel_job",
            arguments: { job_id: id },
          });
          assert.equal(cancelled.structuredContent.data.status, "cancelled");
          assert.ok(
            upstream.calls.every(
              (c) => c.headers.authorization === "Bearer backend-test",
            ),
          );
        } finally {
          await client.close();
          if (handle) await handle.close();
          await upstream.close();
          await rm(temp, { recursive: true, force: true });
        }
      },
    );
test("HTTP credentials are isolated and revoked per request; Host and Origin rejected", async () => {
  const upstream = await backend();
  const temp = await mkdtemp(join(tmpdir(), "amcp-auth-"));
  process.env.MCP_FULL = "backend-test";
  process.env.MCP_READ = "reader-test";
  const auth = new Credentials(temp);
  const full = await auth.create("full", "MCP_FULL");
  const reader = await auth.create("reader", "MCP_READ");
  const handle = await serveHttp(
    settings({
      ALPHAPILOT_BASE_URL: upstream.url,
      ALPHAPILOT_MCP_PORT: "0",
      ALPHAPILOT_MCP_CREDENTIAL_DIR: temp,
    }),
  );
  const url = `http://127.0.0.1:${handle.server.address().port}`;
  try {
    assert.equal((await fetch(url + "/readyz")).status, 401);
    assert.equal(
      await new Promise((resolve, reject) => {
        const req = httpRequest(
          url + "/healthz",
          { headers: { Host: "attacker.example" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      }),
      403,
    );
    assert.equal(
      (
        await fetch(url + "/healthz", {
          headers: { Origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url + "/readyz", {
          headers: { Authorization: `Bearer ${full.token}` },
        })
      ).status,
      200,
    );
    const client = new Client({ name: "reader", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
          requestInit: { headers: { Authorization: `Bearer ${reader.token}` } },
        }),
      );
      const tools = await client.listTools();
      assert.ok(!tools.tools.some((t) => t.name === "start_mining"));
      assert.ok(tools.tools.some((t) => t.name === "validate_factors"));
    } finally {
      await client.close();
    }
    await auth.revoke(full.credential_id);
    assert.equal(
      (
        await fetch(url + "/readyz", {
          headers: { Authorization: `Bearer ${full.token}` },
        })
      ).status,
      401,
    );
    const stored = await readFile(
      join(temp, full.credential_id + ".json"),
      "utf8",
    );
    assert.ok(!stored.includes(full.token));
    assert.ok(!stored.includes("backend-test"));
  } finally {
    await handle.close();
    await upstream.close();
    await rm(temp, { recursive: true, force: true });
  }
});

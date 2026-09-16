import { createServer } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  hostHeaderValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { Credentials } from "./auth.js";
import { ApiClient, Failure, failure } from "./client.js";
import { settings } from "./config.js";
import { buildServer } from "./server.js";
export async function serveHttp(config: ReturnType<typeof settings>) {
  const credentials = new Credentials(config.credentialDir);
  const validHost = hostHeaderValidation(config.allowedHosts);
  const handler = createMcpHandler(
    async (ctx) => {
      const identity = await credentials.authenticate(
        ctx.requestInfo?.headers.get("authorization") ?? undefined,
      );
      return buildServer(
        new ApiClient(
          config.base,
          identity.token,
          identity.clientId,
          config.timeoutMs,
        ),
        config.enabled,
      );
    },
    { legacy: "stateless" },
  );
  const nodeHandler = toNodeHandler(handler, {
    onerror: () => console.error(JSON.stringify({ event: "transport_error" })),
  });
  const server = createServer(async (req, res) => {
    try {
      if (!validHost(req, res)) return;
      if (
        req.headers.origin &&
        !config.allowedOrigins.includes(req.headers.origin)
      ) {
        res.writeHead(403);
        res.end("Origin forbidden");
        return;
      }
      const path = new URL(req.url ?? "/", `http://${req.headers.host}`)
        .pathname;
      if (path === "/healthz" && req.method === "GET") {
        res.setHeader("Content-Type", "application/json");
        res.end('{"alive":true}');
        return;
      }
      const identity = await credentials.authenticate(
        req.headers.authorization,
      );
      const client = new ApiClient(
        config.base,
        identity.token,
        identity.clientId,
        config.timeoutMs,
      );
      if (path === "/readyz" && req.method === "GET") {
        await client.capabilities();
        res.setHeader("Content-Type", "application/json");
        res.end('{"ready":true}');
        return;
      }
      if (path === "/mcp") {
        // Bound JSON-RPC messages before the SDK Node adapter buffers them.
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024)
            throw failure("REQUEST_TOO_LARGE", "MCP request limit is 1 MiB");
          chunks.push(chunk);
        }
        let body: any;
        try {
          body = chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
            : undefined;
        } catch {
          res.writeHead(400);
          res.end("Invalid JSON");
          return;
        }
        await nodeHandler(req, res, body);
        return;
      }
      const fileMatch =
        /^\/files\/(uploads|artifacts\/([A-Za-z0-9_-]+)(\/content)?)$/.exec(
          path,
        );
      if (
        !fileMatch ||
        (fileMatch[1] === "uploads"
          ? req.method !== "POST"
          : req.method !== "GET")
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (!config.enabled.has("files"))
        throw failure("TOOL_UNAVAILABLE", "File transfer group is disabled");
      const signal = AbortSignal.timeout(300000);
      const abort = new AbortController();
      req.on("aborted", () => abort.abort());
      res.on("close", () => {
        if (!res.writableEnded) abort.abort();
      });
      const combined = AbortSignal.any([signal, abort.signal]);
      let init: RequestInit = { method: req.method, signal: combined };
      if (req.method === "POST") {
        const contentType = req.headers["content-type"] ?? "";
        if (!contentType.startsWith("multipart/form-data;"))
          throw failure("INVALID_UPLOAD", "Multipart upload required");
        const max = 50 * 1024 * 1024 + 65536;
        let count = 0;
        if (Number(req.headers["content-length"] ?? 0) > max)
          throw failure("UPLOAD_TOO_LARGE", "Upload limit is 50 MiB");
        const limited = new Transform({
          transform(chunk, _encoding, callback) {
            count += chunk.length;
            callback(
              count > max
                ? failure("UPLOAD_TOO_LARGE", "Upload limit is 50 MiB")
                : null,
              chunk,
            );
          },
        });
        req.pipe(limited);
        init = {
          ...init,
          headers: { "Content-Type": contentType },
          body: Readable.toWeb(limited) as any,
          ...{ duplex: "half" },
        };
      }
      const upstream = await client.raw("/api/v1/" + fileMatch[1], init);
      res.statusCode = upstream.status;
      for (const key of [
        "content-type",
        "content-length",
        "content-disposition",
        "x-request-id",
      ]) {
        const value = upstream.headers.get(key);
        if (value) res.setHeader(key, value);
      }
      if (upstream.body)
        await pipeline(Readable.fromWeb(upstream.body as any), res, {
          signal: combined,
        });
      else res.end();
      console.error(
        JSON.stringify({
          event: "file_transfer",
          client: identity.clientId,
          method: req.method,
          status: upstream.status,
        }),
      );
    } catch (e) {
      const err =
        e instanceof Failure
          ? e
          : failure("INTERNAL_ERROR", "Request could not be completed");
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(
        err.status ||
          (err.error.code === "UNAUTHENTICATED"
            ? 401
            : err.error.code === "UPLOAD_TOO_LARGE" ||
                err.error.code === "REQUEST_TOO_LARGE"
              ? 413
              : err.error.code === "TOOL_UNAVAILABLE"
                ? 403
                : 503),
        { "Content-Type": "application/json" },
      );
      res.end(JSON.stringify(err.error));
    }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 15000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await handler.close();
    },
  };
}

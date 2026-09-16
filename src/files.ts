import { openAsBlob, createWriteStream } from "node:fs";
import { stat, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiClient, boundedJson, failure, Failure } from "./client.js";
export type FileRequest = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;
export function fileRequest(
  client: ApiClient | undefined,
  remote?: string,
  token?: string,
): FileRequest {
  if (remote) {
    const base = new URL(remote);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw failure("INVALID_CONFIG", "Invalid MCP gateway URL");
    if (!token)
      throw failure(
        "INVALID_CONFIG",
        "ALPHAPILOT_MCP_TOKEN is required for remote file transfer",
      );
    return (path, init = {}) =>
      fetch(
        base.href.replace(/\/mcp\/?$/, "").replace(/\/$/, "") +
          path.replace("/api/v1/", "/files/"),
        {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${token}` },
          redirect: "error",
        },
      );
  }
  if (!client) throw failure("INVALID_CONFIG", "Backend client is required");
  return (path, init) => client.raw(path, init);
}
async function checked(response: Response) {
  if (!response.ok) {
    const data = await boundedJson(response, 65536);
    throw new Failure(
      {
        code: data?.code ?? `HTTP_${response.status}`,
        message: data?.message ?? "File transfer failed",
        details: data?.details ?? null,
        retryable: false,
        request_id: data?.request_id ?? randomUUID(),
      },
      response.status,
    );
  }
  return response;
}
export async function uploadFile(request: FileRequest, path: string) {
  const suffix = extname(path).toLowerCase();
  const info = await stat(path);
  if (
    ![".csv", ".json", ".pdf"].includes(suffix) ||
    !info.isFile() ||
    info.size === 0 ||
    info.size > 50 * 1024 * 1024
  )
    throw failure(
      "INVALID_UPLOAD",
      "Upload must be a nonempty CSV, JSON or PDF file up to 50 MiB",
    );
  const form = new FormData();
  form.append("file", await openAsBlob(path), basename(path));
  return boundedJson(
    await checked(
      await request("/api/v1/uploads", {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(300000),
      }),
    ),
    65536,
  );
}
export async function downloadFile(
  request: FileRequest,
  id: string,
  output: string,
) {
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    throw failure("INVALID_ID", "Invalid artifact ID");
  const signal = AbortSignal.timeout(300000);
  const metadata = await boundedJson(
    await checked(await request(`/api/v1/artifacts/${id}`, { signal })),
    65536,
  );
  if (
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0 ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  )
    throw failure(
      "INVALID_ARTIFACT",
      "Artifact has no reliable size and SHA-256",
    );
  const response = await checked(
    await request(`/api/v1/artifacts/${id}/content`, { signal }),
  );
  if (!response.body)
    throw failure("INVALID_ARTIFACT", "Artifact body is missing");
  const temp = join(
    dirname(output),
    `.${basename(output)}.${randomUUID()}.part`,
  );
  const digest = createHash("sha256");
  let size = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body as any),
      new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > metadata.size)
            return callback(
              failure(
                "CHECKSUM_MISMATCH",
                "Downloaded content exceeds declared size",
              ),
            );
          digest.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(temp, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (size !== metadata.size || digest.digest("hex") !== metadata.sha256)
      throw failure(
        "CHECKSUM_MISMATCH",
        "Artifact checksum or size mismatch; destination was not changed",
      );
    await rename(temp, output);
    return { artifact_id: id, size, sha256: metadata.sha256, output };
  } finally {
    await unlink(temp).catch(() => {});
  }
}

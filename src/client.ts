import { randomUUID } from "node:crypto";
import type { components } from "./api.generated.js";
export type Capabilities = components["schemas"]["Capabilities"];
export type ApiError = {
  code: string;
  message: string;
  details: unknown;
  retryable: boolean;
  request_id: string;
};
export class Failure extends Error {
  constructor(
    public error: ApiError,
    public status = 0,
    public retryAfter?: number,
  ) {
    super(error.message);
  }
}
export function failure(
  code: string,
  message: string,
  details: unknown = null,
  retryable = false,
) {
  return new Failure({
    code,
    message,
    details,
    retryable,
    request_id: randomUUID(),
  });
}
export function safeBase(value: string): string {
  const u = new URL(value);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw failure(
      "INVALID_CONFIG",
      "Backend URL must be HTTP(S) without credentials, query or fragment",
    );
  return u.href.replace(/\/$/, "").replace(/\/api\/v1$/, "");
}
export type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  submit?: boolean;
  maxBytes?: number;
};
export async function boundedJson(
  response: Response,
  limit: number,
): Promise<any> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          await reader.cancel();
          throw failure(
            "RESULT_TOO_LARGE",
            "Result exceeds the byte limit. Reduce limit/max_points, request summary, or use the file CLI. The cursor has not been consumed.",
            { limit },
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw failure(
      "INVALID_UPSTREAM_RESPONSE",
      "Backend returned non-JSON content",
    );
  }
}
export class ApiClient {
  readonly base: string;
  constructor(
    base: string,
    private token: string,
    readonly clientId = "stdio",
    readonly timeoutMs = 30_000,
    private fetcher: typeof fetch = fetch,
  ) {
    this.base = safeBase(base);
    if (!token)
      throw failure("INVALID_CONFIG", "A research credential is required");
  }
  async request(
    path: string,
    options: RequestOptions = {},
  ): Promise<{ data: any; requestId: string }> {
    if (!path.startsWith("/api/v1/") || path.includes(".."))
      throw failure(
        "INVALID_ROUTE",
        "Only registered research API routes are allowed",
      );
    const method = options.method ?? "GET";
    const retry = method === "GET" || !!options.submit;
    const key = options.headers?.["Idempotency-Key"];
    if (options.submit && !key)
      throw failure(
        "INVALID_INPUT",
        "Task submission requires an idempotency key",
      );
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    let uncertain = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.fetcher(this.base + path, {
          method,
          signal,
          redirect: "error",
          headers: {
            ...options.headers,
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
        });
        const requestId = response.headers.get("x-request-id") || randomUUID();
        const data = await boundedJson(response, options.maxBytes ?? 65536);
        if (response.ok) return { data, requestId };
        const delay = response.headers.get("retry-after");
        const seconds = delay
          ? /^\d+(\.\d+)?$/.test(delay)
            ? Number(delay)
            : Math.max(0, (Date.parse(delay) - Date.now()) / 1000)
          : undefined;
        throw new Failure(
          {
            code: data?.code ?? `HTTP_${response.status}`,
            message: data?.message ?? "Backend request failed",
            details: data?.details ?? null,
            retryable:
              data?.retryable ?? [429, 502, 503, 504].includes(response.status),
            request_id: data?.request_id ?? requestId,
          },
          response.status,
          seconds,
        );
      } catch (e) {
        const err =
          e instanceof Failure
            ? e
            : failure(
                signal.aborted ? "REQUEST_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
                signal.aborted
                  ? "MCP call ended; any submitted backend job continues."
                  : "Backend connection failed",
                null,
                true,
              );
        if (options.submit && (!err.status || err.status >= 500))
          uncertain = true;
        if (
          retry &&
          attempt < 2 &&
          !signal.aborted &&
          (err.error.retryable || [429, 502, 503, 504].includes(err.status))
        ) {
          const delay = Math.max(
            100 * 2 ** attempt,
            (err.retryAfter ?? 0) * 1000,
          );
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                signal.removeEventListener("abort", abort);
                resolve();
              }, delay);
              const abort = () => {
                clearTimeout(timer);
                reject(err);
              };
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            });
            continue;
          } catch {
            /* deadline: preserve uncertainty */
          }
        }
        if (uncertain)
          throw new Failure(
            {
              ...err.error,
              code: "SUBMISSION_UNCONFIRMED",
              message:
                "Submission outcome is unconfirmed. Retry the exact same input with the same idempotency_key; do not create a new key.",
              details: { idempotency_key: key, cause: err.error.code },
              retryable: true,
            },
            err.status,
            err.retryAfter,
          );
        throw err;
      }
    }
  }
  async capabilities(signal?: AbortSignal): Promise<Capabilities> {
    const { data } = await this.request("/api/v1/capabilities", { signal });
    if (
      typeof data.api_version !== "string" ||
      data.api_version.split(".")[0] !== "1"
    )
      throw failure(
        "API_VERSION_UNSUPPORTED",
        "AlphaPilot API major version 1 is required",
      );
    return data;
  }
  async raw(path: string, init: RequestInit = {}): Promise<Response> {
    if (!/^\/api\/v1\/(uploads|artifacts\/[^/]+(\/content)?)$/.test(path))
      throw failure("INVALID_ROUTE", "Unsupported file route");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    return this.fetcher(this.base + path, {
      ...init,
      headers,
      redirect: "error",
    });
  }
}

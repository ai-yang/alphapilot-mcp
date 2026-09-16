import { readFileSync } from "node:fs";
export type Schema = Record<string, any>;
export const contract = JSON.parse(
  readFileSync(new URL("../contract/openapi-v1.json", import.meta.url), "utf8"),
);
// Dereference the pinned contract, preserving recursive JSON values as unconstrained JSON.
export function resolve(value: any, seen: string[] = []): any {
  if (Array.isArray(value)) return value.map((v) => resolve(v, seen));
  if (!value || typeof value !== "object") return value;
  if (value.$ref) {
    const name = value.$ref.split("/").pop();
    if (seen.includes(name)) {
      if (name === "JsonValue") return {};
      throw new Error(`Unexpected recursive schema ${name}`);
    }
    return resolve(contract.components.schemas[name], [...seen, name]);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !["discriminator", "title"].includes(k))
      .map(([k, v]) => [k, resolve(v, seen)]),
  );
}
export const object = (properties: Schema = {}, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
export const string = { type: "string", minLength: 1 };
export const detail = {
  type: "string",
  enum: ["summary", "full"],
  default: "summary",
};
export const keySchema = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description:
    "Stable key for one research intent. Reuse with identical input after a lost response.",
};
export function envelope(data: Schema) {
  return object(
    {
      ok: { type: "boolean" },
      data: { anyOf: [data, { type: "null" }] },
      error: {
        anyOf: [
          object(
            {
              code: string,
              message: { type: "string" },
              details: {},
              retryable: { type: "boolean" },
              request_id: string,
            },
            ["code", "message", "details", "retryable", "request_id"],
          ),
          { type: "null" },
        ],
      },
      meta: object(
        {
          request_id: string,
          idempotency_key: { type: "string" },
          retry_after_seconds: { type: "number" },
        },
        ["request_id"],
      ),
    },
    ["ok", "data", "error", "meta"],
  );
}

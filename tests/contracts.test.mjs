import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { registry, available, checkCall } from "../dist/registry.js";
import { contract } from "../dist/schema.js";
import { caps } from "./helpers.mjs";
const ajv = new Ajv({ strict: false });
formats(ajv);
test("all registered tools reference pinned routes and compile strict inputs and outputs", () => {
  assert.equal(new Set(registry.map((t) => t.name)).size, registry.length);
  for (const tool of registry) {
    assert.ok(
      contract.paths[tool.path]?.[tool.method.toLowerCase()],
      tool.name,
    );
    assert.equal(tool.input.additionalProperties, false);
    ajv.compile(tool.input);
    ajv.compile(tool.output);
    for (const key of [
      "token",
      "client_id",
      "path",
      "base_url",
      "module",
      "kwargs",
    ])
      assert.ok(!(key in tool.input.properties), tool.name);
  }
});
test("inline/library backtest modes and bounded parameters follow backend schemas", () => {
  const schema = registry.find(
    (t) => t.name === "submit_factor_backtest",
  ).input;
  const validate = ajv.compile(schema);
  const args = {
    dataset_id: "baostock_cn:day:forward",
    factor_source: {
      type: "inline",
      factors: [{ name: "test", expression: "$close" }],
    },
    idempotency_key: "intent-1",
  };
  for (const mode of ["single_ic", "multi_combined", "multi_sequential"])
    assert.ok(validate({ ...args, mode }), JSON.stringify(validate.errors));
  assert.ok(
    validate({
      ...args,
      factor_source: { type: "library", factor_ids: ["factor-1"] },
    }),
  );
  assert.ok(
    !validate({ ...args, parameters: { arbitrary_class: "os.system" } }),
  );
  assert.ok(
    !validate({
      ...args,
      factor_source: { ...args.factor_source, factor_ids: ["x"] },
    }),
  );
  assert.ok(!validate({ ...args, idempotency_key: "" }));
});
test("groups, algorithm capabilities and scopes intersect; models cannot enable data writes through schedules", () => {
  for (const name of [
    "create_schedule",
    "update_schedule",
    "pause_schedule",
    "resume_schedule",
  ]) {
    assert.ok(
      !available(
        registry.find((t) => t.name === name),
        { ...caps, scopes: ["research:read", "schedules:write"] },
        new Set(["schedules"]),
      ),
      `${name} must require job submission permission`,
    );
  }
  const data = registry.find((t) => t.name === "download_data");
  assert.ok(!available(data, caps, new Set(["core"])));
  assert.ok(
    !available(data, { ...caps, scopes: ["research:read"] }, new Set(["data"])),
  );
  assert.throws(() =>
    checkCall(
      registry.find((t) => t.name === "create_schedule"),
      { job: { kind: "data", input: { action: "download" } } },
      caps,
      new Set(["core", "schedules"]),
    ),
  );
  assert.throws(() =>
    checkCall(
      registry.find((t) => t.name === "preview_daily_signals"),
      { refresh_data: true },
      { ...caps, scopes: ["research:read", "jobs:submit"] },
      new Set(["signals"]),
    ),
  );
});
test("mining requires finite bounds and advancing requires explicit session and date", () => {
  assert.ok(
    registry
      .find((t) => t.name === "start_mining")
      .input.required.includes("max_steps"),
  );
  assert.ok(
    registry
      .find((t) => t.name === "start_aff_mining")
      .input.required.includes("max_loops"),
  );
  const validate = ajv.compile(
    registry.find((t) => t.name === "advance_daily_signals").input,
  );
  assert.ok(!validate({ dataset_id: "x", idempotency_key: "key" }));
});

test("stock pool writes require the backend data permission in every tool group", () => {
  const groups = new Set(["core", "files", "cleanup"]);
  const researchOnly = {
    ...caps,
    scopes: caps.scopes.filter((scope) => scope !== "data:write"),
  };
  for (const name of [
    "create_stock_pool",
    "update_stock_pool",
    "import_stock_pools",
    "delete_stock_pool",
  ]) {
    const tool = registry.find((item) => item.name === name);
    assert.equal(available(tool, researchOnly, groups), false, name);
    assert.equal(available(tool, caps, groups), true, name);
  }
  for (const name of [
    "list_stock_pools",
    "get_stock_pool",
    "export_stock_pools",
    "create_factor",
  ]) {
    assert.equal(
      available(
        registry.find((item) => item.name === name),
        researchOnly,
        groups,
      ),
      true,
      name,
    );
  }
});

function example(schema) {
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined && schema.default !== null)
    return structuredClone(schema.default);
  if (schema.enum) return schema.enum[0];
  if (schema.oneOf || schema.anyOf)
    return example(
      (schema.oneOf ?? schema.anyOf).find((s) => s.type !== "null"),
    );
  if (schema.type === "object")
    return Object.fromEntries(
      (schema.required ?? []).map((k) => [k, example(schema.properties[k])]),
    );
  if (schema.type === "array")
    return Array.from({ length: schema.minItems ?? 0 }, () =>
      example(schema.items),
    );
  if (schema.type === "integer" || schema.type === "number")
    return Math.max(
      schema.minimum ?? 0,
      (schema.exclusiveMinimum ?? -1) + 1,
      1,
    );
  if (schema.type === "boolean") return false;
  if (schema.type === "null") return null;
  return schema.format === "date"
    ? "2020-01-01"
    : schema.pattern?.includes(":")
      ? "09:00"
      : "test-id";
}
test("every named tool maps valid inputs to its pinned HTTP operation with revision/idempotency headers", async () => {
  const { resolve } = await import("../dist/schema.js");
  for (const tool of registry) {
    const args = example(tool.input);
    const calls = [];
    const fake = {
      request: async (path, options = {}) => {
        calls.push({ path, ...options });
        if (
          path.startsWith("/api/v1/schedules/") &&
          options.method === undefined
        )
          return {
            data: {
              revision: 1,
              ...example(resolve(contract.components.schemas.ScheduleCreate)),
            },
            requestId: "test",
          };
        return {
          data: {
            media_type: "application/json",
            size: 1,
            job_id: "test-job",
            status: "queued",
            run_ids: [],
          },
          requestId: "test",
        };
      },
    };
    await tool.invoke(fake, args);
    const call = calls.at(-1);
    assert.ok(!call.path.includes("{"), tool.name);
    const endpoint = contract.paths[tool.path][tool.method.toLowerCase()];
    const request = endpoint.requestBody?.content?.["application/json"]?.schema;
    if (request) {
      const validate = ajv.compile(resolve(request));
      assert.ok(
        validate(call.body),
        tool.name + ": " + JSON.stringify(validate.errors),
      );
    }
    if (tool.input.required.includes("expected_revision"))
      assert.equal(
        call.headers["If-Match"],
        String(args.expected_revision),
        tool.name,
      );
    if (tool.submit)
      assert.equal(
        call.headers["Idempotency-Key"],
        args.idempotency_key,
        tool.name,
      );
  }
});

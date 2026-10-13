import { ApiClient, type Capabilities, failure } from "./client.js";
import {
  contract,
  resolve,
  object,
  string,
  detail,
  keySchema,
  envelope,
  type Schema,
} from "./schema.js";
export const groups = [
  "core",
  "data",
  "files",
  "signals",
  "schedules",
  "cleanup",
] as const;
export type Group = (typeof groups)[number];
export type Tool = {
  name: string;
  description: string;
  group: Group;
  scopes: string[];
  input: Schema;
  output: Schema;
  method: string;
  path: string;
  kind?: string;
  feature?: string;
  submit: boolean;
  readOnly: boolean;
  destructive: boolean;
  invoke: (
    client: ApiClient,
    args: any,
    signal?: AbortSignal,
  ) => Promise<{ data: any; requestId: string }>;
};
export const registry: Tool[] = [];
const endpoints = Object.entries(contract.paths).flatMap(([path, ops]: any) =>
  Object.entries(ops).map(([method, op]: any) => ({
    path,
    method: method.toUpperCase(),
    op,
  })),
);
const summaryFields = new Set([
  "normalized_input",
  "input",
  "artifact_ids",
  "artifacts",
]);
function summarize(data: any): any {
  if (Array.isArray(data)) return data.map(summarize);
  if (!data || typeof data !== "object") return data;
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => !summaryFields.has(key))
      .map(([key, value]) => [key, summarize(value)]),
  );
}
function summarySchema(schema: Schema): Schema {
  if (schema.type === "array")
    return { ...schema, items: summarySchema(schema.items) };
  if (schema.type !== "object") return schema;
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([key]) => !summaryFields.has(key))
        .map(([key, value]) => [key, summarySchema(value as Schema)]),
    ),
    required: schema.required?.filter((key: string) => !summaryFields.has(key)),
  };
}
function operation(id: string) {
  const entry = endpoints.find((e) => e.op.operationId === `research_${id}`);
  if (!entry) throw new Error(`Contract missing ${id}`);
  return entry;
}
export function add(
  name: string,
  id: string,
  group: Group = "core",
  scopes = ["research:read"],
  description?: string,
  aliases: Record<string, string> = {},
) {
  const { path, method, op } = operation(id);
  const body = resolve(
    op.requestBody?.content?.["application/json"]?.schema ?? object(),
  );
  const properties: Schema = { ...body.properties };
  const required = [...(body.required ?? [])];
  for (const p of op.parameters ?? []) {
    const key =
      p.in === "header"
        ? (
            {
              "if-match": "expected_revision",
              "idempotency-key": "idempotency_key",
            } as any
          )[p.name]
        : (aliases[p.name] ?? p.name);
    if (!key) continue;
    properties[key] =
      p.name === "if-match"
        ? { type: "integer", minimum: 1 }
        : p.name === "idempotency-key"
          ? keySchema
          : resolve(p.schema);
    if (p.required || p.name === "if-match") required.push(key);
  }
  const hasSummary = [
    "get_job",
    "list_jobs",
    "get_run",
    "list_runs",
    "job_result",
    "submit_job",
    "run_schedule",
  ].includes(id);
  if (hasSummary) properties.detail = detail;
  if (properties.include_artifacts) {
    delete properties.include_artifacts;
  }
  if (properties.limit)
    properties.limit = {
      type: "integer",
      minimum: 1,
      maximum: id === "job_logs" ? 32768 : 200,
      default: id === "job_logs" ? 8192 : 20,
    };
  if (properties.max_points)
    properties.max_points = {
      type: "integer",
      minimum: 2,
      maximum: 5000,
      default: 200,
    };
  const response: any = Object.entries(op.responses).find(([k]) =>
    /^2/.test(k),
  )?.[1];
  const output = resolve(response?.content?.["application/json"]?.schema ?? {});
  const submit = !!properties.idempotency_key;
  const tool: Tool = {
    name,
    description:
      description ??
      name.replaceAll("_", " ") +
        ". Uses resource IDs from AlphaPilot. Versioned changes require the latest expected_revision.",
    group,
    scopes,
    input: object(properties, required),
    output: envelope(
      hasSummary ? { anyOf: [output, summarySchema(output)] } : output,
    ),
    path,
    method,
    submit,
    readOnly: method === "GET" || id === "validate_factors",
    destructive:
      method === "DELETE" ||
      ["PATCH", "PUT"].includes(method) ||
      ["cancel_job", "signal_cash", "category_members"].includes(id),
    invoke: async (client, args, signal) => {
      let url = path;
      const query = new URLSearchParams();
      const headers: Record<string, string> = {};
      for (const p of op.parameters ?? []) {
        const key =
          p.in === "header"
            ? (
                {
                  "if-match": "expected_revision",
                  "idempotency-key": "idempotency_key",
                } as any
              )[p.name]
            : (aliases[p.name] ?? p.name);
        let value = args[key];
        if (p.name === "include_artifacts") value = false;
        if (value === undefined && properties[key]?.default !== undefined)
          value = properties[key].default;
        if (value === undefined || value === null) continue;
        if (p.in === "path") {
          if (
            !String(value) ||
            /[\/\\\x00]/.test(String(value)) ||
            [".", ".."].includes(String(value))
          )
            throw failure("INVALID_ID", "Expected an opaque resource ID");
          url = url.replace(`{${p.name}}`, encodeURIComponent(value));
        }
        if (p.in === "query") query.set(p.name, String(value));
        if (p.in === "header")
          headers[p.name === "if-match" ? "If-Match" : "Idempotency-Key"] =
            String(value);
      }
      if (query.size) url += "?" + query;
      const payload = op.requestBody
        ? Object.fromEntries(
            Object.keys(body.properties ?? {})
              .filter((k) => args[k] !== undefined)
              .map((k) => [k, args[k]]),
          )
        : undefined;
      const result = await client.request(url, {
        maxBytes:
          hasSummary && args.detail !== "full" ? 4 * 1024 * 1024 : 65536,
        method,
        body: payload,
        headers,
        signal,
        submit,
      });
      if (hasSummary && args.detail !== "full")
        result.data = summarize(result.data);
      return result;
    },
  };
  registry.push(tool);
  return tool;
}
const coreReads: Record<string, string> = {
  get_capabilities: "capabilities",
  get_status: "status",
  list_datasets: "datasets",
  list_templates: "templates",
  list_models: "models",
  get_factor_dsl: "factor_dsl",
  list_symbols: "dataset_symbols",
  get_market_bars: "dataset_bars",
  list_jobs: "list_jobs",
  get_job: "get_job",
  get_job_logs: "job_logs",
  get_job_result: "job_result",
  list_runs: "list_runs",
  get_run: "get_run",
  list_artifacts: "list_artifacts",
  get_artifact: "get_artifact",
  get_artifact_table: "artifact_table",
  get_artifact_series: "artifact_series",
  list_factor_categories: "factor_categories",
  find_duplicate_factors: "factor_duplicates",
};
for (const [name, id] of Object.entries(coreReads)) add(name, id);
registry.find((t) => t.name === "list_artifacts")!.feature =
  "artifact_pagination";
registry.find((t) => t.name === "list_runs")!.feature = "run_job_filter";
add(
  "validate_factors",
  "validate_factors",
  "core",
  ["research:read"],
  "Validate expressions with the backend DSL validator. Invalid expressions are a successful query with structured validation issues.",
);
add(
  "cancel_job",
  "cancel_job",
  "core",
  ["research:read", "jobs:cancel"],
  "Explicitly cancel a backend research job. Disconnecting or cancelling an MCP call does not cancel the job.",
);
for (const [singular, plural, alias] of [
  ["factor", "factors", "factor_id"],
  ["strategy", "strategies", "strategy_id"],
  ["stock_pool", "stock_pools", "stock_pool_id"],
  ["signal_session", "signal_sessions", "session_id"],
]) {
  const group: Group = singular === "signal_session" ? "signals" : "core";
  const write =
    singular === "signal_session" ? "signals:write" : "research:write";
  const writeScopes = [
    "research:read",
    write,
    ...(singular === "stock_pool" ? ["data:write"] : []),
  ];
  add(`list_${plural}`, `list_${plural}`, group);
  add(`get_${singular}`, `get_${singular}`, group, undefined, undefined, {
    key: alias,
  });
  add(`create_${singular}`, `create_${singular}`, group, writeScopes);
  if (singular !== "signal_session")
    add(
      `update_${singular}`,
      `update_${singular}`,
      group,
      writeScopes,
      undefined,
      { key: alias },
    );
  add(
    `delete_${singular}`,
    `delete_${singular}`,
    "cleanup",
    writeScopes,
    undefined,
    { key: alias },
  );
  if (singular !== "signal_session") {
    add(`export_${plural}`, `export_${singular}`, "files", ["research:read"]);
    add(`import_${plural}`, `import_${singular}`, "files", [
      "research:read",
      "research:write",
      ...(singular === "stock_pool" ? ["data:write"] : []),
    ]);
  }
}
add("create_factor_category", "create_category", "core", [
  "research:read",
  "research:write",
]);
add(
  "rename_factor_category",
  "rename_category",
  "core",
  ["research:read", "research:write"],
  undefined,
  { name: "category_name" },
);
add("update_factor_category_members", "category_members", "core", [
  "research:read",
  "research:write",
]);
add(
  "delete_factor_category",
  "delete_category",
  "cleanup",
  ["research:read", "research:write"],
  undefined,
  { name: "category_name" },
);
for (const [name, id, alias] of [
  ["delete_job", "delete_job", "job_id"],
  ["delete_run", "delete_run", "run_id"],
  ["delete_upload", "delete_upload", "upload_id"],
])
  add(name, id, "cleanup", ["research:read", "research:write"], undefined, {
    key: alias,
  });
add("list_ocr_providers", "ocr_providers", "files");
add("commit_report_factors", "commit_report_factors", "files", [
  "research:read",
  "research:write",
]);
for (const id of ["signal_history", "signal_cashflows"])
  add("get_" + id, id, "signals", undefined, undefined, { key: "session_id" });
add(
  "adjust_simulation_cash",
  "signal_cash",
  "signals",
  ["research:read", "signals:write"],
  undefined,
  { key: "session_id" },
);
for (const action of ["list", "create", "update", "delete"])
  add(
    `${action}_schedule${action === "list" ? "s" : ""}`,
    `${action}_schedule${action === "list" ? "s" : ""}`,
    action === "delete" ? "cleanup" : "schedules",
    action === "list"
      ? ["research:read"]
      : action === "delete"
        ? ["research:read", "schedules:write"]
        : ["research:read", "schedules:write", "jobs:submit"],
    undefined,
    { key: "schedule_id" },
  );
add(
  "run_schedule",
  "run_schedule",
  "schedules",
  ["research:read", "schedules:write", "jobs:submit"],
  undefined,
  { key: "schedule_id" },
);
add("get_schedule_runtime", "schedule_status", "schedules");

function job(
  name: string,
  kind: string,
  schemaName: string,
  group: Group = "core",
  fixed: Record<string, any> = {},
  extraScopes: string[] = [],
) {
  const schema = resolve(contract.components.schemas[schemaName]);
  const props = { ...schema.properties };
  for (const key of Object.keys(fixed)) delete props[key];
  const required = (schema.required ?? []).filter((k: string) => !(k in fixed));
  if (kind === "daily_signals" && fixed.mode === "advance") {
    required.push("session_id", "date");
    props.session_id = string;
    props.date = { type: "string", format: "date" };
    delete props.strategy_id;
    delete props.init_cash;
  }
  const input = object(
    {
      ...props,
      timeout_seconds: resolve(
        contract.components.schemas.Budget.properties.timeout_seconds,
      ),
      idempotency_key: keySchema,
    },
    [...new Set([...required, "idempotency_key"])],
  );
  const tool: Tool = {
    name,
    kind,
    group,
    scopes: ["research:read", "jobs:submit", ...extraScopes],
    input,
    output: envelope(
      object(
        {
          job_id: string,
          status: { type: "string" },
          run_ids: { type: "array", items: string },
        },
        ["job_id", "status", "run_ids"],
      ),
    ),
    method: "POST",
    path: "/api/v1/jobs",
    submit: true,
    readOnly: false,
    destructive:
      group === "cleanup" ||
      kind === "data" ||
      (kind === "daily_signals" && fixed.mode === "advance"),
    description: `Submit ${name.replaceAll("_", " ")} as a durable background job. Returns immediately; use get_job and get_job_result. Discover IDs first. Reuse idempotency_key and identical inputs on uncertain responses. No waiting for execution.`,
    invoke: async (client, args, signal) => {
      const { idempotency_key, timeout_seconds = 3600, ...parameters } = args;
      const result = await client.request("/api/v1/jobs", {
        maxBytes: 4 * 1024 * 1024,
        method: "POST",
        body: {
          kind,
          input: { ...parameters, ...fixed },
          budget: { timeout_seconds },
          notify: false,
        },
        headers: { "Idempotency-Key": idempotency_key },
        submit: true,
        signal,
      });
      result.data = {
        job_id: result.data.job_id,
        status: result.data.status,
        run_ids: result.data.run_ids,
      };
      return result;
    },
  };
  registry.push(tool);
}
job("start_mining", "mine", "MiningInput", "core", {}, ["research:write"]);
job("start_aff_mining", "mine_aff", "AFFInput");
job("start_gp_mining", "mine_gp", "GPInput");
job("start_rl_mining", "mine_rl", "RLInput");
job("submit_factor_backtest", "factor_backtest", "FactorBacktestInput");
job(
  "submit_strategy_backtest",
  "strategy_backtest",
  "StrategyBacktestInput",
  "core",
  {},
  ["research:write"],
);
job("extract_report_factors", "report_factor_extract", "ReportInput", "files");
job("preview_daily_signals", "daily_signals", "DailyInput", "signals", {
  mode: "preview",
});
job(
  "advance_daily_signals",
  "daily_signals",
  "DailyInput",
  "signals",
  { mode: "advance" },
  ["signals:write"],
);
for (const [name, action, schema] of [
  ["download_data", "download", "DataDownload"],
  ["update_data", "update", "DataDownload"],
  ["prepare_data", "pipeline", "DataDownload"],
  ["convert_data", "convert", "DataConvert"],
  ["apply_data_adjustment", "apply_adjust", "DataAdjust"],
  ["refresh_symbol_data", "refresh_symbol", "DataRefresh"],
  ["trim_symbol_data", "trim_symbol", "DataTrim"],
  ["adjust_symbol_data", "apply_adjust_symbol", "DataAdjustSymbol"],
  ["delete_symbol_data", "delete_symbol", "DataDelete"],
])
  job(
    name,
    "data",
    schema,
    action === "delete_symbol" || action === "trim_symbol" ? "cleanup" : "data",
    { action },
    ["data:write"],
  );

export function available(
  tool: Tool,
  caps: Capabilities,
  enabled: Set<string>,
): boolean {
  return (
    enabled.has(tool.group) &&
    tool.scopes.every((s) => caps.scopes.includes(s)) &&
    (!tool.feature || !!caps.features?.[tool.feature]) &&
    (!tool.kind ||
      caps.algorithms.some((a) => a.kind === tool.kind && a.available))
  );
}
export function checkCall(
  tool: Tool,
  args: any,
  caps: Capabilities,
  enabled: Set<string>,
) {
  if (!available(tool, caps, enabled))
    throw failure(
      "TOOL_UNAVAILABLE",
      "Tool is disabled by configuration, backend capabilities or credential permissions",
    );
  const extra: string[] = [];
  if (args.refresh_data) extra.push("data:write");
  if (args.save || args.save_factors_to_library || args.save_as)
    extra.push("research:write");
  if (extra.some((s) => !caps.scopes.includes(s)))
    throw failure(
      "FORBIDDEN",
      "Credential lacks permissions for the selected write options",
    );
  if (args.resume_run_id && !caps.features?.mining_checkpoint_resume)
    throw failure(
      "FEATURE_UNAVAILABLE",
      "Backend does not support checkpoint resume",
    );
  if ((args.timeout_seconds ?? 3600) > caps.limits.max_timeout_seconds)
    throw failure("INVALID_BUDGET", "Task timeout exceeds backend budget");
  // A schedule cannot unlock a job group disabled at deployment.
  if (args.job) {
    const candidate = registry.find(
      (t) =>
        t.kind === args.job.kind &&
        (t.kind !== "data" ||
          t.input.properties.action?.const === args.job.input.action ||
          t.name ===
            (
              {
                download: "download_data",
                update: "update_data",
                pipeline: "prepare_data",
                convert: "convert_data",
                apply_adjust: "apply_data_adjustment",
                refresh_symbol: "refresh_symbol_data",
                trim_symbol: "trim_symbol_data",
                apply_adjust_symbol: "adjust_symbol_data",
                delete_symbol: "delete_symbol_data",
              } as any
            )[args.job.input.action]) &&
        (t.kind !== "daily_signals" ||
          t.name === `${args.job.input.mode}_daily_signals`),
    );
    if (!candidate)
      throw failure("TOOL_UNAVAILABLE", "Scheduled job is not supported");
    checkCall(
      candidate,
      { ...args.job.input, timeout_seconds: args.job.budget?.timeout_seconds },
      caps,
      enabled,
    );
  }
}

add("get_schedule", "get_schedule", "schedules", undefined, undefined, {
  key: "schedule_id",
});
for (const [name, enabled] of [
  ["pause_schedule", false],
  ["resume_schedule", true],
] as const) {
  const tool = add(
    name,
    "update_schedule",
    "schedules",
    ["research:read", "schedules:write", "jobs:submit"],
    `${enabled ? "Resume" : "Pause"} a research schedule using its expected revision.`,
    { key: "schedule_id" },
  );
  const update = tool.invoke;
  tool.input = object(
    { schedule_id: string, expected_revision: { type: "integer", minimum: 1 } },
    ["schedule_id", "expected_revision"],
  );
  tool.invoke = async (client, args, signal) => {
    const { data } = await client.request(
      `/api/v1/schedules/${encodeURIComponent(args.schedule_id)}`,
      { signal },
    );
    if (data.revision !== args.expected_revision)
      throw failure(
        "VERSION_CONFLICT",
        "Schedule changed; read its current revision before updating",
      );
    return update(
      client,
      {
        ...args,
        ...Object.fromEntries(
          ["name", "time", "timezone", "job"].map((k) => [k, data[k]]),
        ),
        enabled,
      },
      signal,
    );
  };
}

const jsonArtifact = add(
  "read_artifact_json",
  "artifact_content",
  "core",
  ["research:read"],
  "Read a small JSON metrics or summary artifact. Large files use the file CLI; CSV data uses get_artifact_table or get_artifact_series.",
);
const readJson = jsonArtifact.invoke;
jsonArtifact.invoke = async (client, args, signal) => {
  const { data } = await client.request(
    `/api/v1/artifacts/${encodeURIComponent(args.artifact_id)}`,
    { signal },
  );
  if (data.media_type !== "application/json")
    throw failure(
      "UNSUPPORTED_ARTIFACT",
      "Use the table/series tool or file CLI for this artifact",
    );
  if (data.size > 65536)
    throw failure(
      "RESULT_TOO_LARGE",
      "JSON artifact exceeds 64 KiB; use the file CLI",
    );
  return readJson(client, args, signal);
};

for (const name of [
  "get_schedule",
  "run_schedule",
  "pause_schedule",
  "resume_schedule",
]) {
  registry.find((tool) => tool.name === name)!.feature = "schedule_detail";
}

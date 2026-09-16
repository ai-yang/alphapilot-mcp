import { registry } from "../dist/registry.js";
import { writeFile } from "node:fs/promises";
const rows = registry.map(
  (t) =>
    `| ${t.name} | ${t.group} | ${t.method} ${t.path} | ${t.scopes.join(", ")} |`,
);
await writeFile(
  new URL("../docs/tools.md", import.meta.url),
  "# 工具映射\n\n由固定注册表生成；可选保存、刷新数据等参数还需要额外权限。\n\n| 工具 | 组 | HTTP 映射 | 基本权限 |\n|---|---|---|---|\n" +
    rows.join("\n") +
    "\n",
);
console.log(
  JSON.stringify({
    tools: registry.length,
    groups: Object.fromEntries(
      [...new Set(registry.map((t) => t.group))].map((g) => [
        g,
        registry.filter((t) => t.group === g).length,
      ]),
    ),
  }),
);

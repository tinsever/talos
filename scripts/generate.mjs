import { readFile, writeFile, mkdir } from "node:fs/promises";
import openapiTS, { astToString } from "openapi-typescript";

const spec = JSON.parse(
  await readFile(new URL("../schema/openapi.json", import.meta.url), "utf8"),
);
const overrides = JSON.parse(
  await readFile(new URL("../schema/overrides.json", import.meta.url), "utf8"),
);
const methods = ["get", "post", "put", "patch", "delete", "head", "options"];
const routes = {};
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of methods) {
    const operation = item[method];
    const key = `${method.toUpperCase()} ${path}`;
    if (operation)
      routes[key] = {
        authenticated:
          overrides[key]?.authenticated ??
          (operation.security ?? spec.security ?? []).length > 0,
      };
  }
}
for (const key of Object.keys(overrides))
  if (!(key in routes)) throw new Error(`Stale schema override: ${key}`);
const banner =
  "// Generated from schema/openapi.json. Do not edit. Upstream schema: AGPL-3.0.\n";
const outputs = {
  "api.ts":
    banner + astToString(await openapiTS(spec, { defaultNonNullable: false })),
  "routes.ts":
    banner +
    `export const routes = ${JSON.stringify(routes, null, 2)} as const;\n`,
};
await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
for (const [name, content] of Object.entries(outputs)) {
  const target = new URL(`../src/generated/${name}`, import.meta.url);
  if (process.argv.includes("--check")) {
    if ((await readFile(target, "utf8")) !== content)
      throw new Error(`Generated ${name} is stale. Run bun run generate.`);
  } else await writeFile(target, content);
}
console.log(
  `${Object.keys(routes).length} operations across ${Object.keys(spec.paths).length} paths verified.`,
);

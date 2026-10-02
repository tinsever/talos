import { readFile, writeFile, mkdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
const source = JSON.parse(
  await readFile(new URL("../schema/source.json", import.meta.url), "utf8"),
);
const ref =
  process.argv.find((arg) => arg.startsWith("--ref="))?.slice(6) ?? "main";
const commitResponse = await fetch(
  `https://api.github.com/repos/fluxerapp/fluxer/commits/${encodeURIComponent(ref)}`,
  {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30000),
  },
);
if (!commitResponse.ok)
  throw new Error(`Upstream commit lookup returned ${commitResponse.status}`);
const commit = (await commitResponse.json()).sha;
const url = source.url.replace(source.commit, commit),
  response = await fetch(url, { signal: AbortSignal.timeout(30000) });
if (!response.ok)
  throw new Error(`Upstream schema returned ${response.status}`);
const schemaText = await response.text(),
  next = JSON.parse(schemaText),
  previous = JSON.parse(
    await readFile(new URL("../schema/openapi.json", import.meta.url), "utf8"),
  );
const operations = (spec) =>
  new Map(
    Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([method]) =>
          ["get", "post", "put", "patch", "delete", "head", "options"].includes(
            method,
          ),
        )
        .map(([method, operation]) => [
          `${method.toUpperCase()} ${path}`,
          operation,
        ]),
    ),
  );
const old = operations(previous),
  current = operations(next),
  added = [],
  removed = [],
  changed = [];
for (const [key, value] of current)
  if (!old.has(key)) added.push(key);
  else if (JSON.stringify(old.get(key)) !== JSON.stringify(value))
    changed.push(key);
for (const key of old.keys()) if (!current.has(key)) removed.push(key);
const schemaChanges = [];
for (const [name, value] of Object.entries(next.components.schemas))
  if (
    JSON.stringify(previous.components.schemas[name]) !== JSON.stringify(value)
  )
    schemaChanges.push(name);
const removedSchemas = Object.keys(previous.components.schemas).filter(
  (name) => !next.components.schemas[name],
);
const report = {
  pinnedCommit: source.commit,
  upstreamCommit: commit,
  schemaChanged: !isDeepStrictEqual(previous, next),
  addedOperations: added,
  removedOperations: removed,
  changedOperations: changed,
  changedSchemas: schemaChanges,
  removedSchemas,
  reviewRequired:
    removed.length +
      changed.length +
      schemaChanges.length +
      removedSchemas.length >
    0,
};
await mkdir(".reports", { recursive: true });
await writeFile(
  ".reports/upstream.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes("--update") && report.schemaChanged) {
  await writeFile(
    new URL("../schema/openapi.json", import.meta.url),
    schemaText.trimEnd() + "\n",
  );
  await writeFile(
    new URL("../schema/source.json", import.meta.url),
    JSON.stringify(
      { ...source, commit, url, retrieved: new Date().toISOString().slice(0, 10) },
      null,
      2,
    ) + "\n",
  );
}

import ts from "typescript";
import { readFile, writeFile } from "node:fs/promises";
const files = [
  "index",
  "types",
  "discovery",
  "cache",
  "gateway-types",
  "client",
  "rest",
  "gateway",
  "messages",
  "resources",
  "permissions",
  "uploads",
  "shards",
  "voice",
  "voice-livekit",
  "voice-player",
  "voice-session",
  "rate-limits",
  "collectors",
  "supervisor",
  "node",
  "node-http",
];
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile),
  parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ".");
const program = ts.createProgram(
    files.map((file) => `src/${file}.ts`),
    parsed.options,
  ),
  checker = program.getTypeChecker(),
  entries = [];
for (const file of files) {
  const source = program.getSourceFile(`src/${file}.ts`);
  const symbol = checker.getSymbolAtLocation(source);
  for (const exported of checker.getExportsOfModule(symbol)) {
    const declarations = exported.getDeclarations() ?? [];
    const declaration = declarations[0];
    if (!declaration || declaration.getSourceFile() !== source) continue;
    const type = checker.getTypeOfSymbolAtLocation(exported, declaration);
    const item = { module: file, name: exported.name };
    if (ts.isClassDeclaration(declaration)) {
      item.kind = "class";
      item.members = declaration.members
        .filter(
          (member) =>
            !(
              ts.getCombinedModifierFlags(member) &
              (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)
            ) && !member.name?.getText(source).startsWith("#"),
        )
        .map((member) =>
          source.text
            .slice(
              member.getStart(source),
              member.body ? member.body.getStart(source) : member.getEnd(),
            )
            .trim(),
        );
    } else if (
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration)
    ) {
      item.kind = "type";
      item.declaration = declaration.getText(source);
    } else {
      item.kind = "value";
      item.type = checker.typeToString(
        type,
        undefined,
        ts.TypeFormatFlags.NoTruncation,
      );
    }
    entries.push(item);
  }
}
entries.sort((a, b) =>
  `${a.module}:${a.name}`.localeCompare(`${b.module}:${b.name}`),
);
const output = JSON.stringify(entries, null, 2) + "\n",
  path = "schema/public-api.json";
if (process.argv.includes("--update")) {
  await writeFile(path, output);
  console.log(`Public API snapshot updated (${entries.length} exports)`);
} else {
  if ((await readFile(path, "utf8")) !== output)
    throw new Error(
      "Public API changed. Review compatibility, then run bun run api:update.",
    );
  console.log(`Public API snapshot checked (${entries.length} exports)`);
}

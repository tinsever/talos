import { readFile, access } from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
if (!version.test(pkg.version)) throw new Error("Invalid package version");
const tagIndex = process.argv.indexOf("--tag");
if (tagIndex !== -1 && process.argv[tagIndex + 1] !== `v${pkg.version}`)
  throw new Error(`Release tag must match v${pkg.version}`);
if (pkg.private) throw new Error("Package is private");
if (pkg.publishConfig?.access !== "public")
  throw new Error("Package must publish with public access");
if (pkg.repository?.url !== "git+https://github.com/tinsever/talos.git")
  throw new Error("Unexpected repository URL");
if (pkg.engines?.node !== ">=20")
  throw new Error("Unexpected Node support range");
await Promise.all(
  [
    ...Object.values(pkg.exports).flatMap((entry) => [
      entry.types,
      entry.import,
    ]),
    "LICENSE",
    "NOTICE.md",
  ].map((file) => access(file)),
);
console.log(`${pkg.name}@${pkg.version}: release checks passed`);

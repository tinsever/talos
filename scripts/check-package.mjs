import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const useNpm = process.argv.includes("--npm");
const tarball = resolve(
    process.argv.slice(2).find((arg) => arg !== "--npm") ??
      `${pkg.name}-${pkg.version}.tgz`,
  ),
  directory = await mkdtemp(join(tmpdir(), "talos-consumer-"));
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const process = spawn(command, args, {
      cwd: directory,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    process.stderr.on("data", (chunk) => (errors += chunk));
    process.on("error", reject);
    process.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} failed (${code}): ${errors}`)),
    );
  });
}
try {
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  if (useNpm) {
    await run("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ]);
  } else {
    await run("bun", ["add", "--ignore-scripts", tarball]);
  }
  const installed = JSON.parse(
    await readFile(
      join(directory, "node_modules", pkg.name, "package.json"),
      "utf8",
    ),
  );
  if (Object.keys(installed.dependencies ?? {}).length)
    throw new Error("Unexpected runtime dependencies");
  const entries = Object.keys(installed.exports).map((key) =>
    key === "." ? pkg.name : pkg.name + key.slice(1),
  );
  await writeFile(
    join(directory, "imports.mjs"),
    `for(const name of ${JSON.stringify(entries)})await import(name);`,
  );
  await run("node", ["imports.mjs"]);
  await run("bun", ["imports.mjs"]);
  await writeFile(
    join(directory, "consumer.ts"),
    `import { Client, RESTClient, PermissionFlags, Permissions } from 'talos-fluxer';
import { ShardManager } from 'talos-fluxer/shards';
import type { GatewayClient } from 'talos-fluxer/gateway';
import type { DispatchEvents } from 'talos-fluxer/gateway-types';
import { VoiceConnection, VoiceSession, VoicePlayer, liveKitAdapter, type LiveKitRoom } from 'talos-fluxer/voice';

const client = new Client({ token: 'synthetic' });
client.onDispatch('GUILD_ROLE_DELETE', data => { const id: string = data.role_id; void id; });
const rest = new RESTClient({ api: 'https://example', token: 'synthetic' });
void rest.request('POST', '/channels/{channel_id}/messages', { params: { channel_id: '1' }, body: { content: 'typed' } });
// @ts-expect-error Invalid send body rejected through installed declarations.
void rest.request('POST', '/channels/{channel_id}/messages', { params: { channel_id: '1' }, body: { content: 123 } });
void new Permissions(PermissionFlags.VIEW_CHANNEL);
void new ShardManager({ token: 'synthetic' });
const removed: DispatchEvents['GUILD_ROLE_DELETE'] = { guild_id: '1', role_id: '2' };
void removed;

declare const gateway: GatewayClient;
declare const room: LiveKitRoom;
const adapter = liveKitAdapter(() => room);
const options = { guildId: '1', channelId: '2' };
void VoiceConnection.join(gateway, adapter, options).then(connection => {
  const player = new VoicePlayer(connection);
  void player.play(new ArrayBuffer(0));
  // @ts-expect-error Publishing requires a MediaStreamTrack.
  void connection.publishAudio(123);
});
void VoiceSession.join(gateway, adapter, { ...options, recovery: { maxAttempts: 3 } });
`,
  );
  await run("node", [
    resolve("node_modules/typescript/bin/tsc"),
    "--strict",
    "--noEmit",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2022",
    "--skipLibCheck",
    "consumer.ts",
  ]);
  console.log(
    JSON.stringify({
      package: installed.name,
      version: installed.version,
      exportsImported: entries.length,
      installer: useNpm ? "npm" : "bun",
      runtimes: ["node", "bun"],
      runtimeDependencies: 0,
      externalTypecheck: true,
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

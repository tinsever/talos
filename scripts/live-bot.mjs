import { Client, PermissionFlags } from "../dist/index.js";
import WebSocket from "ws";
import { mkdir, writeFile } from "node:fs/promises";
const required = [
  "FLUXER_BOT_TOKEN",
  "FLUXER_TEST_GUILD_ID",
  "FLUXER_TEST_CHANNEL_ID",
];
for (const key of required)
  if (!process.env[key]) throw new Error(`Missing ${key}; populate .env`);
const channelId = process.env.FLUXER_TEST_CHANNEL_ID,
  guildId = process.env.FLUXER_TEST_GUILD_ID;
let activeSocket;
const waits = new AbortController();
let webhook;
const client = new Client({
  token: process.env.FLUXER_BOT_TOKEN,
  origin: process.env.FLUXER_ORIGIN ?? "https://fluxer.app",
  gateway: { webSocket: (url) => (activeSocket = new WebSocket(url)) },
  cache: { messages: 20 },
});
const created = new Set(),
  report = { checks: [], gatewayErrors: [] };
const shapes = {};
function shape(value, depth = 0) {
  if (value === null) return "null";
  if (depth > 4) return Array.isArray(value) ? "array" : typeof value;
  if (Array.isArray(value))
    return value.length ? [shape(value[0], depth + 1)] : [];
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [
        key,
        shape(value, depth + 1),
      ]),
    );
  return typeof value;
}
client.on("dispatch", (frame) => {
  if (!shapes[frame.t]) shapes[frame.t] = shape(frame.d);
});
client.on("error", (error) =>
  report.gatewayErrors.push({ name: error?.name, code: error?.code }),
);
const check = (name) => report.checks.push(name);
try {
  await client.connect({ timeoutMs: 30000 });
  check("gateway-ready");
  const [user, channel, guild] = await Promise.all([
    client.rest.request("GET", "/users/@me"),
    client.rest.request("GET", "/channels/{channel_id}", {
      params: { channel_id: channelId },
    }),
    client.rest.request("GET", "/guilds/{guild_id}", {
      params: { guild_id: guildId },
    }),
  ]);
  if (!user.bot || channel.guild_id !== guild.id)
    throw new Error("Test environment mismatch");
  check("authenticated-reads");
  const resourceGuild = await client.guilds.fetch(guildId),
    resourceChannel = await client.channels.fetch(channelId);
  const [roles, member] = await Promise.all([
    resourceGuild.roles.list(),
    resourceGuild.members.fetch(user.id),
  ]);
  const permissions = resourceChannel.permissionsFor(
    member,
    roles,
    resourceGuild.ownerId,
  );
  if (!permissions.has(PermissionFlags.VIEW_CHANNEL))
    throw new Error("Permission calculation contradicts readable test channel");
  check("guild-channel-member-role-resources");
  check("permissions");
  const pins = await resourceChannel.pins({ limit: 1 });
  if (typeof pins.hasMore !== "boolean" || !Array.isArray(pins.items))
    throw new Error("Invalid pinned message page");
  check("pinned-message-page");
  await Promise.all([resourceGuild.emojis(), resourceGuild.stickers()]);
  check("guild-emoji-sticker-reads");
  if (permissions.has(PermissionFlags.VIEW_AUDIT_LOG)) {
    await resourceGuild.auditLogs({ limit: 1 });
    check("audit-log-read");
  }
  const nonce = `talos-${Date.now()}`;
  const event = client.waitFor(
    "messageCreate",
    (m) => m.channelId === channelId && m.content === nonce,
    { timeoutMs: 20000 },
  );
  event.catch(() => {});
  const message = await client.messages.send(channelId, nonce);
  created.add(message.id);
  await event;
  check("send-dispatch");
  await message.edit(`${nonce} edited`);
  const fetched = await client.messages.fetch(channelId, message.id);
  if (!fetched.content.endsWith("edited"))
    throw new Error("Edit did not persist");
  check("edit-fetch");
  const reply = await message.reply("Talos reply validation");
  created.add(reply.id);
  check("reply");
  const upload = await client.messages.send(
    channelId,
    "Talos attachment validation",
    {
      files: [
        {
          data: new Blob(["Talos SDK test\n"], { type: "text/plain" }),
          name: "talos-test.txt",
        },
      ],
    },
  );
  created.add(upload.id);
  if (!upload.data.attachments?.length) throw new Error("Attachment missing");
  check("multipart-upload");
  await client.rest.request(
    "PUT",
    "/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me",
    { params: { channel_id: channelId, message_id: message.id, emoji: "✅" } },
  );
  check("reaction-add");
  await client.rest.request(
    "DELETE",
    "/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me",
    { params: { channel_id: channelId, message_id: message.id, emoji: "✅" } },
  );
  check("reaction-remove");
  if (permissions.has(PermissionFlags.PIN_MESSAGES)) {
    await message.pin();
    await message.unpin();
    check("pin-unpin");
  }
  const attachments = await client.uploads.upload(channelId, [
    {
      data: new Blob(["presigned Talos test"], { type: "text/plain" }),
      name: "talos-presigned.txt",
    },
  ]);
  const presigned = await client.messages.send(channelId, {
    content: "Talos presigned attachment validation",
    attachments,
  });
  created.add(presigned.id);
  if (!presigned.data.attachments?.length)
    throw new Error("Presigned attachment missing");
  check("presigned-upload");
  if (permissions.has(PermissionFlags.MANAGE_MESSAGES)) {
    await resourceChannel.bulkDelete([reply.id, upload.id], {
      reason: "SDK test cleanup",
    });
    created.delete(reply.id);
    created.delete(upload.id);
    check("bulk-delete-own-messages");
  }
  if (permissions.has(PermissionFlags.MANAGE_WEBHOOKS)) {
    webhook = await resourceChannel.createWebhook({
      name: "Talos SDK validation",
    });
    const sent = await webhook.execute({ content: "Talos webhook validation" });
    try {
      await webhook.editMessage(sent.id, { content: "Talos webhook edited" });
      const got = await webhook.fetchMessage(sent.id);
      if (got.content !== "Talos webhook edited")
        throw new Error("Webhook edit mismatch");
      check("webhook-create-execute-edit-fetch");
    } finally {
      await webhook.deleteMessage(sent.id);
    }
    await webhook.delete();
    webhook = undefined;
    check("webhook-cleanup");
  }
  const resumed = client.waitFor("resumed", () => true, {
    timeoutMs: 30000,
    signal: waits.signal,
  });
  resumed.catch(() => {});
  const replayContent = `${nonce} resume probe`;
  const replay = client.waitFor(
    "messageCreate",
    (m) => m.content === replayContent,
    { timeoutMs: 30000, signal: waits.signal },
  );
  replay.catch(() => {});
  activeSocket.terminate();
  const probe = await client.messages.send(channelId, replayContent);
  created.add(probe.id);
  await resumed;
  await replay;
  check("transport-drop-resume-and-replay");
  client.disconnect();
  await client.connect({ timeoutMs: 30000 });
  check("disconnect-reconnect");
} catch (error) {
  report.failure = {
    name: error?.name,
    status: error?.status,
    code: error?.code,
  };
  process.exitCode = 1;
} finally {
  waits.abort();
  if (webhook)
    try {
      await webhook.delete();
    } catch (error) {
      report.webhookCleanupFailure = {
        status: error?.status,
        code: error?.code,
      };
      process.exitCode = 1;
    }
  for (const id of created)
    try {
      await client.messages.delete(channelId, id);
    } catch (error) {
      report.cleanupFailure = { status: error?.status, code: error?.code };
      process.exitCode = 1;
    }
  client.disconnect();
  await mkdir(".reports", { recursive: true });
  await writeFile(
    ".reports/live-protocol.json",
    JSON.stringify(
      { origin: process.env.FLUXER_ORIGIN ?? "https://fluxer.app", shapes },
      null,
      2,
    ) + "\n",
  );
  report.cleaned = created.size;
  console.log(JSON.stringify(report, null, 2));
}

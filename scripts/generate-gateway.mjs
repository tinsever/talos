import { readFile, writeFile } from "node:fs/promises";
const text = await readFile(
  new URL("../schema/gateway-events.md", import.meta.url),
  "utf8",
);
const schema = (name) => `components['schemas']['${name}']`;
const references = {
  user: schema("UserPrivateResponse"),
  "partial user": schema("UserPartialResponse"),
  channel: schema("ChannelResponse"),
  relationship: schema("RelationshipResponse"),
  "presence object": "Presence",
  "guild ready object": "GuildReady",
  "session presence object": "SessionPresence",
  "read state": schema("ReadStateResponse"),
  "user settings": schema("UserSettingsResponse"),
  "user guild settings": schema("UserGuildSettingsResponse"),
  meme: schema("FavoriteMemeResponse"),
  "WebAuthn credential object": schema("WebAuthnCredentialResponse"),
  "RTC region object": "RTCRegion",
  "guild role": schema("GuildRoleResponse"),
  "guild emoji": schema("GuildEmojiResponse"),
  "guild sticker": schema("GuildStickerResponse"),
  "guild member": schema("GuildMemberResponse"),
  "member list group object": "MemberListGroup",
  "member list operation object": "MemberListOperation",
  "voice state object": "VoiceState",
  "reaction emoji object": "ReactionEmoji",
  "reaction addition object": "ReactionAddition",
  "guild count entry object": "GuildCount",
  "channel count entry object": "ChannelCount",
};
function type(value) {
  if (value.startsWith("?")) return `${type(value.slice(1))} | null`;
  if (value.startsWith("array[") && value.endsWith("]"))
    return `(${type(value.slice(6, -1))})[]`;
  if (value.startsWith("map[")) return "Record<string, string>";
  const ref = value.match(/^\[([^\]]+)\]\([^)]*\)(?: object)?$/);
  if (ref) {
    if (!references[ref[1]]) throw new Error(`Unmapped reference ${value}`);
    return references[ref[1]];
  }
  const plain = {
    string: "string",
    snowflake: "string",
    "ISO8601 timestamp": "string",
    integer: "number",
    number: "number",
    boolean: "boolean",
    object: "Record<string, unknown>",
    "connection object": schema("ConnectionResponse"),
  };
  if (!plain[value]) throw new Error(`Unmapped type ${value}`);
  return plain[value];
}
const aliases = {
  SESSIONS_REPLACE: "SessionPresence[]",
  USER_UPDATE: schema("UserPrivateResponse"),
  USER_SETTINGS_UPDATE: schema("UserSettingsResponse"),
  USER_GUILD_SETTINGS_UPDATE: schema("UserGuildSettingsResponse"),
  USER_PINNED_DMS_UPDATE: "string[]",
  WEBAUTHN_CREDENTIALS_UPDATE: `${schema("WebAuthnCredentialResponse")}[]`,
  RELATIONSHIP_UPDATE: "DispatchEvents['RELATIONSHIP_ADD']",
  SAVED_MESSAGE_CREATE: schema("MessageResponseSchema"),
  FAVORITE_MEME_CREATE: schema("FavoriteMemeResponse"),
  FAVORITE_MEME_UPDATE: schema("FavoriteMemeResponse"),
  GUILD_CREATE: "GuildReady",
  GUILD_SYNC: "GuildReady",
  GUILD_UPDATE: `${schema("GuildResponse")} & { guild_id: string }`,
  CHANNEL_CREATE: schema("ChannelResponse"),
  CHANNEL_UPDATE: schema("ChannelResponse"),
  CHANNEL_DELETE: schema("ChannelResponse"),
  INVITE_CREATE: schema("InviteMetadataResponseSchema"),
  GUILD_MEMBER_ADD: `${schema("GuildMemberResponse")} & { guild_id:string }`,
  GUILD_MEMBER_UPDATE: `${schema("GuildMemberResponse")} & { guild_id:string }`,
  GUILD_AUDIT_LOG_ENTRY_CREATE: `${schema("GuildAuditLogEntryResponse")} & { guild_id:string }`,
  PRESENCE_UPDATE: "Presence",
  MESSAGE_UPDATE: `${schema("MessageResponseSchema")} & { guild_id?:string; member?:Omit<${schema("GuildMemberResponse")},'user'> }`,
  VOICE_STATE_UPDATE: "VoiceState",
  CALL_UPDATE: "Omit<DispatchEvents['CALL_CREATE'],'recipients'|'created_at'>",
};
const rows = [];
for (const part of text.split(/^### /m).slice(1)) {
  const name = part
    .split("\n")[0]
    .replace(/<[^>]*>/g, "")
    .trim();
  if (!/^[A-Z_]+$/.test(name)) continue;
  let value = aliases[name];
  if (!value) {
    let fields = [];
    for (const line of part.split("\n####")[0].split("\n")) {
      if (!line.startsWith("|")) continue;
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      const field = cells[0]?.replace(/<sup>.*?<\/sup>/g, "");
      if (!field || field === "Field" || field === "---") continue;
      let fieldType = type(cells[1]);
      if (
        field === "user" &&
        ["GUILD_MEMBER_REMOVE", "GUILD_BAN_ADD", "GUILD_BAN_REMOVE"].includes(
          name,
        )
      )
        fieldType = "{id:string}";
      if (
        field === "member?" &&
        ["MESSAGE_CREATE", "MESSAGE_DELETE"].includes(name)
      )
        fieldType = `Omit<${schema("GuildMemberResponse")},'user'>`;
      if (name === "READY" && field === "relationships")
        fieldType = `Omit<${schema("RelationshipResponse")},'user'>[]`;
      if (name === "RATE_LIMITED" && field === "opcode") fieldType = "8";
      if (name === "RATE_LIMITED" && field === "meta")
        fieldType = "{guild_id:string;nonce?:string}";
      fields.push(`${field}: ${fieldType}`);
    }
    value = `{ ${fields.join("; ")} }`;
    if (name === "MESSAGE_CREATE")
      value = `${schema("MessageResponseSchema")} & ${value}`;
  }
  rows.push(`  ${name}: ${value};`);
}
const output = `// Generated from schema/gateway-events.md; edit the generator, then regenerate.\nimport type { components } from '../types.js';\nimport type { GuildReady, Presence, SessionPresence, RTCRegion, VoiceState, MemberListGroup, MemberListOperation, ReactionEmoji, ReactionAddition, GuildCount, ChannelCount } from '../gateway-types.js';\nexport interface DispatchEvents {\n${rows.join("\n")}\n}\nexport const dispatchEventNames = ${JSON.stringify(rows.map((row) => row.trim().split(":")[0]))} as const;\n`;
const path = new URL("../src/generated/gateway.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== output)
    throw new Error("Generated gateway contracts drifted");
} else await writeFile(path, output);
console.log(
  `${rows.length} gateway dispatch contracts ${process.argv.includes("--check") ? "checked" : "generated"}`,
);

import { Client, PermissionFlags } from "../src/index.js";
const client = new Client({ token: process.env.FLUXER_BOT_TOKEN! });
client.on("error", (error) =>
  console.error(error instanceof Error ? error.name : "Gateway error"),
);
client.on("messageCreate", async (message) => {
  if (
    message.author.bot ||
    message.content !== "!permissions" ||
    !message.guildId
  )
    return;
  const [channel, guild] = await Promise.all([
    client.channels.fetch(message.channelId),
    client.guilds.fetch(message.guildId),
  ]);
  const [member, roles] = await Promise.all([
    guild.members.fetch(message.author.id),
    guild.roles.list(),
  ]);
  const permissions = channel.permissionsFor(member, roles, guild.ownerId);
  await message.reply(
    `You can send messages: ${permissions.has(PermissionFlags.SEND_MESSAGES)}`,
  );
});
await client.connect();

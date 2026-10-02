import { Client } from "../src/index.js";

const token = process.env.FLUXER_BOT_TOKEN;
if (!token) throw new Error("Set FLUXER_BOT_TOKEN");
const client = new Client({ token });
client.on("ready", ({ user }) => console.log(`Connected as ${user.username}`));
client.on("error", (error) => console.error(error));
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.content === "!ping") await message.reply("Pong!");
});
process.once("SIGINT", () => client.disconnect());
process.once("SIGTERM", () => client.disconnect());
await client.connect();

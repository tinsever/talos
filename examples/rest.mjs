import { discover, RESTClient } from "../dist/index.js";

const instance = await discover(
  process.env.FLUXER_ORIGIN ?? "https://fluxer.app",
);
const rest = new RESTClient({
  api: instance.endpoints.api_public,
  ...(process.env.FLUXER_BOT_TOKEN
    ? { token: process.env.FLUXER_BOT_TOKEN }
    : {}),
});
console.log(await rest.request("GET", "/auth/sso/status"));

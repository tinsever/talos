import { discover } from "../dist/index.js";
import { RESTClient } from "../dist/rest.js";

const origin = process.env.FLUXER_ORIGIN ?? "https://fluxer.app";
const instance = await discover(origin);
const rest = new RESTClient({
  api: instance.endpoints.api_public,
  origin,
  maxRetries: 1,
  timeoutMs: 15_000,
});
const result = await rest.request("GET", "/auth/sso/status");
console.log(
  JSON.stringify(
    {
      origin,
      publicAPI: instance.endpoints.api_public,
      gateway: instance.endpoints.gateway,
      publicRequest: result,
    },
    null,
    2,
  ),
);

// Compile-time contract tests; this function is never executed.
import type { RESTClient } from "../src/rest.js";
import type { MessageData } from "../src/types.js";
export function checkTypes(rest: RESTClient): void {
  const result: Promise<MessageData> = rest.request(
    "POST",
    "/channels/{channel_id}/messages",
    { params: { channel_id: "10" }, body: { content: "hi" } },
  );
  void result;
  void rest.request("GET", "/auth/sso/status");
  // @ts-expect-error Invalid HTTP method for this endpoint.
  void rest.request("GET", "/channels/{channel_id}/messages/bulk-delete", {
    params: { channel_id: "10" },
    body: { message_ids: [] },
  });
  // @ts-expect-error Path parameters are required.
  void rest.request("GET", "/channels/{channel_id}/messages");
  void rest.request("GET", "/channels/{channel_id}/messages", {
    // @ts-expect-error Wrong path parameter name.
    params: { guild_id: "10" },
  });
  void rest.request("GET", "/channels/{channel_id}/messages", {
    params: { channel_id: "10" },
    // @ts-expect-error Unknown query option.
    query: { offset: "1" },
  });
  // @ts-expect-error Send body is required even though its fields have defaults.
  void rest.request("POST", "/channels/{channel_id}/messages", {
    params: { channel_id: "10" },
  });
  // @ts-expect-error GET cannot have a body.
  void rest.request("GET", "/auth/sso/status", { body: {} });
  void rest.request("POST", "/channels/{channel_id}/messages", {
    params: { channel_id: "10" },
    // @ts-expect-error Content has a schema-defined type.
    body: { content: 123 },
  });
}

import type { Client } from "../src/client.js";
import type { GatewayClient } from "../src/gateway.js";
export function checkGatewayTypes(
  client: Client,
  gateway: GatewayClient,
): void {
  client.onDispatch("GUILD_MEMBER_ADD", (data) => {
    const guild: string = data.guild_id;
    const name: string = data.user.username;
    void guild;
    void name;
  });
  client.onDispatch("MESSAGE_REACTION_ADD", (data) => {
    const id: string | undefined = data.emoji.id;
    void id;
  });
  gateway.on("ready", (data) => {
    const guilds: typeof data.guilds = data.guilds;
    void guilds;
  });
  // @ts-expect-error Unknown wire event names are only available through the raw dispatch event.
  client.onDispatch("NOT_A_REAL_EVENT", () => {});
  client.onDispatch("GUILD_ROLE_DELETE", (data) => {
    // @ts-expect-error This event has role_id, not a full role object.
    void data.role.name;
  });
}

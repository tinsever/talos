import { expect, it, vi } from "vitest";
import { Resources } from "../src/resources.js";
import { RESTClient } from "../src/rest.js";
import type { KnownDispatch } from "../src/gateway-types.js";
import { user, message, json } from "./helpers.js";

function setup() {
  const resources = new Resources(
    () => new RESTClient({ api: "https://example.test", token: "synthetic" }),
    { users: 10, guilds: 10, channels: 10, members: 10, roles: 10 },
  );
  const dispatch = (t: KnownDispatch["t"], d: unknown) =>
    resources.apply({ op: 0, t, d, s: 1 } as KnownDispatch);
  return { resources, dispatch };
}

it("replaces cached state on READY while retaining available guild data", () => {
  const { resources, dispatch } = setup();
  resources.channels.wrap({ id: "old", type: 1 });
  dispatch("READY", {
    user,
    users: [{ ...user, id: "2" }],
    private_channels: [{ id: "30", type: 1 }],
    guilds: [
      {
        id: "10",
        properties: { id: "10", name: "Guild", owner_id: "1" },
        channels: [{ id: "31", type: 0, guild_id: "10" }],
        roles: [{ id: "10", name: "everyone", position: 0, permissions: "0" }],
      },
      { id: "20", unavailable: true },
    ],
  });
  expect(resources.channels.cache.get("old")).toBeUndefined();
  expect(resources.users.cache.size).toBe(2);
  expect(resources.guilds.cache.get("10")!.name).toBe("Guild");
  expect(resources.guilds.cache.get("20")).toBeUndefined();
  expect(resources.channels.cache.get("31")!.guildId).toBe("10");
  expect(resources.roleCache.get("10:10")!.name).toBe("everyone");
});

it("applies bulk channel, role, and member updates without mutating old snapshots", () => {
  const { resources, dispatch } = setup();
  const first = resources.channels.wrap({
    id: "30",
    type: 0,
    guild_id: "10",
    name: "old",
  });
  dispatch("CHANNEL_UPDATE_BULK", {
    channels: [{ id: "30", type: 0, guild_id: "10", name: "new" }],
  });
  expect(first.name).toBe("old");
  expect(resources.channels.cache.get("30")!.name).toBe("new");
  dispatch("GUILD_ROLE_CREATE", {
    guild_id: "10",
    role: { id: "11", name: "old", position: 1, permissions: "0" },
  });
  const original = resources.roleCache.get("10:11")!;
  dispatch("GUILD_ROLE_UPDATE_BULK", {
    guild_id: "10",
    roles: [{ id: "11", name: "new", position: 2, permissions: "1024" }],
  });
  expect(original.name).toBe("old");
  expect(resources.roleCache.get("10:11")!.name).toBe("new");
  dispatch("GUILD_MEMBERS_CHUNK", {
    guild_id: "10",
    members: [{ user, roles: ["11"], nick: "Member" }],
  });
  expect(resources.memberCache.get("10:1")!.displayName).toBe("Member");
  expect(resources.users.cache.get("1")!.username).toBe("bot");
  dispatch("USER_UPDATE", { ...user, username: "renamed" });
  expect(resources.users.cache.get("1")!.username).toBe("renamed");
});

it("removes deleted entities and only cascades within the deleted guild", () => {
  const { resources, dispatch } = setup();
  for (const id of ["10", "20"]) {
    dispatch("GUILD_SYNC", {
      id,
      properties: { id, name: id, owner_id: "1" },
      channels: [{ id: `${id}0`, type: 0, guild_id: id }],
      roles: [{ id: `${id}1`, name: id, position: 1, permissions: "0" }],
    });
    dispatch("GUILD_MEMBER_ADD", { guild_id: id, user, roles: [] });
  }
  dispatch("GUILD_ROLE_DELETE", { guild_id: "10", role_id: "101" });
  expect(resources.roleCache.get("10:101")).toBeUndefined();
  dispatch("GUILD_MEMBER_REMOVE", { guild_id: "10", user: { id: "1" } });
  expect(resources.memberCache.get("10:1")).toBeUndefined();
  dispatch("CHANNEL_DELETE", { id: "100", type: 0, guild_id: "10" });
  expect(resources.channels.cache.get("100")).toBeUndefined();
  dispatch("GUILD_DELETE", { id: "10" });
  expect(resources.guilds.cache.get("10")).toBeUndefined();
  expect(resources.guilds.cache.get("20")).toBeDefined();
  expect(resources.channels.cache.get("200")).toBeDefined();
  expect(resources.memberCache.get("20:1")).toBeDefined();
  expect(resources.roleCache.get("20:201")).toBeDefined();
});

it("uses channel message helpers with the same signal, deadlines, and pin metadata", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(json([message()]))
    .mockResolvedValueOnce(json([message()]))
    .mockResolvedValueOnce(
      json({
        items: [{ message: message(), pinned_at: "2026-01-01T00:00:00Z" }],
        has_more: false,
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const rest = new RESTClient({
    api: "https://example.test",
    token: "synthetic",
    fetch,
  });
  const resources = new Resources(() => rest);
  const channel = resources.channels.wrap({ id: "10", type: 0 });
  const signal = new AbortController().signal;
  expect((await channel.messages({ limit: "1" }, { signal }))[0]!.id).toBe(
    "20",
  );
  const iterator = channel.history({ limit: 1, signal });
  expect((await iterator.next()).value!.content).toBe("hello");
  expect((await iterator.next()).done).toBe(true);
  const pins = await channel.pins({ limit: 1 }, { signal, timeoutMs: 1000 });
  expect(pins.hasMore).toBe(false);
  expect(pins.items[0]!.pinnedAt).toBe("2026-01-01T00:00:00Z");
  await channel.bulkDelete(["20"], { signal, reason: "cleanup" });
  expect(JSON.parse(fetch.mock.calls[3]![1]!.body as string)).toEqual({
    message_ids: ["20"],
  });
});

import { describe, expect, it, vi } from "vitest";
import { RESTClient } from "../src/rest.js";
import { Resources, Members, Webhook } from "../src/resources.js";
import { Messages, multipart } from "../src/messages.js";
import { PermissionFlags } from "../src/permissions.js";
import type { components } from "../src/types.js";
import { json, message, user } from "./helpers.js";

type S = components["schemas"];
const guild = { id: "10", name: "Guild", owner_id: "99" } as S["GuildResponse"];
const channel: S["ChannelResponse"] = {
  id: "30",
  type: 0,
  guild_id: "10",
  name: "general",
};
const member = {
  user,
  nick: null,
  roles: ["11"],
  joined_at: "2026-01-01T00:00:00Z",
} as S["GuildMemberResponse"];
const role = {
  id: "11",
  name: "Members",
  position: 1,
  permissions: "1024",
  color: 0,
  hoist: false,
  mentionable: false,
} as S["GuildRoleResponse"];
const hook = {
  id: "40",
  type: 1,
  channel_id: "30",
  guild_id: "10",
  name: "hook",
  token: "webhook-secret",
} as S["WebhookResponse"];

function setup(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const rest = new RESTClient({
    api: "https://example.test/api",
    token: "bot-secret",
    fetch,
  });
  const resources = new Resources(() => rest, {
    users: 10,
    channels: 10,
    guilds: 10,
    members: 10,
    roles: 10,
  });
  return { fetch, rest, resources, messages: new Messages(rest) };
}
function body(fetch: ReturnType<typeof setup>["fetch"], index: number) {
  return JSON.parse(fetch.mock.calls[index]![1]!.body as string);
}
const empty = () => new Response(null, { status: 204 });

describe("resource requests", () => {
  it("opens a DM and sends through the returned channel", async () => {
    const { resources, fetch } = setup(
      json(channel),
      json(message()),
      json(user),
    );
    const wrapped = resources.users.wrap(user);
    const sent = await wrapped.send("hello", { timeoutMs: 1000 });
    expect(sent.content).toBe("hello");
    expect(body(fetch, 0)).toEqual({ recipient_id: user.id });
    expect(String(fetch.mock.calls[1]![0])).toContain("/channels/30/messages");
    expect(await wrapped.fetch()).toBe(resources.users.cache.get(user.id));
    expect(wrapped.username).toBe("bot");
    expect(wrapped.toJSON()).toEqual(user);
    expect(Object.isFrozen(wrapped.toJSON())).toBe(true);
  });

  it("refreshes guild and channel snapshots without mutating older resources", async () => {
    const { resources } = setup(
      json([guild]),
      json({ ...guild, name: "Updated" }),
      json(channel),
      json({ ...channel, name: "renamed" }),
      json({ ...guild, name: "Edited" }),
    );
    const [original] = await resources.guilds.list();
    expect(original!.name).toBe("Guild");
    expect(original!.ownerId).toBe("99");
    const refreshed = await original!.fetch();
    expect(refreshed.name).toBe("Updated");
    expect(original!.name).toBe("Guild");
    const room = await resources.channels.fetch("30");
    expect(room.type).toBe(0);
    expect(room.name).toBe("general");
    expect(room.guild).toBe(refreshed);
    expect((await room.edit({ name: "renamed" })).name).toBe("renamed");
    expect((await refreshed.edit({ name: "Edited" })).name).toBe("Edited");
    expect(
      resources.channels.wrap({ id: "31", type: 1 }).guild,
    ).toBeUndefined();
    expect(resources.channels.wrap({ id: "32", type: 1 }).name).toBeNull();
  });

  it("hydrates channel lists and preserves audit reasons on guild changes", async () => {
    const { resources, fetch } = setup(
      json([channel]),
      json({ ...channel, id: "31" }),
      empty(),
      empty(),
      json([]),
      json({ audit_log_entries: [], users: [], webhooks: [] }),
      json([]),
      json([]),
    );
    const value = resources.guilds.wrap(guild);
    expect((await value.channels())[0]!.guild).toBe(value);
    expect(
      (
        await value.createChannel(
          { name: "new", type: 0 },
          { reason: "new room" },
        )
      ).id,
    ).toBe("31");
    await value.ban("2", {}, { reason: "spam" });
    await value.unban("2", { reason: "appeal" });
    expect(await value.bans()).toEqual([]);
    await value.auditLogs({ limit: 10, user_id: "2" });
    expect(await value.emojis()).toEqual([]);
    expect(await value.stickers()).toEqual([]);
    expect(
      new Headers(fetch.mock.calls[2]![1]!.headers).get("X-Audit-Log-Reason"),
    ).toBe("spam");
    expect(String(fetch.mock.calls[5]![0])).toContain("limit=10&user_id=2");
    expect(resources.channels.cache.get("31")).toBeDefined();
  });

  it("updates member and role caches after successful edits and removals", async () => {
    const { resources, fetch } = setup(
      json(member),
      json({ ...member, nick: "New" }),
      empty(),
      empty(),
      json({ ...member, communication_disabled_until: null }),
      json({
        ...member,
        communication_disabled_until: "2027-01-01T00:00:00.000Z",
      }),
      json([role]),
      json(role),
      json({ ...role, name: "Renamed" }),
      empty(),
      empty(),
      empty(),
    );
    const group = resources.guilds.wrap(guild);
    const person = await group.members.fetch("1");
    expect(person.guildId).toBe("10");
    expect(person.displayName).toBe("bot");
    expect(person.user.username).toBe("bot");
    const updated = await person.edit({ nick: "New" });
    expect(updated.displayName).toBe("New");
    expect(person.displayName).toBe("bot");
    await updated.addRole("12");
    await updated.removeRole("12");
    await updated.timeout(null);
    await updated.timeout(new Date("2027-01-01T00:00:00Z"));
    expect(body(fetch, 4)).toEqual({ communication_disabled_until: null });
    expect(body(fetch, 5)).toEqual({
      communication_disabled_until: "2027-01-01T00:00:00.000Z",
    });
    const [listed] = await group.roles.list();
    expect(listed!.permissions.has(PermissionFlags.VIEW_CHANNEL)).toBe(true);
    const created = await group.roles.create({
      name: "Members",
      permissions: "1024",
    });
    const renamed = await created.edit(
      { name: "Renamed" },
      { reason: "rename" },
    );
    expect(renamed.name).toBe("Renamed");
    expect(resources.roleCache.get("10:11")).toBe(renamed);
    expect(
      new Headers(fetch.mock.calls[8]![1]!.headers).get("X-Fluxer-Features"),
    ).toBe("view_channel_members_permission");
    await group.roles.setPositions([{ id: "11", position: 2 }]);
    await renamed.delete();
    expect(resources.roleCache.get("10:11")).toBeUndefined();
    await person.kick();
    expect(resources.memberCache.get("10:1")).toBeUndefined();
  });

  it("keeps cached resources when the server rejects deletion", async () => {
    const { resources } = setup(
      json({ message: "Forbidden" }, 403),
      json({ message: "Forbidden" }, 403),
      json({ message: "Forbidden" }, 403),
    );
    const room = resources.channels.wrap(channel);
    const person = resources.wrapMember("10", member);
    const value = resources.wrapRole("10", role);
    await expect(room.delete()).rejects.toMatchObject({ status: 403 });
    await expect(person.kick()).rejects.toMatchObject({ status: 403 });
    await expect(value.delete()).rejects.toMatchObject({ status: 403 });
    expect(resources.channels.cache.get("30")).toBe(room);
    expect(resources.memberCache.get("10:1")).toBe(person);
    expect(resources.roleCache.get("10:11")).toBe(value);
  });

  it("provides channel helpers without keeping removed channels", async () => {
    const { resources, fetch } = setup(
      json(channel),
      empty(),
      empty(),
      json({ code: "invite" }),
      json([]),
      json([]),
      empty(),
    );
    const room = resources.channels.wrap(channel);
    expect((await room.fetch()).id).toBe("30");
    await room.typing();
    await room.deleteOverwrite("11");
    expect(
      new Headers(fetch.mock.calls[2]![1]!.headers).get("X-Fluxer-Features"),
    ).toBe("view_channel_members_permission");
    expect(await room.createInvite()).toEqual({ code: "invite" });
    expect(await room.invites()).toEqual([]);
    expect(await resources.guilds.wrap(guild).invites()).toEqual([]);
    await room.delete();
    expect(resources.channels.cache.get("30")).toBeUndefined();
  });

  it("rejects permission calculations for members from other guilds", () => {
    const { resources } = setup();
    const room = resources.channels.wrap(channel);
    const group = resources.guilds.wrap(guild);
    const person = resources.wrapMember("20", member);
    expect(() => room.permissionsFor(person, [], "99")).toThrow("same guild");
    expect(() => group.permissionsFor(person, [])).toThrow("different guild");
    const local = resources.wrapMember("10", member);
    const everyone = resources.wrapRole("10", { ...role, id: "10" });
    expect(
      group.permissionsFor(local, [everyone]).has(PermissionFlags.VIEW_CHANNEL),
    ).toBe(true);
  });

  it("fetches and deletes invites without authenticating public reads", async () => {
    const { resources, fetch } = setup(json({ code: "test" }), empty());
    expect(await resources.invites.fetch("test")).toEqual({ code: "test" });
    expect(
      new Headers(fetch.mock.calls[0]![1]!.headers).has("Authorization"),
    ).toBe(false);
    await resources.invites.delete("test");
    expect(
      new Headers(fetch.mock.calls[1]![1]!.headers).get("Authorization"),
    ).toBe("Bot bot-secret");
  });
});

describe("webhook credentials and messages", () => {
  it("manages webhooks while excluding tokens from snapshots", async () => {
    const { resources } = setup(
      json(hook),
      json(hook),
      json([hook]),
      json({ ...hook, name: "Renamed" }),
      empty(),
    );
    const room = resources.channels.wrap(channel);
    const created = await room.createWebhook({ name: "hook" });
    expect(JSON.stringify(created)).not.toContain("webhook-secret");
    expect(created.toJSON()).not.toHaveProperty("token");
    expect((await resources.webhooks.fetch("40")).id).toBe("40");
    expect((await room.webhooks())[0]!.id).toBe("40");
    const renamed = await created.edit({ name: "Renamed" });
    expect(renamed.data.name).toBe("Renamed");
    await renamed.delete();
  });

  it("executes and edits webhook messages with attachments and no bot authorization", async () => {
    const { resources, fetch } = setup(
      json(message()),
      json({ ...message(), content: "Edited" }),
      json(message()),
      empty(),
    );
    const value = new Webhook(hook, resources);
    const files = [{ name: "file.txt", data: new Blob(["payload"]) }] as const;
    const sent = await value.execute(
      { content: "hello" },
      { files, timeoutMs: 1000 },
    );
    expect(sent.id).toBe("20");
    expect(
      (await value.editMessage("20", { content: "Edited" }, { files })).content,
    ).toBe("Edited");
    expect((await value.fetchMessage("20")).id).toBe("20");
    await value.deleteMessage("20");
    for (const [, init] of fetch.mock.calls)
      expect(new Headers(init!.headers).has("Authorization")).toBe(false);
    expect(fetch.mock.calls[0]![1]!.body).toBeInstanceOf(FormData);
    expect(String(fetch.mock.calls[0]![0])).toContain("?wait=true");
  });

  it("rejects execution operations when the webhook has no token", async () => {
    const { resources, fetch } = setup();
    const { token, ...withoutToken } = hook;
    const value = new Webhook(withoutToken, resources);
    void token;
    expect(() => value.execute({ content: "x" })).toThrow("no execution token");
    await expect(value.fetchMessage("20")).rejects.toThrow(
      "no execution token",
    );
    await expect(value.editMessage("20", { content: "x" })).rejects.toThrow(
      "no execution token",
    );
    expect(() => value.deleteMessage("20")).toThrow("no execution token");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("message controls and pagination", () => {
  it("applies per-request deadlines through send and webhook helpers", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => new Promise(() => {}));
    const rest = new RESTClient({
      api: "https://example.test",
      token: "synthetic",
      fetch,
    });
    const resources = new Resources(() => rest);
    await expect(
      resources.messages.send("30", "hello", { timeoutMs: 5 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(
      resources.webhooks.execute(
        "40",
        "synthetic-hook",
        { content: "hello" },
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(rest.stats.pending).toBe(0);
  });

  it("edits, reacts, pins, and deletes through a message snapshot", async () => {
    const { messages, fetch } = setup(
      json({ ...message(), content: "Updated" }),
      empty(),
      empty(),
      empty(),
      empty(),
      empty(),
      json({
        items: [{ message: message(), pinned_at: "2026-01-01T00:00:00Z" }],
        has_more: true,
      }),
      empty(),
    );
    const original = messages.wrap(message());
    const updated = await original.edit("Updated", {
      files: [{ name: "x.txt", data: new Blob(["x"]) }],
    });
    expect(original.content).toBe("hello");
    expect(updated.content).toBe("Updated");
    expect(original.guildId).toBeNull();
    await original.react("✅");
    await messages.unreact("10", "20", "✅");
    await original.pin({ reason: "save" });
    await original.unpin({ reason: "clear" });
    await original.delete();
    const pins = await messages.pins("10", { limit: 1 });
    expect(pins.items[0]!.message.id).toBe("20");
    expect(pins.items[0]!.pinnedAt).toBe("2026-01-01T00:00:00Z");
    expect(pins.hasMore).toBe(true);
    await messages.bulkDelete("10", ["20", "21"], { reason: "cleanup" });
    expect(body(fetch, 7)).toEqual({ message_ids: ["20", "21"] });
    expect(
      new Headers(fetch.mock.calls[3]![1]!.headers).get("X-Audit-Log-Reason"),
    ).toBe("save");
  });

  it("validates bulk deletion before sending a request", () => {
    const { messages, fetch } = setup();
    expect(() => messages.bulkDelete("10", [])).toThrow(RangeError);
    expect(() => messages.bulkDelete("10", ["20", "20"])).toThrow("unique");
    expect(() =>
      messages.bulkDelete(
        "10",
        Array.from({ length: 101 }, (_, i) => String(i)),
      ),
    ).toThrow(RangeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops a member iterator at the requested limit even when a server returns too many entries", async () => {
    const { resources, fetch } = setup(
      json([member, { ...member, user: { ...user, id: "2" } }]),
    );
    const values = [];
    for await (const value of new Members(resources, "10").iterate({
      limit: 1,
    }))
      values.push(value);
    expect(values.map((value) => value.id)).toEqual(["1"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels buffered pagination before yielding another entry", async () => {
    const { resources, messages } = setup(
      json([member, { ...member, user: { ...user, id: "2" } }]),
      json([message("20"), message("21")]),
    );
    const control = new AbortController();
    const members = new Members(resources, "10").iterate({
      limit: 2,
      signal: control.signal,
    });
    expect((await members.next()).value!.id).toBe("1");
    control.abort();
    await expect(members.next()).rejects.toMatchObject({ name: "AbortError" });
    const secondControl = new AbortController();
    const history = messages.history("10", {
      limit: 2,
      signal: secondControl.signal,
    });
    expect((await history.next()).value!.id).toBe("20");
    secondControl.abort();
    await expect(history.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("handles empty, invalid, and repeated pagination cursors", async () => {
    const { resources, messages, fetch } = setup(
      json([]),
      json([message("20")]),
    );
    const members = new Members(resources, "10");
    await expect(members.iterate({ limit: -1 }).next()).rejects.toThrow(
      RangeError,
    );
    await expect(messages.history("10", { limit: -1 }).next()).rejects.toThrow(
      RangeError,
    );
    expect((await members.iterate({ limit: 0 }).next()).done).toBe(true);
    expect((await members.iterate().next()).done).toBe(true);
    expect(
      (await messages.history("10", { before: "20" }).next()).value!.id,
    ).toBe("20");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not mutate attachment inputs when assigning multipart IDs", async () => {
    const files = [
      { name: "file.txt", description: "text", data: new Blob(["abc"]) },
    ] as const;
    const input = {
      content: "hello",
      attachments: [{ id: 0, filename: "existing.txt" }],
    };
    const result = multipart(input, files);
    expect(
      JSON.parse(result.get("payload_json") as string).attachments,
    ).toEqual([
      { id: 0, filename: "existing.txt" },
      { id: 1, filename: "file.txt", description: "text" },
    ]);
    expect(input.attachments).toHaveLength(1);
    expect(result.get("files[1]")).toBeInstanceOf(Blob);
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  Permissions,
  PermissionFlags as P,
  permissionsFor,
  compareRoles,
  isTimedOut,
  canManageRole,
  canDeleteRole,
} from "../src/permissions.js";
import { Resources } from "../src/resources.js";
import { RESTClient } from "../src/rest.js";
import { json, message, user } from "./helpers.js";
const everyone = {
  id: "10",
  position: 0,
  permissions: (P.VIEW_CHANNEL | P.SEND_MESSAGES).toString(),
};
const role = { id: "11", position: 1, permissions: P.MANAGE_ROLES.toString() };
const member = { user, roles: ["11"], communication_disabled_until: null };
describe("Fluxer permission rules", () => {
  it("resolves everyone, aggregate roles, then the member overwrite", () => {
    const value = permissionsFor({
      guildId: "10",
      ownerId: "99",
      member,
      roles: [everyone, role, { id: "12", position: 2, permissions: "0" }],
      overwrites: [
        { id: "10", type: 0, allow: "0", deny: P.SEND_MESSAGES.toString() },
        { id: "11", type: 0, allow: P.SEND_MESSAGES.toString(), deny: "0" },
        { id: "1", type: 1, allow: "0", deny: P.SEND_MESSAGES.toString() },
      ],
    });
    expect(value.has(P.VIEW_CHANNEL)).toBe(true);
    expect(value.has(P.SEND_MESSAGES)).toBe(false);
  });
  it("role allows win over other role denies independent of order", () => {
    const value = permissionsFor({
      guildId: "10",
      ownerId: "99",
      member: { ...member, roles: ["11", "12"] },
      roles: [everyone, role],
      overwrites: [
        { id: "11", type: 0, allow: P.SEND_MESSAGES.toString(), deny: "0" },
        { id: "12", type: 0, allow: "0", deny: P.SEND_MESSAGES.toString() },
      ],
    });
    expect(value.has(P.SEND_MESSAGES)).toBe(true);
  });
  it("owner and administrator get the entire unsigned 64-bit mask", () => {
    expect(
      permissionsFor({ guildId: "10", ownerId: "1", member, roles: [] })
        .bitfield,
    ).toBe((1n << 64n) - 1n);
    expect(
      permissionsFor({
        guildId: "10",
        ownerId: "99",
        member,
        roles: [{ ...role, permissions: P.ADMINISTRATOR.toString() }],
      }).bitfield,
    ).toBe((1n << 64n) - 1n);
  });
  it("lower snowflake wins ties; everyone is editable but cannot be deleted", () => {
    expect(
      compareRoles({ id: "2", position: 1 }, { id: "3", position: 1 }),
    ).toBeGreaterThan(0);
    expect(
      canManageRole({
        guildId: "10",
        ownerId: "1",
        member,
        roles: [everyone, role],
        target: everyone,
      }),
    ).toBe(true);
    expect(
      canDeleteRole({
        guildId: "10",
        ownerId: "1",
        member,
        roles: [everyone, role],
        target: everyone,
      }),
    ).toBe(false);
  });
  it("timeouts are separate from the permission mask", () => {
    const timed = {
      ...member,
      communication_disabled_until: new Date(Date.now() + 10000).toISOString(),
    };
    expect(isTimedOut(timed)).toBe(true);
    expect(
      permissionsFor({
        guildId: "10",
        ownerId: "99",
        member: timed,
        roles: [everyone],
      }).has(P.SEND_MESSAGES),
    ).toBe(true);
  });
  it("preserves high bits and rejects unsafe numbers", () => {
    expect(new Permissions(P.VIEW_CHANNEL_MEMBERS).toJSON()).toBe(
      (1n << 54n).toString(),
    );
    expect(() => new Permissions(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => new Permissions("-1")).toThrow();
    expect(
      new Permissions(P.SEND_MESSAGES)
        .add(P.VIEW_CHANNEL)
        .remove(P.SEND_MESSAGES)
        .names(),
    ).toEqual(["VIEW_CHANNEL"]);
  });
});
describe("resource snapshots and relations", () => {
  const setup = () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(user));
    return {
      fetch,
      hub: new Resources(
        () => new RESTClient({ api: "https://example", token: "x", fetch }),
        { users: 1, channels: 2, guilds: 1, members: 1, roles: 1 },
      ),
    };
  };
  it("uses owned deep-frozen snapshots and bounded shared stores", () => {
    const { hub } = setup();
    const raw = message();
    const value = hub.messages.wrap(raw);
    raw.content = "mutated";
    expect(value.content).toBe("hello");
    expect(() => {
      value.data.author.username = "changed";
    }).toThrow();
    hub.users.wrap(user);
    hub.users.wrap({ ...user, id: "2" });
    expect(hub.users.cache.size).toBe(1);
    expect(hub.users.cache.get("1")).toBeUndefined();
  });
  it("sets the Fluxer permission feature header for overwrites", async () => {
    const { hub, fetch } = setup();
    fetch.mockResolvedValue(new Response(null, { status: 204 }));
    await hub.channels
      .wrap({ id: "20", type: 0, guild_id: "10" })
      .setOverwrite("11", { type: 0, allow: "0", deny: "0" });
    expect(
      new Headers(fetch.mock.calls[0]![1]!.headers).get("X-Fluxer-Features"),
    ).toBe("view_channel_members_permission");
  });
  it("cascades guild deletion through every bounded scoped cache", () => {
    const { hub } = setup();
    hub.channels.wrap({ id: "20", type: 0, guild_id: "10" });
    hub.channels.wrap({ id: "21", type: 0, guild_id: "99" });
    hub.apply({ op: 0, t: "GUILD_DELETE", s: 1, d: { id: "10" } });
    expect(hub.channels.cache.get("20")).toBeUndefined();
    expect(hub.channels.cache.get("21")).toBeDefined();
  });
  it("does not retain unavailable guilds as complete resources", () => {
    const { hub } = setup();
    hub.apply({
      op: 0,
      t: "GUILD_CREATE",
      s: 1,
      d: { id: "10", unavailable: true },
    });
    expect(hub.guilds.cache.size).toBe(0);
  });
});

it("overwrite administrator does not expand the computed mask", () => {
  const value = permissionsFor({
    guildId: "10",
    ownerId: "99",
    member,
    roles: [everyone],
    overwrites: [
      {
        id: "1",
        type: 1,
        allow: P.ADMINISTRATOR.toString(),
        deny: P.SEND_MESSAGES.toString(),
      },
    ],
  });
  expect(value.has(P.SEND_MESSAGES)).toBe(false);
});

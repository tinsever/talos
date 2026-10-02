import type { components } from "./types.js";
export const PermissionFlags = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_TTS_MESSAGES: 1n << 12n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_EXPRESSIONS: 1n << 30n,
  USE_EXTERNAL_STICKERS: 1n << 37n,
  MODERATE_MEMBERS: 1n << 40n,
  CREATE_EXPRESSIONS: 1n << 43n,
  PIN_MESSAGES: 1n << 51n,
  BYPASS_SLOWMODE: 1n << 52n,
  UPDATE_RTC_REGION: 1n << 53n,
  VIEW_CHANNEL_MEMBERS: 1n << 54n,
} as const;
export type PermissionResolvable = bigint | string | number | Permissions;
const ALL = (1n << 64n) - 1n;
function bits(value: PermissionResolvable): bigint {
  if (value instanceof Permissions) return value.bitfield;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    throw new RangeError("Permissions require a non-negative safe integer");
  if (typeof value === "string" && !/^\d+$/.test(value))
    throw new TypeError("Permissions must be a decimal string");
  const result = BigInt(value);
  if (result < 0n || result > ALL)
    throw new RangeError("Permissions must fit an unsigned 64-bit mask");
  return result;
}
export class Permissions {
  readonly bitfield: bigint;
  constructor(value: PermissionResolvable = 0n) {
    this.bitfield = bits(value);
  }
  has(value: PermissionResolvable, administrator = false): boolean {
    const mask = bits(value);
    return (
      (administrator &&
        (this.bitfield & PermissionFlags.ADMINISTRATOR) !== 0n) ||
      (this.bitfield & mask) === mask
    );
  }
  missing(value: PermissionResolvable): Permissions {
    return new Permissions(bits(value) & ~this.bitfield);
  }
  add(...values: PermissionResolvable[]): Permissions {
    return new Permissions(
      values.reduce<bigint>((mask, value) => mask | bits(value), this.bitfield),
    );
  }
  remove(...values: PermissionResolvable[]): Permissions {
    return new Permissions(
      values.reduce<bigint>(
        (mask, value) => mask & ~bits(value),
        this.bitfield,
      ),
    );
  }
  /** Serializes only defined bits, fitting Fluxer's signed-64-bit request bound. */
  toRequest(): string {
    return (
      this.bitfield &
      Object.values(PermissionFlags).reduce((mask, bit) => mask | bit, 0n)
    ).toString();
  }
  toJSON(): string {
    return this.bitfield.toString();
  }
  names(): (keyof typeof PermissionFlags)[] {
    return (
      Object.keys(PermissionFlags) as (keyof typeof PermissionFlags)[]
    ).filter((key) => this.has(PermissionFlags[key], false));
  }
}
type Role = Pick<
  components["schemas"]["GuildRoleResponse"],
  "id" | "position" | "permissions"
>;
type Member = Pick<
  components["schemas"]["GuildMemberResponse"],
  "roles" | "communication_disabled_until"
> & { user: { id: string } };
type Overwrite = components["schemas"]["ChannelOverwriteResponse"];
/** Computes masks only; timeout, MFA, and operation-specific policy are separate checks. */
export function permissionsFor(input: {
  guildId: string;
  ownerId: string;
  member: Member | null;
  roles: readonly Role[];
  overwrites?: readonly Overwrite[];
}): Permissions {
  const { guildId, ownerId, member, roles, overwrites = [] } = input;
  if (!member) return new Permissions();
  if (member.user.id === ownerId) return new Permissions(ALL);
  const assigned = new Set([guildId, ...member.roles]);
  let mask = roles.reduce(
    (mask, role) =>
      assigned.has(role.id) ? mask | bits(role.permissions) : mask,
    0n,
  );
  if ((mask & PermissionFlags.ADMINISTRATOR) !== 0n)
    return new Permissions(ALL);
  const apply = (deny: bigint, allow: bigint) => {
    mask = (mask & ~deny) | allow;
  };
  const everyone = overwrites.find((o) => o.type === 0 && o.id === guildId);
  if (everyone) apply(bits(everyone.deny), bits(everyone.allow));
  let allow = 0n,
    deny = 0n;
  for (const o of overwrites)
    if (o.type === 0 && o.id !== guildId && assigned.has(o.id)) {
      allow |= bits(o.allow);
      deny |= bits(o.deny);
    }
  apply(deny, allow);
  const individual = overwrites.find(
    (o) => o.type === 1 && o.id === member.user.id,
  );
  if (individual) apply(bits(individual.deny), bits(individual.allow));
  return new Permissions(mask);
}
/** Positive means a outranks b. Equal positions use the lower snowflake. */
export function compareRoles(
  a: Pick<Role, "id" | "position">,
  b: Pick<Role, "id" | "position">,
): number {
  if (a.position !== b.position) return a.position - b.position;
  const left = BigInt(a.id),
    right = BigInt(b.id);
  return left === right ? 0 : left < right ? 1 : -1;
}
export function highestRole(
  member: Pick<Member, "roles">,
  roles: readonly Role[],
): Role | undefined {
  return roles
    .filter((r) => member.roles.includes(r.id))
    .reduce<
      Role | undefined
    >((highest, r) => (!highest || compareRoles(r, highest) > 0 ? r : highest), undefined);
}
export function isTimedOut(
  member: Pick<Member, "communication_disabled_until">,
  now = Date.now(),
): boolean {
  return (
    member.communication_disabled_until != null &&
    Date.parse(member.communication_disabled_until) > now
  );
}
export function canManageRole(input: {
  guildId: string;
  ownerId: string;
  member: Member;
  roles: readonly Role[];
  target: Role;
}): boolean {
  if (input.member.user.id === input.ownerId) return true;
  const permissions = permissionsFor(input),
    highest = highestRole(input.member, input.roles);
  return (
    permissions.has(PermissionFlags.MANAGE_ROLES) &&
    !!highest &&
    compareRoles(highest, input.target) > 0
  );
}

export function canDeleteRole(
  input: Parameters<typeof canManageRole>[0],
): boolean {
  return input.target.id !== input.guildId && canManageRole(input);
}

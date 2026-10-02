import type { components } from "./types.js";
export type { DispatchEvents } from "./generated/gateway.js";
export { dispatchEventNames } from "./generated/gateway.js";
import type { DispatchEvents } from "./generated/gateway.js";
export type KnownDispatch = {
  [K in keyof DispatchEvents]: { op: 0; t: K; s: number; d: DispatchEvents[K] };
}[keyof DispatchEvents];
export interface SessionPresence {
  session_id: string;
  status: string;
  afk: boolean;
  mobile: boolean;
}
export interface RTCRegion {
  id: string;
  name: string;
  emoji: string;
}
export interface Presence {
  user: components["schemas"]["UserPartialResponse"];
  status: string;
  mobile: boolean;
  afk: boolean;
  custom_status: components["schemas"]["CustomStatusResponse"] | null;
  guild_id?: string;
}
export type GuildReady =
  | { id: string; unavailable: true; unavailable_hidden?: boolean }
  | {
      id: string;
      unavailable?: false;
      unavailable_hidden?: boolean;
      properties: components["schemas"]["GuildResponse"];
      roles: components["schemas"]["GuildRoleResponse"][];
      channels: components["schemas"]["ChannelResponse"][];
      emojis: components["schemas"]["GuildEmojiResponse"][];
      stickers: components["schemas"]["GuildStickerResponse"][];
      members: (Omit<components["schemas"]["GuildMemberResponse"], "user"> & {
        user?: Partial<components["schemas"]["UserPartialResponse"]> & {
          id: string;
        };
        user_id?: string;
      })[];
      member_count: number;
      online_count: number;
      presences: Presence[];
      voice_states: VoiceState[];
      joined_at: string | null;
    };
export interface VoiceState {
  guild_id: string | null;
  channel_id: string | null;
  user_id: string | null;
  connection_id?: string | null;
  session_id?: string | null;
  member?: components["schemas"]["GuildMemberResponse"] | null;
  mute: boolean;
  deaf: boolean;
  self_mute: boolean;
  self_deaf: boolean;
  suppress?: boolean;
  self_video?: boolean;
  self_stream?: boolean;
  is_mobile?: boolean;
  viewer_stream_keys?: string[] | null;
  version?: number;
  e2ee_capable?: boolean;
}
export interface MemberListGroup {
  id: string;
  count: number;
}
export type MemberListItem =
  | { group: MemberListGroup; member?: never }
  | {
      group?: never;
      member: components["schemas"]["GuildMemberResponse"] & {
        presence: Presence | { status: "offline"; mobile: false; afk: false };
      };
    };
export type MemberListOperation = {
  op: "SYNC";
  range: [number, number];
  items: MemberListItem[];
};
export interface ReactionEmoji {
  id?: string;
  name: string;
  animated?: boolean;
}
export interface ReactionAddition {
  user_id: string;
  emoji: ReactionEmoji;
  member?: components["schemas"]["GuildMemberResponse"];
}
export interface GuildCount {
  guild_id: string;
  member_count: number;
  online_count: number;
}
export interface ChannelCount extends GuildCount {
  channel_id: string;
}

import { vi } from "vitest";
import type { WebSocketLike } from "../src/gateway.js";
import type { MessageData, User } from "../src/types.js";

export function json(
  data: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
export const user: User = {
  id: "1",
  username: "bot",
  discriminator: "0001",
  bot: true,
  global_name: null,
  avatar: null,
  avatar_color: null,
  flags: 0,
};
export function message(id = "20"): MessageData {
  return {
    id,
    channel_id: "10",
    author: user,
    content: "hello",
    timestamp: "2026-10-02T00:00:00Z",
    type: 0,
    flags: 0,
    pinned: false,
    mention_everyone: false,
    tts: false,
    mentions: [],
    mention_roles: [],
  };
}
export class FakeSocket implements WebSocketLike {
  readyState = 1;
  readonly frames: { op: number; d: unknown }[] = [];
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  send(data: string): void {
    this.frames.push(JSON.parse(data));
  }
  close = vi.fn(() => {
    this.readyState = 3;
  });
  addEventListener(type: string, listener: (event: never) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])])
      listener(event as never);
  }
  receive(op: number, d?: unknown, t?: string, s?: number): void {
    this.emit("message", { data: JSON.stringify({ op, d, t, s }) });
  }
  hello(interval = 1_000): void {
    this.receive(10, { heartbeat_interval: interval });
  }
  ready(sessionId = "session"): void {
    this.receive(0, { session_id: sessionId, user }, "READY", 1);
  }
  closed(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
  get listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

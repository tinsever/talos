import { Client } from "../src/index.js";
interface Inbox {
  put(key: string, event: unknown, signal: AbortSignal): Promise<void>;
}
export function durableBot(token: string, inbox: Inbox): Client {
  return new Client({
    token,
    gateway: {
      maxPendingDispatches: 500,
      processDispatch: async (frame, { signal }) => {
        if (frame.t !== "MESSAGE_CREATE") return;
        const data = frame.d as { id?: unknown; channel_id?: unknown };
        if (typeof data.id !== "string" || typeof data.channel_id !== "string")
          throw new Error("Invalid message dispatch");
        const key = `message:${data.channel_id}:${data.id}`;
        await inbox.put(key, frame, signal);
      },
    },
  });
}

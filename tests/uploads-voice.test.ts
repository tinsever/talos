import { it, expect, vi } from "vitest";
import { Uploads, UploadError } from "../src/uploads.js";
import { VoiceConnection } from "../src/voice.js";
import { GatewayClient } from "../src/gateway.js";
import { RESTClient } from "../src/rest.js";
import { FakeSocket, json } from "./helpers.js";
const single = {
  id: 0,
  filename: "a.txt",
  file_size: 4,
  content_type: "text/plain",
  upload_filename: "temporary",
  upload_mode: "singlepart",
  upload_url: "https://storage.example/file?capability=private",
};
it("transfers presigned uploads without bot auth or cookies", async () => {
  const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => json({ attachments: [single] })),
    put = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
  const uploader = new Uploads(
    new RESTClient({ api: "https://api.example", token: "secret", fetch }),
    { fetch: put },
  );
  const attachments = await uploader.upload("10", [
    { data: new Blob(["test"], { type: "text/plain" }), name: "a.txt" },
  ]);
  expect(attachments[0]?.upload_filename).toBe("temporary");
  expect(new Headers(put.mock.calls[0]![1]!.headers).has("Authorization")).toBe(
    false,
  );
  expect(put.mock.calls[0]![1]).toMatchObject({
    redirect: "error",
    credentials: "omit",
  });
});
it("splits multipart uploads exactly and completes after all transfers", async () => {
  const plan = {
      ...single,
      upload_mode: "multipart",
      upload_id: "upload",
      part_size: 3,
      parts: [
        { part_number: 1, upload_url: "https://storage.example/1" },
        { part_number: 2, upload_url: "https://storage.example/2" },
      ],
    },
    fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ attachments: [plan] }))
      .mockResolvedValueOnce(json({ uploads: [] })),
    parts: string[] = [];
  const uploader = new Uploads(
    new RESTClient({ api: "https://api.example", token: "secret", fetch }),
    {
      concurrency: 1,
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async (_url, init) => {
          parts.push(await (init!.body as Blob).text());
          return new Response(null, { status: 200 });
        }),
    },
  );
  await uploader.upload("10", [{ data: new Blob(["test"]), name: "a.txt" }]);
  expect(parts).toEqual(["tes", "t"]);
  expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({
    uploads: [{ upload_filename: "temporary", upload_id: "upload" }],
  });
});
it("rejects invalid multipart geometry without sending bytes", async () => {
  const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        json({
          attachments: [
            {
              ...single,
              upload_mode: "multipart",
              upload_id: "upload",
              part_size: 0,
              parts: [],
            },
          ],
        }),
      ),
    put = vi.fn<typeof globalThis.fetch>();
  const uploader = new Uploads(
    new RESTClient({ api: "https://api.example", token: "secret", fetch }),
    { fetch: put },
  );
  await expect(
    uploader.upload("10", [{ data: new Blob(["test"]), name: "a.txt" }]),
  ).rejects.toThrow("geometry");
  expect(put).not.toHaveBeenCalled();
});
it("replans expired capabilities once and does not expose storage payloads", async () => {
  const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => json({ attachments: [single] })),
    put = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        async () => new Response("secret capability body", { status: 403 }),
      );
  const uploader = new Uploads(
    new RESTClient({ api: "https://api.example", token: "secret", fetch }),
    { fetch: put },
  );
  try {
    await uploader.upload("10", [{ data: new Blob(["test"]), name: "a.txt" }]);
    expect.fail("must reject");
  } catch (error) {
    expect(error).toBeInstanceOf(UploadError);
    expect(String(error)).not.toContain("private");
    expect(String(error)).not.toContain("secret");
  }
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("cancels storage transports even when injected fetch ignores signals", async () => {
  const control = new AbortController(),
    fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => json({ attachments: [single] })),
    put = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => new Promise(() => {}));
  const uploader = new Uploads(
    new RESTClient({ api: "https://api.example", token: "secret", fetch }),
    { fetch: put },
  );
  const transfer = uploader.upload(
    "10",
    [{ data: new Blob(["test"]), name: "a.txt" }],
    { signal: control.signal },
  );
  const failed = expect(transfer).rejects.toMatchObject({ name: "AbortError" });
  while (put.mock.calls.length === 0) await Promise.resolve();
  control.abort();
  await failed;
});
async function ready() {
  const socket = new FakeSocket(),
    gateway = new GatewayClient({
      url: "wss://example",
      token: "secret",
      webSocket: () => socket,
    });
  const connected = gateway.connect();
  socket.hello();
  socket.ready();
  await connected;
  return { socket, gateway };
}
it("matches voice grants, keeps credentials out of serialization, and leaves by connection ID", async () => {
  const { socket, gateway } = await ready(),
    transport = {
      disconnect: vi.fn(),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
    },
    adapter = { connect: vi.fn().mockResolvedValue(transport) };
  try {
    const joining = VoiceConnection.join(gateway, adapter, {
      guildId: "10",
      channelId: "20",
    });
    socket.receive(
      0,
      {
        guild_id: "10",
        channel_id: "99",
        connection_id: "wrong",
        token: "secret",
        endpoint: "wss://voice.example",
      },
      "VOICE_SERVER_UPDATE",
      2,
    );
    expect(adapter.connect).not.toHaveBeenCalled();
    socket.receive(
      0,
      {
        guild_id: "10",
        channel_id: "20",
        connection_id: "connection",
        token: "secret",
        endpoint: "wss://voice.example",
      },
      "VOICE_SERVER_UPDATE",
      3,
    );
    const voice = await joining;
    expect(JSON.stringify(voice)).not.toContain("secret");
    await voice.setMuted(true);
    await voice.disconnect();
    expect(socket.frames.at(-1)).toEqual({
      op: 4,
      d: { guild_id: "10", channel_id: null, connection_id: "connection" },
    });
    expect(transport.disconnect).toHaveBeenCalledTimes(1);
  } finally {
    gateway.disconnect();
  }
});
it("closes media that finishes connecting after voice cancellation", async () => {
  const { socket, gateway } = await ready(),
    control = new AbortController(),
    transport = { disconnect: vi.fn() };
  let release!: (value: typeof transport) => void;
  try {
    const joining = VoiceConnection.join(
        gateway,
        { connect: () => new Promise((resolve) => (release = resolve)) },
        { guildId: "10", channelId: "20", signal: control.signal },
      ),
      failed = expect(joining).rejects.toMatchObject({ name: "AbortError" });
    socket.receive(
      0,
      {
        guild_id: "10",
        channel_id: "20",
        connection_id: "connection",
        token: "secret",
        endpoint: "wss://voice.example",
      },
      "VOICE_SERVER_UPDATE",
      2,
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    control.abort();
    await failed;
    release(transport);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(transport.disconnect).toHaveBeenCalledTimes(1);
  } finally {
    gateway.disconnect();
  }
});

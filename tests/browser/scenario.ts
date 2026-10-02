import { runVoiceBrowserTests } from "./voice-scenario.js";
import { Client, PermissionFlags, Permissions } from "../../src/index.js";

interface Status {
  sockets: number;
  uploads: { path: string; size: number; valid: boolean }[];
  completionCount: number;
  pendingUploads: number;
  leakedCredentials: boolean;
}

async function status(): Promise<Status> {
  return (await fetch("/__status")).json();
}

async function waitForStatus(
  predicate: (value: Status) => boolean,
): Promise<Status> {
  const expires = Date.now() + 5000;
  for (;;) {
    const value = await status();
    if (predicate(value)) return value;
    if (Date.now() > expires) throw new Error("Server state did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runBrowserTests() {
  const checks: string[] = [];
  const client = new Client({
    token: "browser-test-token",
    origin: location.origin,
    cache: { messages: 2 },
    gateway: { reconnectBaseMs: 10, reconnectMaxMs: 10 },
  });
  const errors: string[] = [];
  client.on("error", (error) => errors.push(String(error)));
  try {
    await client.connect();
    checks.push("native-discovery", "native-websocket");
    assert(
      (await client.rest.request("GET", "/users/@me")).id === "1",
      "REST response mismatch",
    );
    checks.push("native-fetch");
    assert(
      new Permissions(PermissionFlags.VIEW_CHANNEL).has(
        PermissionFlags.VIEW_CHANNEL,
      ),
      "Permission mismatch",
    );
    checks.push("bigint-permissions");

    const received = client.waitFor(
      "messageCreate",
      (message) => message.content === "browser",
      { timeoutMs: 5000 },
    );
    await client.messages.send("10", "browser");
    const message = await received;
    assert(Object.isFrozen(message.data), "Message snapshot is mutable");
    assert(
      client.cache.get("10:20")?.content === "browser",
      "Created message missing from cache",
    );
    const updated = client.waitFor(
      "messageUpdate",
      (update) => update.content === "edited",
      { timeoutMs: 5000 },
    );
    await message.edit("edited");
    await updated;
    assert(
      client.cache.get("10:20")?.content === "edited",
      "Message update missing from cache",
    );
    assert(message.content === "browser", "Old snapshot changed");
    const deleted = client.waitFor("messageDelete", () => true, {
      timeoutMs: 5000,
    });
    await message.delete();
    await deleted;
    assert(!client.cache.get("10:20"), "Deleted message remains cached");
    checks.push("message-create-update-delete", "immutable-snapshots");

    const direct = client.waitFor(
      "messageCreate",
      (value) => value.content === "direct",
      { timeoutMs: 5000 },
    );
    await client.messages.send("10", "direct", {
      files: [{ name: "direct.txt", data: new Blob(["direct upload"]) }],
    });
    await direct;
    checks.push("multipart-message-upload");
    const resumed = client.waitFor("resumed", () => true, { timeoutMs: 5000 });
    await fetch("/__disconnect", { method: "POST" });
    await resumed;
    assert(
      client.cache.get("10:20")?.content === "direct",
      "Resume lost cached messages",
    );
    checks.push("native-websocket-resume");

    const single = await client.uploads.upload("10", [
      {
        name: "single.txt",
        data: new Blob(["browser upload"], { type: "text/plain" }),
      },
    ]);
    assert(
      single[0]?.upload_filename === "temporary-single.txt",
      "Singlepart upload response mismatch",
    );
    checks.push("presigned-singlepart");

    const bytes = new Uint8Array(8 * 1024 * 1024 + 123);
    for (let index = 0; index < bytes.length; index++)
      bytes[index] = index % 251;
    const progress: number[] = [];
    await client.uploads.upload(
      "10",
      [{ name: "multipart.bin", data: new Blob([bytes]) }],
      {
        onProgress: ({ completedBytes, totalBytes }) => {
          assert(totalBytes === bytes.length, "Total byte count mismatch");
          progress.push(completedBytes);
        },
      },
    );
    const uploaded = await status();
    assert(
      uploaded.uploads.length === 6 &&
        uploaded.uploads.every((part) => part.valid),
      "Uploaded data differs from source",
    );
    assert(
      uploaded.completionCount === 1 && progress.at(-1) === bytes.length,
      "Multipart upload did not complete",
    );
    assert(!uploaded.leakedCredentials, "Storage received credentials");
    checks.push(
      "presigned-multipart",
      "upload-progress",
      "storage-credential-isolation",
    );

    const control = new AbortController();
    const canceled = client.uploads
      .upload("10", [{ name: "cancel.bin", data: new Blob(["cancel"]) }], {
        signal: control.signal,
      })
      .then(
        () => false,
        (error: unknown) =>
          error instanceof DOMException && error.name === "AbortError",
      );
    await waitForStatus((value) => value.pendingUploads === 1);
    control.abort();
    assert(await canceled, "Canceled upload completed");
    await waitForStatus((value) => value.pendingUploads === 0);
    checks.push("native-upload-cancellation");
    assert(errors.length === 0, errors.join("\n"));
    return { passed: true, checks };
  } finally {
    client.disconnect();
    await waitForStatus((value) => value.sockets === 0);
    assert(client.cache.size === 0, "Disconnect retained cache entries");
    checks.push("disconnect-cleanup");
  }
}

const result = runBrowserTests().catch((error: unknown) => ({
  passed: false,
  error: String(error),
}));
Object.assign(window, { talosResult: result });
void result.then((value) => {
  document.querySelector("#output")!.textContent = JSON.stringify(
    value,
    null,
    2,
  );
});

const voiceButton = document.createElement("button");
voiceButton.textContent = "Run voice checks";
document.body.appendChild(voiceButton);
voiceButton.addEventListener("click", () => {
  const result = runVoiceBrowserTests().catch((error: unknown) => ({
    passed: false,
    error: String(error),
  }));
  Object.assign(window, { talosVoiceResult: result });
});

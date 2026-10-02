import { expect, test } from "@playwright/test";

test("native networking, message cache, uploads, and cancellation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const result = await page.evaluate(
    async () =>
      (window as unknown as { talosResult: Promise<unknown> }).talosResult,
  );
  expect(result).toEqual({
    passed: true,
    checks: [
      "native-discovery",
      "native-websocket",
      "native-fetch",
      "bigint-permissions",
      "message-create-update-delete",
      "immutable-snapshots",
      "multipart-message-upload",
      "native-websocket-resume",
      "presigned-singlepart",
      "presigned-multipart",
      "upload-progress",
      "storage-credential-isolation",
      "native-upload-cancellation",
      "disconnect-cleanup",
    ],
  });
  expect(errors).toEqual([]);
});

test("native voice decoding, queued publishing, samples, and disposal", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Run voice checks" }).click();
  const result = await page.evaluate(
    async () =>
      (window as unknown as { talosVoiceResult: Promise<unknown> })
        .talosVoiceResult,
  );
  expect(result).toEqual({
    passed: true,
    checks: [
      "native-audio-decode",
      "native-audio-url",
      "native-audio-publish",
      "native-audio-samples",
      "native-audio-queue",
      "native-audio-disposal",
    ],
  });
});

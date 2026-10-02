import { afterEach, expect, it, vi } from "vitest";
import { RESTClient } from "../src/rest.js";
import { UploadError, Uploads } from "../src/uploads.js";
import { json } from "./helpers.js";

const file = {
  name: "file.txt",
  data: new Blob(["abcd"], { type: "text/plain" }),
};
const single = {
  id: 0,
  filename: file.name,
  file_size: 4,
  content_type: "text/plain",
  upload_filename: "temporary-file",
  upload_mode: "singlepart",
  upload_url: "https://storage.example/file?signature=private",
};

function uploader(
  plan: unknown,
  fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response()),
) {
  const api = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => json(plan));
  return {
    uploads: new Uploads(
      new RESTClient({ api: "https://api.example", token: "test", fetch: api }),
      { fetch },
    ),
    fetch,
    api,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([0, 11])(
  "rejects batches of %i files before requesting a plan",
  async (count) => {
    const { uploads, api } = uploader({ attachments: [single] });
    await expect(
      uploads.upload(
        "10",
        Array.from({ length: count }, () => file),
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(api).not.toHaveBeenCalled();
  },
);

it("enforces the deadline when a storage transport ignores cancellation", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() => new Promise(() => {}));
  const { uploads } = uploader({ attachments: [single] }, fetch);
  const transfer = uploads.upload("10", [file], { timeoutMs: 100 });
  const failed = expect(transfer).rejects.toMatchObject({
    name: "TimeoutError",
  });
  await vi.advanceTimersByTimeAsync(100);
  await failed;
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockResolvedValue(new Response());
  await expect(uploads.upload("10", [file])).resolves.toHaveLength(1);
});

it("binds the native fetch receiver for storage transfers", async () => {
  const api = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(json({ attachments: [single] }));
  const native = vi.fn(function (this: unknown) {
    expect(this).toBe(globalThis);
    return Promise.resolve(new Response());
  });
  vi.stubGlobal("fetch", native);
  await new Uploads(
    new RESTClient({ api: "https://api.example", token: "test", fetch: api }),
  ).upload("10", [file]);
  expect(native).toHaveBeenCalledTimes(1);
});

it.each([
  null,
  {},
  { attachments: [] },
  { attachments: [null] },
  { attachments: [{ ...single, id: -1 }] },
  { attachments: [{ ...single, id: 0.5 }] },
  { attachments: [{ ...single, file_size: 5 }] },
  { attachments: [{ ...single, upload_filename: "" }] },
  { attachments: [{ ...single, upload_mode: "unknown" }] },
  { attachments: [{ ...single, upload_url: "file:///private" }] },
  {
    attachments: [
      { ...single, upload_url: "https://user:pass@storage.example/" },
    ],
  },
  {
    attachments: [
      {
        ...single,
        upload_mode: "multipart",
        upload_id: "id",
        part_size: 2,
        parts: null,
      },
    ],
  },
  {
    attachments: [
      {
        ...single,
        upload_mode: "multipart",
        upload_id: "id",
        part_size: 2,
        parts: [{ part_number: 1 }, { part_number: 1 }],
      },
    ],
  },
])("rejects malformed plans before transferring bytes (%#)", async (plan) => {
  const { uploads, fetch } = uploader(plan);
  await expect(uploads.upload("10", [file])).rejects.toBeInstanceOf(
    UploadError,
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("validates the entire batch before beginning any transfer", async () => {
  const { uploads, fetch } = uploader({
    attachments: [single, { ...single, id: 1, upload_url: "not-a-url" }],
  });
  await expect(uploads.upload("10", [file, file])).rejects.toThrow(
    "presigned upload endpoint",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects duplicate file identifiers before beginning any transfer", async () => {
  const { uploads, fetch } = uploader({ attachments: [single, single] });
  await expect(uploads.upload("10", [file, file])).rejects.toThrow(
    "Invalid upload plan",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("stops a failed multipart batch and never completes it", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => (started = resolve));
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (url, init) => {
      if (String(url).endsWith("/1")) {
        started();
        return new Promise((_resolve, reject) =>
          init!.signal!.addEventListener(
            "abort",
            () => {
              controller.abort();
              reject(init!.signal!.reason);
            },
            { once: true },
          ),
        );
      }
      await firstStarted;
      return new Response(null, { status: 400 });
    });
  const { uploads, api } = uploader(
    {
      attachments: [
        {
          ...single,
          upload_mode: "multipart",
          upload_id: "id",
          part_size: 2,
          parts: [
            { part_number: 1, upload_url: "https://storage.example/1" },
            { part_number: 2, upload_url: "https://storage.example/2" },
          ],
        },
      ],
    },
    fetch,
  );
  await expect(uploads.upload("10", [file])).rejects.toMatchObject({
    status: 400,
  });
  expect(controller.signal.aborted).toBe(true);
  expect(api).toHaveBeenCalledTimes(1);
});

it("retries storage server failures within the upload deadline", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockResolvedValueOnce(new Response());
  const { uploads } = uploader({ attachments: [single] }, fetch);
  const result = uploads.upload("10", [file]);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(result).resolves.toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("aborts queued transfers and releases capacity after cancellation", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const active = new Promise<void>((resolve) => (started = resolve));
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(() => {
      started();
      return new Promise(() => {});
    })
    .mockImplementation(async () => new Response());
  const api = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(json({ attachments: [single, { ...single, id: 1 }] }));
  const uploads = new Uploads(
    new RESTClient({ api: "https://api.example", token: "test", fetch: api }),
    { fetch, concurrency: 1 },
  );
  const result = uploads.upload("10", [file, file], {
    signal: controller.signal,
  });
  const failed = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await active;
  controller.abort();
  await failed;
  expect(fetch).toHaveBeenCalledTimes(1);
  api.mockResolvedValue(json({ attachments: [single] }));
  await expect(uploads.upload("10", [file])).resolves.toHaveLength(1);
});

it("reports completed bytes without allowing observers to interrupt uploads", async () => {
  const { uploads } = uploader({ attachments: [single] });
  const progress = vi.fn(() => {
    throw new Error("observer");
  });
  await expect(
    uploads.upload("10", [{ ...file, description: "description" }], {
      onProgress: progress,
    }),
  ).resolves.toEqual([
    {
      id: 0,
      filename: file.name,
      file_size: 4,
      content_type: "text/plain",
      upload_filename: "temporary-file",
      description: "description",
    },
  ]);
  expect(progress).toHaveBeenCalledWith({ completedBytes: 4, totalBytes: 4 });
});

it("does not retain storage response bodies", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(body));
  const { uploads } = uploader({ attachments: [single] }, fetch);
  await uploads.upload("10", [file]);
  expect(cancel).toHaveBeenCalledOnce();
});

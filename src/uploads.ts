import type { RESTClient } from "./rest.js";
import type { FileAttachment } from "./messages.js";
import type { components } from "./types.js";
import { Semaphore } from "./scheduler.js";
import { abortable, deadline, delay, positive } from "./utils.js";
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UploadError";
  }
}
export interface UploadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: {
    completedBytes: number;
    totalBytes: number;
  }) => void;
}

function uploadEndpoint(value: string): URL {
  try {
    if (typeof value !== "string") throw new Error();
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
    return url;
  } catch {
    throw new UploadError("Invalid presigned upload endpoint");
  }
}

export class Uploads {
  private readonly gate: Semaphore;
  constructor(
    private readonly rest: RESTClient,
    private readonly options: {
      fetch?: typeof globalThis.fetch;
      concurrency?: number;
    } = {},
  ) {
    this.gate = new Semaphore(options.concurrency ?? 4);
  }
  async upload(
    channelId: string,
    files: readonly FileAttachment[],
    options: UploadOptions = {},
  ): Promise<components["schemas"]["ClientUploadedAttachmentRequest"][]> {
    if (files.length < 1 || files.length > 10)
      throw new RangeError("Upload 1..10 attachments at a time");
    const totalBytes = files.reduce((n, file) => n + file.data.size, 0);
    const control = deadline(
      positive(options.timeoutMs ?? 300000, "timeoutMs"),
      options.signal,
    );
    let completedBytes = 0;
    const progress = (size: number) => {
      completedBytes += size;
      try {
        options.onProgress?.({
          completedBytes,
          totalBytes,
        });
      } catch {
        /* observers do not interrupt transfers */
      }
    };
    try {
      for (let attempt = 0; ; attempt++) {
        const batch = new AbortController();
        const abort = () => batch.abort(control.signal.reason);
        control.signal.addEventListener("abort", abort, { once: true });
        if (control.signal.aborted) abort();
        try {
          const plan = await this.rest.request(
            "POST",
            "/channels/{channel_id}/attachments",
            {
              params: { channel_id: channelId },
              body: {
                attachments: files.map((f, id) => ({
                  id,
                  filename: f.name,
                  file_size: f.data.size,
                  content_type: f.data.type || "application/octet-stream",
                })),
              },
              signal: batch.signal,
            },
          );
          if (
            !plan ||
            !Array.isArray(plan.attachments) ||
            plan.attachments.length !== files.length
          )
            throw new UploadError("Upload plan does not cover every file");
          const ids = new Set<number>();
          for (const item of plan.attachments) {
            if (
              !item ||
              !Number.isInteger(item.id) ||
              ids.has(item.id) ||
              !files[item.id] ||
              item.file_size !== files[item.id]!.data.size ||
              typeof item.filename !== "string" ||
              typeof item.content_type !== "string" ||
              typeof item.upload_filename !== "string" ||
              !item.upload_filename
            )
              throw new UploadError("Invalid upload plan");
            ids.add(item.id);
            const file = files[item.id]!;
            if (item.upload_mode === "singlepart") {
              uploadEndpoint(item.upload_url);
            } else if (item.upload_mode === "multipart") {
              if (
                !Number.isSafeInteger(item.part_size) ||
                item.part_size < 1 ||
                !Array.isArray(item.parts) ||
                typeof item.upload_id !== "string" ||
                !item.upload_id ||
                item.parts.length !== Math.ceil(file.data.size / item.part_size)
              )
                throw new UploadError("Invalid multipart geometry");
              const numbers = new Set(item.parts.map((p) => p?.part_number));
              if (
                numbers.size !== item.parts.length ||
                item.parts.some(
                  (p) =>
                    !p ||
                    !Number.isInteger(p.part_number) ||
                    p.part_number < 1 ||
                    p.part_number > item.parts.length,
                )
              )
                throw new UploadError("Invalid multipart part numbering");
              for (const part of item.parts) uploadEndpoint(part.upload_url);
            } else {
              throw new UploadError("Invalid upload mode");
            }
          }
          const work = plan.attachments.map(async (item) => {
            const file = files[item.id]!;
            if (item.upload_mode === "singlepart") {
              await this.put(
                item.upload_url,
                file.data,
                item.content_type,
                batch.signal,
              );
              progress(file.data.size);
            } else {
              await Promise.all(
                item.parts.map(async (part) => {
                  const start = (part.part_number - 1) * item.part_size,
                    data = file.data.slice(
                      start,
                      Math.min(start + item.part_size, file.data.size),
                    );
                  await this.put(
                    part.upload_url,
                    data,
                    item.content_type,
                    batch.signal,
                  );
                  progress(data.size);
                }),
              );
            }
          });
          try {
            await Promise.all(work);
          } catch (error) {
            batch.abort(error);
            await Promise.allSettled(work);
            throw error;
          }
          const multipart = plan.attachments.filter(
            (a) => a.upload_mode === "multipart",
          );
          if (multipart.length)
            await this.rest.request(
              "POST",
              "/channels/{channel_id}/attachments/complete",
              {
                params: { channel_id: channelId },
                body: {
                  uploads: multipart.map((a) => ({
                    upload_filename: a.upload_filename,
                    upload_id: a.upload_id,
                  })),
                },
                signal: batch.signal,
              },
            );
          return plan.attachments.map((a) => ({
            id: a.id,
            filename: a.filename,
            file_size: a.file_size,
            content_type: a.content_type,
            upload_filename: a.upload_filename,
            ...(files[a.id]!.description === undefined
              ? {}
              : { description: files[a.id]!.description }),
          }));
        } catch (error) {
          batch.abort(error);
          control.signal.throwIfAborted();
          if (
            error instanceof UploadError &&
            error.status === 403 &&
            attempt === 0
          ) {
            completedBytes = 0;
            continue;
          }
          throw error;
        } finally {
          control.signal.removeEventListener("abort", abort);
        }
      }
    } finally {
      control.dispose();
    }
  }
  private async put(
    value: string,
    data: Blob,
    contentType: string,
    signal: AbortSignal,
  ): Promise<void> {
    const url = uploadEndpoint(value);
    for (let attempt = 0; ; attempt++) {
      const release = await this.gate.acquire(signal);
      try {
        let response: Response;
        try {
          response = await abortable(
            (this.options.fetch ?? globalThis.fetch.bind(globalThis))(url, {
              method: "PUT",
              body: data,
              headers: { "Content-Type": contentType },
              signal,
              redirect: "error",
              credentials: "omit",
            }),
            signal,
          );
        } catch {
          signal.throwIfAborted();
          throw new UploadError("Upload transport failed");
        }
        if (response.body) await abortable(response.body.cancel(), signal);
        if (response.ok) return;
        throw new UploadError("Storage rejected upload", response.status);
      } catch (error) {
        signal.throwIfAborted();
        if (
          attempt >= 2 ||
          (error instanceof UploadError &&
            error.status !== undefined &&
            error.status < 500)
        )
          throw error;
      } finally {
        release();
      }
      await delay(250 * 2 ** attempt, signal);
    }
  }
}

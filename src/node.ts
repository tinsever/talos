import { Worker } from "node:worker_threads";
import type { MessagePort, TransferListItem } from "node:worker_threads";
import type { SupervisedWorker } from "./supervisor.js";
import type { RateLimitStore } from "./rate-limits.js";
import { abortReason } from "./utils.js";
/** Workers signal startup using parentPort.postMessage({type:'talos:ready'}). */
export function nodeWorkerFactory(
  module: URL,
  options: {
    workerData?: unknown;
    execArgv?: string[];
    transferList?: TransferListItem[];
  } = {},
): (id: number, context: { signal: AbortSignal }) => Promise<SupervisedWorker> {
  return async (id, { signal }) => {
    signal.throwIfAborted();
    const worker = new Worker(module, {
      workerData: { id, data: options.workerData },
      ...(options.transferList ? { transferList: options.transferList } : {}),
      ...(options.execArgv ? { execArgv: options.execArgv } : {}),
    });
    let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => {});
    const message = (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "type" in value &&
        value.type === "talos:ready"
      ) {
        resolveReady();
        worker.off("message", message);
      }
    };
    const abort = () => {
      void worker.terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", message);
    worker.on("error", rejectReady);
    const closed = new Promise<{ code: number }>((resolve) =>
      worker.once("exit", (code) => {
        signal.removeEventListener("abort", abort);
        worker.off("message", message);
        worker.off("error", rejectReady);
        rejectReady(new Error(`Worker exited before readiness (${code})`));
        resolve({ code });
      }),
    );
    return {
      ready,
      closed,
      stop: async () => {
        await worker.terminate();
      },
    };
  };
}
interface RPC {
  id: number;
  kind: "reserve" | "observe" | "penalize" | "cancel";
  key: string;
  headers?: [string, string][];
  retryMs?: number;
  global?: boolean;
}
/** Parent-side coordinator. Use a separate store/server scope per API and credential. */
export function serveRateLimits(
  port: MessagePort,
  store: RateLimitStore,
  maxPending = 1000,
): () => void {
  if (!Number.isInteger(maxPending) || maxPending < 1)
    throw new RangeError("maxPending must be positive");
  const active = new Map<number, AbortController>();
  let closed = false;
  const message = (input: RPC) => {
    if (
      closed ||
      !input ||
      !Number.isSafeInteger(input.id) ||
      typeof input.key !== "string"
    )
      return;
    if (input.kind === "cancel") {
      active.get(input.id)?.abort();
      return;
    }
    if (active.has(input.id)) return;
    if (active.size >= maxPending) {
      port.postMessage({ id: input.id, error: true });
      return;
    }
    const controller = new AbortController();
    active.set(input.id, controller);
    void Promise.resolve()
      .then(async () => {
        if (input.kind === "reserve")
          await store.reserve(input.key, controller.signal);
        else if (input.kind === "observe")
          await store.observe(input.key, new Headers(input.headers));
        else if (input.kind === "penalize") {
          if (!Number.isFinite(input.retryMs) || input.retryMs! < 0)
            throw new Error("Invalid penalty");
          await store.penalize(
            input.key,
            input.retryMs!,
            input.global === true,
          );
        } else throw new Error("Invalid rate command");
        if (!closed) port.postMessage({ id: input.id });
      })
      .catch(() => {
        if (!closed) port.postMessage({ id: input.id, error: true });
      })
      .finally(() => active.delete(input.id));
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    port.off("message", message);
    port.off("close", cleanup);
    for (const controller of active.values()) controller.abort();
    active.clear();
  };
  port.on("message", message);
  port.on("close", cleanup);
  return cleanup;
}
/** Worker-side RPC implementation with bounded pending work and cancellation. */
export class IPCRateLimitStore implements RateLimitStore {
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve(): void; reject(error: unknown): void; cleanup(): void }
  >();
  constructor(
    private readonly port: MessagePort,
    private readonly maxPending = 1000,
  ) {
    if (!Number.isInteger(maxPending) || maxPending < 1)
      throw new RangeError("maxPending must be positive");
    port.on("message", this.receive);
    port.on("close", this.close);
  }
  private readonly receive = (reply: { id: number; error?: boolean }) => {
    if (!reply || !Number.isSafeInteger(reply.id)) return;
    const waiter = this.pending.get(reply.id);
    if (!waiter) return;
    this.pending.delete(reply.id);
    waiter.cleanup();
    if (reply.error) waiter.reject(new Error("Rate limit coordination failed"));
    else waiter.resolve();
  };
  readonly close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.port.off("message", this.receive);
    this.port.off("close", this.close);
    for (const waiter of this.pending.values()) {
      waiter.cleanup();
      waiter.reject(new Error("Rate limit coordinator closed"));
    }
    this.pending.clear();
  };
  reserve(key: string, signal: AbortSignal): Promise<void> {
    return this.call({ kind: "reserve", key }, signal);
  }
  observe(key: string, headers: Headers): Promise<void> {
    return this.call({
      kind: "observe",
      key,
      headers: [...headers.entries()].filter(([name]) =>
        name.toLowerCase().startsWith("x-ratelimit-"),
      ),
    });
  }
  penalize(key: string, retryMs: number, global: boolean): Promise<void> {
    return this.call({ kind: "penalize", key, retryMs, global });
  }
  private call(input: Omit<RPC, "id">, signal?: AbortSignal): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("Rate limit coordinator closed"));
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.pending.size >= this.maxPending)
      return Promise.reject(new Error("Rate limit IPC queue is full"));
    const id = this.sequence++;
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const abort = () => {
        this.pending.delete(id);
        cleanup();
        try {
          this.port.postMessage({ id, kind: "cancel", key: input.key });
        } catch {
          /* closed port */
        }
        reject(abortReason(signal!));
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.port.postMessage({ ...input, id });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }
}

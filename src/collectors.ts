import type { TypedEmitter } from "./events.js";
import { abortReason, positive } from "./utils.js";
export interface CollectorOptions<T> {
  filter?: (value: T) => boolean;
  max?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBuffered?: number;
}
/** Bounded event iterator. Timeout ends normally; cancellation and overflow reject. */
export function collect<E extends object, K extends keyof E>(
  emitter: TypedEmitter<E>,
  event: K,
  options: CollectorOptions<E[K]>,
): AsyncIterableIterator<E[K]> {
  const timeout = positive(options.timeoutMs, "timeoutMs"),
    max = options.max ?? Infinity,
    bufferLimit = options.maxBuffered ?? 100;
  if (
    (max !== Infinity && (!Number.isInteger(max) || max < 1)) ||
    !Number.isInteger(bufferLimit) ||
    bufferLimit < 1
  )
    throw new RangeError("Collector bounds must be positive integers");
  const buffer: E[K][] = [];
  let count = 0,
    done = false,
    failed = false,
    error: unknown;
  let pending:
    | {
        resolve(value: IteratorResult<E[K]>): void;
        reject(error: unknown): void;
      }
    | undefined;
  const finish = (failure?: unknown, reject = false) => {
    if (done) return;
    done = true;
    failed = reject;
    error = failure;
    off();
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (pending) {
      const waiter = pending;
      pending = undefined;
      if (reject) waiter.reject(failure);
      else waiter.resolve({ done: true, value: undefined });
    }
  };
  const abort = () => finish(abortReason(options.signal!), true);
  const off = emitter.on(event, (value) => {
    if (done) return;
    try {
      if (options.filter && !options.filter(value)) return;
    } catch (error) {
      finish(error, true);
      return;
    }
    count++;
    if (pending) {
      const waiter = pending;
      pending = undefined;
      waiter.resolve({ done: false, value });
    } else {
      if (buffer.length >= bufferLimit) {
        finish(new Error("Collector buffer is full"), true);
        return;
      }
      buffer.push(value);
    }
    if (count >= max) finish();
  });
  const timer = setTimeout(() => finish(), timeout);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (failed) return Promise.reject(error);
      if (buffer.length)
        return Promise.resolve({ done: false, value: buffer.shift()! });
      if (done) return Promise.resolve({ done: true, value: undefined });
      if (pending)
        return Promise.reject(
          new Error("Only one pending collector read is supported"),
        );
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
    return() {
      finish();
      buffer.length = 0;
      return Promise.resolve({ done: true, value: undefined });
    },
    throw(reason) {
      finish(reason, true);
      buffer.length = 0;
      return Promise.reject(reason);
    },
  };
}

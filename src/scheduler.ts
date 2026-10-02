import { abortReason } from "./utils.js";

/** FIFO concurrency gate. Aborted waiters are removed immediately. */
export class Semaphore {
  private active = 0;
  private sequence = 0;
  private readonly queue = new Map<
    number,
    {
      signal: AbortSignal;
      resolve(release: () => void): void;
      reject(reason: unknown): void;
      abort(): void;
    }
  >();
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError("Concurrency must be a positive integer");
  }
  get stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.size };
  }
  /** Internal synchronous path; queued callers still acquire in FIFO order. */
  tryAcquire(signal: AbortSignal): (() => void) | undefined {
    signal.throwIfAborted();
    if (this.active >= this.capacity || this.queue.size > 0) return undefined;
    this.active++;
    return this.release();
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    const release = this.tryAcquire(signal);
    if (release) return Promise.resolve(release);
    return new Promise((resolve, reject) => {
      const id = this.sequence++;
      const abort = () => {
        this.queue.delete(id);
        signal.removeEventListener("abort", abort);
        reject(abortReason(signal));
      };
      this.queue.set(id, { signal, resolve, reject, abort });
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      while (this.active < this.capacity && this.queue.size > 0) {
        const [id, waiter] = this.queue.entries().next().value!;
        this.queue.delete(id);
        waiter.signal.removeEventListener("abort", waiter.abort);
        if (waiter.signal.aborted) {
          waiter.reject(abortReason(waiter.signal));
          continue;
        }
        this.active++;
        waiter.resolve(this.release());
      }
    };
  }
}

import { afterEach, it, expect, vi } from "vitest";
import { TypedEmitter } from "../src/events.js";
import { collect } from "../src/collectors.js";
import { WorkerSupervisor } from "../src/supervisor.js";
afterEach(() => vi.useRealTimers());
it("collects filtered events until max and keeps the final buffered value", async () => {
  const emitter = new TypedEmitter<{ value: number }>(),
    iterator = collect(emitter, "value", {
      filter: (n) => n % 2 === 0,
      max: 2,
      timeoutMs: 1000,
    });
  emitter.emit("value", 1);
  emitter.emit("value", 2);
  emitter.emit("value", 4);
  expect(await iterator.next()).toEqual({ done: false, value: 2 });
  expect(await iterator.next()).toEqual({ done: false, value: 4 });
  expect((await iterator.next()).done).toBe(true);
});
it("overflow releases listeners and rejects the consumer", async () => {
  const emitter = new TypedEmitter<{ value: number }>(),
    iterator = collect(emitter, "value", { maxBuffered: 1, timeoutMs: 1000 });
  emitter.emit("value", 1);
  emitter.emit("value", 2);
  await expect(iterator.next()).rejects.toThrow("buffer");
});
it("early return and timeout clear resources", async () => {
  vi.useFakeTimers();
  const emitter = new TypedEmitter<{ value: number }>(),
    iterator = collect(emitter, "value", { timeoutMs: 1000 });
  await iterator.return!();
  expect(vi.getTimerCount()).toBe(0);
  const next = collect(emitter, "value", { timeoutMs: 10 });
  const waiting = next.next();
  await vi.advanceTimersByTimeAsync(10);
  expect((await waiting).done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("supervises exits with a bounded restart budget", async () => {
  vi.useFakeTimers();
  const exits: ((value: { code: number }) => void)[] = [],
    stops = vi.fn(),
    spawn = vi.fn(async () => ({
      ready: Promise.resolve(),
      closed: new Promise<{ code: number }>((resolve) => exits.push(resolve)),
      stop: stops,
    }));
  const supervisor = new WorkerSupervisor({
    count: 1,
    spawn,
    restartBaseMs: 10,
    maxRestarts: 1,
  });
  const errors = vi.fn();
  supervisor.on("error", errors);
  await supervisor.start();
  exits[0]!({ code: 1 });
  await vi.advanceTimersByTimeAsync(10);
  expect(spawn).toHaveBeenCalledTimes(2);
  exits[1]!({ code: 1 });
  await vi.advanceTimersByTimeAsync(0);
  expect(errors).toHaveBeenCalledTimes(1);
  await supervisor.stop();
  expect(vi.getTimerCount()).toBe(0);
});
it("stops a worker that finishes spawning after supervisor cancellation", async () => {
  let finish!: (worker: {
    ready: Promise<void>;
    closed: Promise<{ code: number | null }>;
    stop: () => void;
  }) => void;
  const stop = vi.fn(),
    supervisor = new WorkerSupervisor({
      count: 1,
      spawn: () => new Promise((resolve) => (finish = resolve)),
    });
  const start = supervisor.start(),
    failed = expect(start).rejects.toMatchObject({ name: "AbortError" });
  await supervisor.stop();
  finish({ ready: Promise.resolve(), closed: new Promise(() => {}), stop });
  await failed;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(stop).toHaveBeenCalledTimes(1);
});

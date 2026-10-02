import { TypedEmitter } from "./events.js";
import { abortable, delay, positive } from "./utils.js";
export interface SupervisedWorker {
  ready: Promise<void>;
  closed: Promise<{ code: number | null }>;
  stop(): Promise<void> | void;
}
export interface SupervisorOptions {
  count: number;
  /** Adapter owns process/worker creation and IPC; it must stop when signal aborts. */
  spawn(
    id: number,
    context: { signal: AbortSignal },
  ): Promise<SupervisedWorker>;
  maxRestarts?: number;
  restartBaseMs?: number;
  startupTimeoutMs?: number;
}
interface SupervisorEvents {
  ready: { id: number };
  restart: { id: number; attempt: number };
  error: unknown;
  stopped: void;
}
/** Portable supervision contract for child processes, Worker threads, or external runtimes. */
export class WorkerSupervisor extends TypedEmitter<SupervisorEvents> {
  private control: AbortController | undefined;
  private readonly workers = new Map<number, SupervisedWorker>();
  private readonly tasks = new Set<Promise<void>>();
  private stopping: Promise<void> | undefined;
  constructor(private readonly options: SupervisorOptions) {
    super();
    if (
      !Number.isInteger(options.count) ||
      options.count < 1 ||
      options.count > 16384
    )
      throw new RangeError("Worker count must be 1..16384");
    if (
      !Number.isInteger(options.maxRestarts ?? 5) ||
      (options.maxRestarts ?? 5) < 0
    )
      throw new RangeError("maxRestarts must be non-negative");
    positive(options.restartBaseMs ?? 1000, "restartBaseMs");
    positive(options.startupTimeoutMs ?? 60000, "startupTimeoutMs");
  }
  async start(): Promise<void> {
    if (this.control || this.stopping)
      throw new Error("Workers already running or stopping");
    const control = new AbortController();
    this.control = control;
    try {
      await Promise.all(
        Array.from({ length: this.options.count }, (_, id) =>
          this.launch(id, 0, control),
        ),
      );
    } catch (error) {
      if (this.control === control) await this.stop();
      throw error;
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const control = this.control;
    if (!control) return Promise.resolve();
    this.control = undefined;
    const workers = [...this.workers.values()];
    this.workers.clear();
    this.stopping = Promise.resolve().then(async () => {
      control.abort(new DOMException("Supervisor stopped", "AbortError"));
      const results = await Promise.allSettled(
        workers.map((worker) => Promise.resolve().then(() => worker.stop())),
      );
      for (const result of results)
        if (result.status === "rejected") this.emit("error", result.reason);
      await Promise.allSettled([...this.tasks]);
      this.stopping = undefined;
      this.emit("stopped", undefined);
    });
    return this.stopping;
  }
  private async launch(
    id: number,
    attempt: number,
    control: AbortController,
  ): Promise<void> {
    const timeoutControl = new AbortController(),
      timer = setTimeout(
        () => timeoutControl.abort(new Error(`Worker ${id} startup timed out`)),
        this.options.startupTimeoutMs ?? 60000,
      );
    const creation = Promise.resolve().then(() => {
      control.signal.throwIfAborted();
      return this.options.spawn(id, { signal: control.signal });
    });
    let worker: SupervisedWorker;
    try {
      worker = await abortable(
        abortable(creation, timeoutControl.signal),
        control.signal,
      );
    } catch (error) {
      clearTimeout(timer);
      void creation
        .then(
          (worker) => {
            void worker.ready.catch(() => {});
            void worker.closed.catch(() => {});
            return worker.stop();
          },
          () => {},
        )
        .catch((stopError) => this.emit("error", stopError));
      throw error;
    }
    if (control.signal.aborted) {
      clearTimeout(timer);
      void worker.ready.catch(() => {});
      void worker.closed.catch(() => {});
      await worker.stop();
      return;
    }
    this.workers.set(id, worker);
    const earlyExit = worker.closed.then((exit) => {
      throw new Error(`Worker ${id} exited during startup (${exit.code})`);
    });
    try {
      await abortable(
        abortable(
          Promise.race([worker.ready, earlyExit]),
          timeoutControl.signal,
        ),
        control.signal,
      );
    } finally {
      clearTimeout(timer);
    }
    if (control.signal.aborted) return;
    this.emit("ready", { id });
    if (control.signal.aborted || this.control !== control) return;
    const monitor = abortable(worker.closed, control.signal)
      .then(async () => {
        if (control.signal.aborted) return;
        this.workers.delete(id);
        if (attempt >= (this.options.maxRestarts ?? 5)) {
          this.emit(
            "error",
            new Error(`Worker ${id} restart budget exhausted`),
          );
          void this.stop();
          return;
        }
        this.emit("restart", { id, attempt: attempt + 1 });
        await delay(
          Math.min(30000, (this.options.restartBaseMs ?? 1000) * 2 ** attempt),
          control.signal,
        );
        await this.launch(id, attempt + 1, control);
      })
      .catch((error) => {
        if (!control.signal.aborted) {
          this.emit("error", error);
          if (this.control === control) void this.stop();
        }
      })
      .finally(() => this.tasks.delete(monitor));
    this.tasks.add(monitor);
  }
}

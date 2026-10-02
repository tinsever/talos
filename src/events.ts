type Listener<T> = (value: T) => unknown;
const subscriptions = new WeakMap<
  object,
  ReadonlyMap<unknown, ReadonlySet<unknown>>
>();

/** Internal ownership check; transport payloads may only be adopted unobserved. */
export function listenerCount(emitter: object, event: unknown): number {
  return subscriptions.get(emitter)?.get(event)?.size ?? 0;
}

export class TypedEmitter<E extends object> {
  private readonly listeners = new Map<keyof E, Set<Listener<never>>>();
  private readonly snapshots = new Map<keyof E, readonly Listener<never>[]>();
  constructor(
    private readonly onListenerError: (
      error: unknown,
      event: keyof E,
    ) => void = () => {},
  ) {
    subscriptions.set(this, this.listeners);
  }
  on<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    if (!set.has(listener as Listener<never>)) {
      set.add(listener as Listener<never>);
      this.snapshots.delete(event);
    }
    return () => {
      if (set.delete(listener as Listener<never>) && this.listeners.get(event) === set) {
        this.snapshots.delete(event);
        if (set.size === 0) this.listeners.delete(event);
      }
    };
  }
  once<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    const off = this.on(event, (value) => {
      off();
      return listener(value);
    });
    return off;
  }
  emit<K extends keyof E>(event: K, value: E[K]): void {
    let listeners = this.snapshots.get(event);
    if (!listeners) {
      const subscriptions = this.listeners.get(event);
      if (!subscriptions) return;
      this.snapshots.set(event, listeners = [...subscriptions]);
    }
    for (const listener of listeners) {
      try {
        const result = (listener as Listener<E[K]>)(value);
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function")
        )
          Promise.resolve(result).catch((error) =>
            this.onListenerError(error, event),
          );
      } catch (error) {
        this.onListenerError(error, event);
      }
    }
  }
  removeAllListeners(): void {
    this.listeners.clear();
    this.snapshots.clear();
  }
}

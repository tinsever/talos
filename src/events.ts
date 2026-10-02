type Listener<T> = (value: T) => unknown;
export class TypedEmitter<E extends object> {
  private readonly listeners = new Map<keyof E, Set<Listener<never>>>();
  constructor(
    private readonly onListenerError: (
      error: unknown,
      event: keyof E,
    ) => void = () => {},
  ) {}
  on<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set.delete(listener as Listener<never>);
      if (set.size === 0 && this.listeners.get(event) === set)
        this.listeners.delete(event);
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
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        const result = (listener as Listener<E[K]>)(value);
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
  }
}

/** An opt-in cache; disabled when maxSize is zero. Never used implicitly by REST. */
export class LRUCache<K, V> {
  private readonly entries = new Map<K, { value: V; expires: number }>();
  constructor(
    readonly maxSize = 100,
    readonly ttlMs = Infinity,
  ) {
    if (!Number.isInteger(maxSize) || maxSize < 0)
      throw new RangeError("maxSize must be a non-negative integer");
    if (!(ttlMs > 0)) throw new RangeError("ttlMs must be positive");
  }
  get size(): number {
    this.sweep();
    return this.entries.size;
  }
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (this.ttlMs !== Infinity && entry.expires <= Date.now()) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: K, value: V): this {
    if (this.maxSize === 0) return this;
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expires: this.ttlMs === Infinity ? Infinity : Date.now() + this.ttlMs,
    });
    while (this.entries.size > this.maxSize)
      this.entries.delete(this.entries.keys().next().value!);
    return this;
  }
  *items(): IterableIterator<[K, V]> {
    this.sweep();
    for (const [key, entry] of this.entries) yield [key, entry.value];
  }
  delete(key: K): boolean {
    return this.entries.delete(key);
  }
  clear(): void {
    this.entries.clear();
  }
  sweep(): number {
    if (this.ttlMs === Infinity || this.entries.size === 0) return 0;
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.entries)
      if (entry.expires <= now) {
        this.entries.delete(key);
        removed++;
      }
    return removed;
  }
}

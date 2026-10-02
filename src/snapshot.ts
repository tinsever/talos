/** Own immutable JSON snapshot; callers cannot mutate caches through returned data. */
export function snapshot<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (node: unknown): void => {
    if (node && typeof node === "object" && !Object.isFrozen(node)) {
      Object.freeze(node);
      for (const child of Object.values(node)) freeze(child);
    }
  };
  freeze(clone);
  return clone;
}

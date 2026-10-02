// Only snapshots created here may be reused. A caller's shallow-frozen object
// is not sufficient proof that its descendants are immutable.
const owned = new WeakSet<object>();
const nativeClone = Symbol("native clone required");

function copyFrozen(value: unknown, seen: Map<object, object>): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol")
      throw nativeClone;
    return value;
  }
  if (owned.has(value)) return value;
  const previous = seen.get(value);
  if (previous) return previous;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== (array ? Array.prototype : Object.prototype) &&
    prototype !== null
  )
    throw nativeClone;
  const result = (array
    ? new Array((value as unknown[]).length)
    : {}) as Record<string, unknown>;
  seen.set(value, result);
  for (const key of Object.keys(value)) {
    // Fall back before invoking any getters, so native cloning reads them once.
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, "value")) throw nativeClone;
    const child = copyFrozen(descriptor.value, seen);
    if (key === "__proto__")
      Object.defineProperty(result, key, { value: child, enumerable: true });
    else result[key] = child;
  }
  Object.freeze(result);
  owned.add(result);
  return result;
}

function freeze(node: unknown): void {
  if (node && typeof node === "object" && !Object.isFrozen(node)) {
    Object.freeze(node);
    for (const child of Object.values(node)) freeze(child);
  }
}

/** Internal: only for freshly parsed JSON that has never escaped to user code. */
export function adoptSnapshot<T>(value: T): T {
  freeze(value);
  if (value && typeof value === "object") owned.add(value);
  return value;
}

/** Own immutable JSON snapshot; callers cannot mutate caches through returned data. */
export function snapshot<T>(value: T): T {
  if (value && typeof value === "object" && owned.has(value)) return value;
  try {
    return copyFrozen(value, new Map()) as T;
  } catch (error) {
    if (error !== nativeClone) throw error;
    const clone = structuredClone(value);
    freeze(clone);
    return clone;
  }
}

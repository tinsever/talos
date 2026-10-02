import type { components, paths } from "./generated/api.js";
export type { components, operations, paths } from "./generated/api.js";
export type User = components["schemas"]["UserPartialResponse"];
export type MessageData = components["schemas"]["MessageResponseSchema"] & {
  guild_id?: string;
};
export type MessageCreate = components["schemas"]["MessageRequestSchema"];
export type MessageEdit = components["schemas"]["MessageUpdateRequestSchema"];
export type Method =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";
export type PathsFor<M extends Method> = {
  [P in keyof paths]: Lowercase<M> extends keyof paths[P]
    ? NonNullable<paths[P][Lowercase<M>]> extends never
      ? never
      : P
    : never;
}[keyof paths];
type Operation<M extends Method, P extends PathsFor<M>> =
  Lowercase<M> extends keyof paths[P]
    ? NonNullable<paths[P][Lowercase<M>]>
    : never;
type Parameters<O> = O extends { parameters: infer T } ? T : never;
type Parameter<O, K extends string> = K extends keyof Parameters<O>
  ? NonNullable<Parameters<O>[K]>
  : never;
type RequiredKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];
type ParameterOption<O, K extends string, Name extends string> = [
  Parameter<O, K>,
] extends [never]
  ? { [N in Name]?: never }
  : [RequiredKeys<Parameter<O, K>>] extends [never]
    ? { [N in Name]?: Parameter<O, K> }
    : { [N in Name]: Parameter<O, K> };
type Body<O> = O extends { requestBody?: { content: infer C } }
  ? "application/json" extends keyof C
    ? C["application/json"]
    : C[keyof C]
  : never;
type BodyOption<O> = [Body<O>] extends [never]
  ? { body?: never }
  : O extends { requestBody: unknown }
    ? { body: Body<O> | FormData }
    : { body?: Body<O> | FormData };
export interface OperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  reason?: string;
}

export type RequestOptions<
  M extends Method,
  P extends PathsFor<M>,
> = ParameterOption<Operation<M, P>, "path", "params"> &
  ParameterOption<Operation<M, P>, "query", "query"> &
  BodyOption<Operation<M, P>> &
  OperationOptions & {
    headers?: HeadersInit;
    /** Overrides the schema's default authentication policy. */
    auth?: boolean;
    /** Override sharing of identical in-flight GETs; other methods are never shared. */
    coalesce?: boolean;
  };
export type RequestArgs<M extends Method, P extends PathsFor<M>> = [
  RequiredKeys<RequestOptions<M, P>>,
] extends [never]
  ? [options?: RequestOptions<M, P>]
  : [options: RequestOptions<M, P>];
type ResponseContent<R> = R extends { content: infer C }
  ? "application/json" extends keyof C
    ? C["application/json"]
    : Blob
  : void;
export type ResponseData<M extends Method, P extends PathsFor<M>> =
  Operation<M, P> extends { responses: infer R }
    ? {
        [K in keyof R]: `${K & (string | number)}` extends `2${string}`
          ? ResponseContent<R[K]>
          : never;
      }[keyof R]
    : never;

export type ReadyData =
  import("./generated/gateway.js").DispatchEvents["READY"];
export interface GatewayDispatch {
  op: 0;
  t: string;
  s: number;
  d: unknown;
}

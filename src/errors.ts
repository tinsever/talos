export class FluxerAPIError extends Error {
  readonly code: string | undefined;
  constructor(
    readonly status: number,
    readonly method: string,
    readonly route: string,
    readonly body: unknown,
  ) {
    const data =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    super(
      typeof data.message === "string"
        ? data.message
        : `Fluxer API returned HTTP ${status}`,
    );
    this.name = "FluxerAPIError";
    this.code = typeof data.code === "string" ? data.code : undefined;
  }
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export class RequestQueueFullError extends Error {
  constructor(readonly limit: number) {
    super(`REST request capacity (${limit}) exceeded`);
    this.name = "RequestQueueFullError";
  }
}

import type { PublishErrorData, PublishErrorKind, PublishOutcome } from "./types";

export class PublishError extends Error {
  readonly data: PublishErrorData;

  constructor(
    code: string,
    message: string,
    options: {
      kind?: PublishErrorKind;
      retryable?: boolean;
      outcome?: PublishOutcome;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "PublishError";
    this.data = {
      code,
      kind: options.kind ?? "validation",
      message,
      retryable: options.retryable ?? false,
      outcome: options.outcome ?? "not_applied",
      details: options.details,
    };
  }
}

export function asPublishError(error: unknown): PublishError {
  if (error instanceof PublishError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new PublishError("E_INTERNAL", message, {
    kind: "transient",
    retryable: false,
    outcome: "unknown",
  });
}

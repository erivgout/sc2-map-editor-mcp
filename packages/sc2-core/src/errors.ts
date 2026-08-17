/**
 * Stable, machine-readable domain errors (PLAN.md §34).
 *
 * Every error surfaced to a model carries a code, a human message, the relevant
 * path/object, whether the caller can recover, and — when we know one — a concrete
 * next action. Native stack traces stay in the logs; they are never part of the
 * model-visible payload.
 */

export const SC2_ERROR_CODES = [
  'SC2_WORKSPACE_NOT_FOUND',
  'SC2_SOURCE_CHANGED',
  'SC2_UNSUPPORTED_COMPONENT',
  'SC2_PARSE_ERROR',
  'SC2_VALIDATION_FAILED',
  'SC2_BROKEN_REFERENCE',
  'SC2_CONFLICT',
  'SC2_PACK_FAILED',
  'SC2_EDITOR_NOT_FOUND',
  'SC2_TEST_LAUNCH_FAILED',
  'SC2_PATH_DENIED',
  /** Not in PLAN.md §34's starter list, but needed before any of the above can fire. */
  'SC2_NOT_FOUND',
  'SC2_INVALID_ARGUMENT',
  'SC2_LIMIT_EXCEEDED',
  'SC2_UNSUPPORTED_OPERATION',
  'SC2_IO_ERROR',
  'SC2_INTERNAL_ERROR',
] as const;

export type SC2ErrorCode = (typeof SC2_ERROR_CODES)[number];

export interface SC2ErrorDetails {
  /** Filesystem or in-archive path the error concerns, if any. */
  readonly path?: string;
  /** Workspace the error concerns, if any. */
  readonly workspaceId?: string;
  /** Catalog/domain object the error concerns, e.g. `Unit/Marine`. */
  readonly objectId?: string;
  /**
   * Whether the caller can plausibly fix this and retry. `false` means the request
   * will keep failing until something outside the caller's control changes.
   */
  readonly recoverable?: boolean;
  /** A concrete next step, when there is an unambiguous one. */
  readonly suggestedAction?: string;
  /** Extra structured context. Must stay small — this goes to the model. */
  readonly context?: Readonly<Record<string, unknown>>;
}

export class SC2Error extends Error {
  readonly code: SC2ErrorCode;
  readonly details: SC2ErrorDetails;

  constructor(code: SC2ErrorCode, message: string, details: SC2ErrorDetails = {}, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = 'SC2Error';
    this.code = code;
    this.details = details;
  }

  /** The model-visible shape. Deliberately excludes `stack` and `cause`. */
  toPayload(): SC2ErrorPayload {
    const payload: SC2ErrorPayload = {
      code: this.code,
      message: this.message,
      recoverable: this.details.recoverable ?? true,
    };
    if (this.details.path !== undefined) payload.path = this.details.path;
    if (this.details.workspaceId !== undefined) payload.workspaceId = this.details.workspaceId;
    if (this.details.objectId !== undefined) payload.objectId = this.details.objectId;
    if (this.details.suggestedAction !== undefined) payload.suggestedAction = this.details.suggestedAction;
    if (this.details.context !== undefined) payload.context = this.details.context;
    return payload;
  }
}

export interface SC2ErrorPayload {
  code: SC2ErrorCode;
  message: string;
  recoverable: boolean;
  path?: string;
  workspaceId?: string;
  objectId?: string;
  suggestedAction?: string;
  context?: Readonly<Record<string, unknown>>;
}

export function isSC2Error(value: unknown): value is SC2Error {
  return value instanceof SC2Error;
}

/**
 * Coerces anything thrown into a model-safe payload. Unknown throwables become
 * `SC2_INTERNAL_ERROR` with a generic message — the real detail belongs in the log,
 * not in the tool result.
 */
export function toErrorPayload(error: unknown): SC2ErrorPayload {
  if (isSC2Error(error)) return error.toPayload();
  return {
    code: 'SC2_INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'Unknown internal error.',
    recoverable: false,
    suggestedAction: 'Check the server log for the full diagnostic.',
  };
}

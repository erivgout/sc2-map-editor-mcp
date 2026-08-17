/**
 * Structured logging (PLAN.md §36).
 *
 * Hard rule (PLAN.md §55 rule 12): nothing here may ever write to stdout. On a stdio
 * MCP connection stdout is the protocol wire, and a single stray byte desynchronises
 * the client. Everything goes to stderr as one JSON object per line.
 */

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `fields` into every subsequent record. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Where records go. Defaults to `process.stderr`. Never `process.stdout`. */
  sink?: (line: string) => void;
  /** Fields merged into every record. */
  base?: LogFields;
  /** Injectable for deterministic tests. */
  now?: () => Date;
}

/**
 * Values longer than this are truncated. Guards PLAN.md §36's "do not log entire map
 * files / giant Galaxy scripts / binary blobs".
 */
const MAX_FIELD_CHARS = 2048;

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…[${value.length} chars]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[binary ${value.byteLength} bytes]`;
  }
  if (depth >= 4) return '[depth limit]';
  if (Array.isArray(value)) {
    const head = value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
    return value.length > 50 ? [...head, `…[${value.length} items]`] : head;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeValue(inner, depth + 1);
    }
    return out;
  }
  // Only symbols and functions reach here. Neither carries useful diagnostic content,
  // and interpolating a symbol would throw, so report the type instead.
  return `[${typeof value}]`;
}

class JsonLogger implements Logger {
  readonly #level: LogLevel;
  readonly #sink: (line: string) => void;
  readonly #base: LogFields;
  readonly #now: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.#level = options.level ?? 'info';
    this.#sink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));
    this.#base = options.base ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  #log(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#level]) return;
    const record: Record<string, unknown> = {
      ts: this.#now().toISOString(),
      level,
      msg: message,
      ...(sanitizeValue({ ...this.#base, ...fields }) as Record<string, unknown>),
    };
    try {
      this.#sink(JSON.stringify(record));
    } catch {
      // A logger must never take the server down. Drop the record and continue.
    }
  }

  trace(message: string, fields?: LogFields): void {
    this.#log('trace', message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.#log('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.#log('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.#log('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.#log('error', message, fields);
  }

  child(fields: LogFields): Logger {
    return new JsonLogger({
      level: this.#level,
      sink: this.#sink,
      base: { ...this.#base, ...fields },
      now: this.#now,
    });
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new JsonLogger(options);
}

/** A logger that discards everything. Useful in tests. */
export function createNullLogger(): Logger {
  return createLogger({ level: 'error', sink: () => {} });
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(normalized) ? (normalized as LogLevel) : fallback;
}

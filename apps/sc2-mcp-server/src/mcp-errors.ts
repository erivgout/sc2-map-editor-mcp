/**
 * Translation between the domain error model (PLAN.md §34) and MCP tool results.
 *
 * The SDK's own `tools/call` wrapper catches thrown errors and flattens them to a
 * bare text result, discarding structure. So handlers here never throw: they are
 * wrapped by {@link toolHandler}, which converts every outcome — success or failure —
 * into a `CallToolResult` that keeps the machine-readable payload intact.
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { SC2Error, toErrorPayload, type Logger, type SC2ErrorPayload } from '@sc2mcp/core';

/** What every tool handler in this app returns. Alias so the SDK stays the authority. */
export type ToolResult = CallToolResult;

/**
 * A successful result.
 *
 * Both forms are always emitted: `structuredContent` for programmatic use, and a
 * concise text rendering for clients (and models) that read the text block. The text
 * is a summary, never a dump of the structured payload.
 */
export function ok(summary: string, structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: structured,
  };
}

/**
 * A failure result.
 *
 * `isError: true` means the SDK skips output-schema validation, so the error payload
 * is free to have a different shape from the tool's declared success schema.
 */
export function fail(payload: SC2ErrorPayload): ToolResult {
  const lines = [`${payload.code}: ${payload.message}`];
  if (payload.path !== undefined) lines.push(`path: ${payload.path}`);
  if (payload.objectId !== undefined) lines.push(`object: ${payload.objectId}`);
  if (payload.suggestedAction !== undefined) lines.push(`next: ${payload.suggestedAction}`);

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: { error: payload as unknown as Record<string, unknown> },
    isError: true,
  };
}

export interface ToolHandlerOptions {
  readonly name: string;
  readonly logger: Logger;
}

/**
 * Wraps a tool implementation with logging and error translation.
 *
 * Logs one record per call with name, duration, and outcome (PLAN.md §36). The full
 * error — including cause and stack — goes to the log; only {@link SC2ErrorPayload}
 * reaches the model (PLAN.md §34).
 */
export function toolHandler<Args>(
  options: ToolHandlerOptions,
  implementation: (args: Args) => ToolResult | Promise<ToolResult>,
): (args: Args) => Promise<ToolResult> {
  return async (args: Args): Promise<ToolResult> => {
    const startedAt = process.hrtime.bigint();
    const durationMs = (): number => Number(process.hrtime.bigint() - startedAt) / 1e6;

    try {
      const result = await implementation(args);
      options.logger.info('tool ok', { tool: options.name, durationMs: durationMs() });
      return result;
    } catch (error) {
      const payload = toErrorPayload(error);
      options.logger.error('tool failed', {
        tool: options.name,
        durationMs: durationMs(),
        code: payload.code,
        message: payload.message,
        // Only unexpected failures deserve a stack; domain errors are self-describing.
        stack: error instanceof SC2Error ? undefined : error instanceof Error ? error.stack : String(error),
      });
      return fail(payload);
    }
  };
}

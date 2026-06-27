/**
 * Tiny error helpers shared by the runtime emit sites (observability §2/§3).
 */

/** The stack trace if `e` is a real `Error`, else undefined (strings carry none). */
export function stackOf(e: unknown): string | undefined {
  return e instanceof Error ? e.stack : undefined;
}

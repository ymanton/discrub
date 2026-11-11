/**
 * Cursors for scheduled exports.
 *
 * Every scheduled channel and thread keeps an `after` cursor: the id of the
 * newest message already exported. `GET /channels/{id}/messages?after=<id>`
 * returns the messages after it, so a run only fetches what is new. The
 * three starting points a channel can have all come down to a first cursor:
 * full history starts after id 0, "from now on" after the snowflake for the
 * schedule's start, and "from a date" after the snowflake for that date.
 */

/** Discord's epoch (2015-01-01T00:00:00Z) in ms; snowflakes count from it. */
export const DISCORD_EPOCH_MS = 1420070400000;

/** Messages per page on the list endpoint (Discord's maximum). */
export const PAGE_SIZE = 100;

/** Where a scheduled channel starts. */
export type StartPoint =
  | { kind: 'full' }
  | { kind: 'now' }
  /** `date` is an ISO 8601 string. */
  | { kind: 'date'; date: string };

/**
 * The cursor that makes `after` return every message created at or after
 * `date`. The smallest snowflake for a millisecond is `ms << 22`, and `after`
 * excludes the id itself, so the cursor sits one below it. Dates before
 * Discord's epoch give '0'.
 */
export const afterCursorForDate = (date: Date): string => {
  const ms = BigInt(date.getTime() - DISCORD_EPOCH_MS);
  if (ms <= 0n) return '0';
  return ((ms << 22n) - 1n).toString();
};

/** The first cursor for a channel with this starting point. */
export const initialCursor = (start: StartPoint, now: Date): string => {
  switch (start.kind) {
    case 'full':
      return '0';
    case 'now':
      return afterCursorForDate(now);
    case 'date': {
      const date = new Date(start.date);
      if (Number.isNaN(date.getTime())) throw new Error(`Invalid start date: ${start.date}`);
      return afterCursorForDate(date);
    }
  }
};

/** Numeric comparison of two snowflakes (they overflow a JS number). */
export const compareSnowflakes = (a: string, b: string): number => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** One page of new messages, oldest first, and the cursor after it. */
export interface ForwardPage<T> {
  messages: T[];
  cursor: string;
}

/**
 * Pages forward from `cursor` until nothing newer is left. Each page comes
 * back oldest first (Discord sends newest first even with `after`) with the
 * cursor to save once the page is written, so an interrupted walk resumes
 * from the last saved page. A page shorter than `pageSize` ends the walk,
 * which keeps a quiet channel at one request.
 *
 * `fetchPage` does the request; errors it throws pass through to the caller.
 */
export async function* pageForward<T extends { id: string }>(
  fetchPage: (cursor: string) => Promise<T[]>,
  cursor: string,
  pageSize: number = PAGE_SIZE,
): AsyncGenerator<ForwardPage<T>> {
  let current = cursor;
  for (;;) {
    const page = await fetchPage(current);
    const fresh = page
      .filter((m) => compareSnowflakes(m.id, current) > 0)
      .sort((a, b) => compareSnowflakes(a.id, b.id));
    if (fresh.length === 0) return;
    current = fresh[fresh.length - 1].id;
    yield { messages: fresh, cursor: current };
    if (page.length < pageSize) return;
  }
}

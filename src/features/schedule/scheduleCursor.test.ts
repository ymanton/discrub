import { describe, it, expect, vi } from 'vitest';
import {
  DISCORD_EPOCH_MS,
  afterCursorForDate,
  compareSnowflakes,
  initialCursor,
  pageForward,
  type ForwardPage,
} from './scheduleCursor';

const snowflakeAt = (ms: number, increment = 0): string =>
  ((BigInt(ms - DISCORD_EPOCH_MS) << 22n) + BigInt(increment)).toString();

const collect = async <T>(gen: AsyncGenerator<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
};

/** A fake channel: ids 1..count, served newest first like Discord. */
const fakeChannel = (count: number, pageSize: number) => {
  const all = Array.from({ length: count }, (_, i) => ({ id: String(i + 1) }));
  return vi.fn(async (after: string) =>
    all.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, pageSize).reverse(),
  );
};

describe('scheduleCursor', () => {
  describe('afterCursorForDate', () => {
    it('includes a message created at exactly that millisecond', () => {
      const ms = Date.UTC(2024, 5, 1, 12, 0, 0);
      const cursor = afterCursorForDate(new Date(ms));
      expect(compareSnowflakes(snowflakeAt(ms), cursor)).toBe(1);
    });

    it('excludes a message from the millisecond before', () => {
      const ms = Date.UTC(2024, 5, 1, 12, 0, 0);
      const cursor = afterCursorForDate(new Date(ms));
      const before = snowflakeAt(ms - 1, (1 << 22) - 1);
      expect(compareSnowflakes(before, cursor)).toBe(0);
    });

    it('matches a known snowflake', () => {
      // Discord's docs example: 175928847299117063 is 2016-04-30T11:18:25.796Z.
      const cursor = afterCursorForDate(new Date('2016-04-30T11:18:25.796Z'));
      expect(compareSnowflakes('175928847299117063', cursor)).toBe(1);
      expect(compareSnowflakes(cursor, '175928847299117063')).toBe(-1);
    });

    it('gives 0 for dates at or before the Discord epoch', () => {
      expect(afterCursorForDate(new Date(DISCORD_EPOCH_MS))).toBe('0');
      expect(afterCursorForDate(new Date('2010-01-01T00:00:00Z'))).toBe('0');
    });
  });

  describe('initialCursor', () => {
    const now = new Date('2026-11-11T10:00:00Z');

    it('starts full history after id 0', () => {
      expect(initialCursor({ kind: 'full' }, now)).toBe('0');
    });

    it('starts "from now on" at the schedule start', () => {
      expect(initialCursor({ kind: 'now' }, now)).toBe(afterCursorForDate(now));
    });

    it('starts at a chosen date', () => {
      const date = '2026-01-01T00:00:00Z';
      expect(initialCursor({ kind: 'date', date }, now)).toBe(afterCursorForDate(new Date(date)));
    });

    it('rejects an invalid date', () => {
      expect(() => initialCursor({ kind: 'date', date: 'not a date' }, now)).toThrow(/Invalid start date/);
    });
  });

  describe('compareSnowflakes', () => {
    it('compares beyond Number precision', () => {
      expect(compareSnowflakes('1234567890123456789', '1234567890123456790')).toBe(-1);
      expect(compareSnowflakes('1234567890123456790', '1234567890123456789')).toBe(1);
      expect(compareSnowflakes('42', '42')).toBe(0);
    });

    it('compares numerically, not as strings', () => {
      expect(compareSnowflakes('9', '10')).toBe(-1);
    });
  });

  describe('pageForward', () => {
    it('walks every page oldest first and ends on a short page', async () => {
      const fetchPage = fakeChannel(250, 100);
      const pages = await collect(pageForward(fetchPage, '0', 100));

      expect(pages.map((p) => p.messages.length)).toEqual([100, 100, 50]);
      expect(pages.flatMap((p) => p.messages.map((m) => m.id))).toEqual(
        Array.from({ length: 250 }, (_, i) => String(i + 1)),
      );
      expect(pages.map((p) => p.cursor)).toEqual(['100', '200', '250']);
      expect(fetchPage).toHaveBeenCalledTimes(3);
    });

    it('costs one request when nothing is new', async () => {
      const fetchPage = fakeChannel(10, 100);
      const pages = await collect(pageForward(fetchPage, '10', 100));
      expect(pages).toEqual([]);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('costs one request for a short page of new messages', async () => {
      const fetchPage = fakeChannel(12, 100);
      const pages = await collect(pageForward(fetchPage, '10', 100));
      expect(pages).toEqual([{ messages: [{ id: '11' }, { id: '12' }], cursor: '12' }]);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('asks for the next page after the last cursor', async () => {
      const fetchPage = fakeChannel(150, 100);
      await collect(pageForward(fetchPage, '0', 100));
      expect(fetchPage.mock.calls.map(([after]) => after)).toEqual(['0', '100']);
    });

    it('needs one extra request when history is an exact multiple of the page size', async () => {
      const fetchPage = fakeChannel(200, 100);
      const pages = await collect(pageForward(fetchPage, '0', 100));
      expect(pages).toHaveLength(2);
      expect(fetchPage).toHaveBeenCalledTimes(3);
    });

    it('drops messages at or before the cursor and stops instead of looping', async () => {
      const fetchPage = vi.fn(async () => Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1) })));
      const pages = await collect(pageForward(fetchPage, '100', 100));
      expect(pages).toEqual([]);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('resumes from a saved cursor after the caller stops early', async () => {
      const fetchPage = fakeChannel(300, 100);
      let saved = '0';
      for await (const page of pageForward(fetchPage, saved, 100)) {
        saved = page.cursor;
        break;
      }
      expect(saved).toBe('100');
      const rest: ForwardPage<{ id: string }>[] = await collect(pageForward(fetchPage, saved, 100));
      expect(rest.map((p) => p.cursor)).toEqual(['200', '300']);
    });

    it('passes fetch errors through', async () => {
      const fetchPage = vi.fn(async () => {
        throw new Error('403');
      });
      await expect(collect(pageForward(fetchPage, '0'))).rejects.toThrow('403');
    });
  });
});

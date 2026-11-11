import { describe, it, expect } from 'vitest';
import { afterCursorForDate } from './scheduleCursor';
import { createSchedule, cursorFor, withCursor, withThreads } from './scheduleRecord';
import type { NewScheduleInput } from './scheduleTypes';

const NOW = Date.parse('2026-11-11T10:00:00Z');
const DATE = '2026-01-01T00:00:00Z';

const input = (overrides: Partial<NewScheduleInput> = {}): NewScheduleInput => ({
  name: 'Raid server',
  userId: 'u1',
  scope: { kind: 'guild', guildId: 'g1', guildName: 'Raid' },
  intervalMinutes: 60,
  targets: [
    { id: 'c-full', name: 'general', type: 0, start: { kind: 'full' } },
    { id: 'c-now', name: 'wiped', type: 0, start: { kind: 'now' } },
    { id: 'c-date', name: 'news', type: 0, start: { kind: 'date', date: DATE } },
  ],
  ...overrides,
});

describe('scheduleRecord', () => {
  describe('createSchedule', () => {
    it('sets every target\'s first cursor from its start point', () => {
      const record = createSchedule(input(), 's1', NOW);
      expect(record.cursors).toEqual({
        'c-full': '0',
        'c-now': afterCursorForDate(new Date(NOW)),
        'c-date': afterCursorForDate(new Date(DATE)),
      });
    });

    it('starts running with no runs and no threads', () => {
      const record = createSchedule(input(), 's1', NOW);
      expect(record).toMatchObject({
        version: 1, id: 's1', status: 'running', createdAt: NOW, lastRun: null, runCount: 0, threads: {},
      });
    });

    it('copies the targets so the caller\'s list can change', () => {
      const given = input();
      const record = createSchedule(given, 's1', NOW);
      given.targets[0].name = 'renamed';
      expect(record.targets[0].name).toBe('general');
    });

    it('needs at least one channel', () => {
      expect(() => createSchedule(input({ targets: [] }), 's1', NOW)).toThrow(/at least one/);
    });

    it('rejects a zero or negative interval', () => {
      expect(() => createSchedule(input({ intervalMinutes: 0 }), 's1', NOW)).toThrow(/interval/);
      expect(() => createSchedule(input({ intervalMinutes: -5 }), 's1', NOW)).toThrow(/interval/);
    });

    it('rejects a channel listed twice', () => {
      const t = { id: 'c1', name: 'a', type: 0, start: { kind: 'full' as const } };
      expect(() => createSchedule(input({ targets: [t, t] }), 's1', NOW)).toThrow(/twice/);
    });
  });

  describe('cursorFor', () => {
    const record = createSchedule(input(), 's1', NOW);

    it('returns a saved cursor', () => {
      expect(cursorFor(record, 'c-date')).toBe(afterCursorForDate(new Date(DATE)));
    });

    it('starts a new thread where its parent started', () => {
      expect(cursorFor(record, 't1', 'c-full')).toBe('0');
      expect(cursorFor(record, 't2', 'c-date')).toBe(afterCursorForDate(new Date(DATE)));
    });

    it('starts a "from now on" parent\'s new thread at the schedule\'s creation', () => {
      expect(cursorFor(record, 't3', 'c-now')).toBe(afterCursorForDate(new Date(NOW)));
    });

    it('finds the parent of a known thread', () => {
      const withThread = withThreads(record, [{ id: 't4', name: 'raid night', parentId: 'c-date' }]);
      expect(cursorFor(withThread, 't4')).toBe(afterCursorForDate(new Date(DATE)));
    });

    it('throws for a channel outside the schedule', () => {
      expect(() => cursorFor(record, 'nope')).toThrow(/not part of schedule/);
    });
  });

  describe('withCursor', () => {
    const record = createSchedule(input(), 's1', NOW);

    it('moves a cursor forward without changing the original', () => {
      const next = withCursor(record, 'c-full', '500');
      expect(next.cursors['c-full']).toBe('500');
      expect(record.cursors['c-full']).toBe('0');
    });

    it('never moves a cursor backwards', () => {
      const forward = withCursor(record, 'c-full', '500');
      expect(withCursor(forward, 'c-full', '400')).toBe(forward);
      expect(withCursor(forward, 'c-full', '500')).toBe(forward);
    });

    it('saves a first cursor for a thread', () => {
      expect(withCursor(record, 't1', '42').cursors.t1).toBe('42');
    });
  });

  describe('withThreads', () => {
    const record = createSchedule(input(), 's1', NOW);

    it('adds threads under scheduled channels only', () => {
      const next = withThreads(record, [
        { id: 't1', name: 'a', parentId: 'c-full' },
        { id: 't2', name: 'b', parentId: 'elsewhere' },
      ]);
      expect(Object.keys(next.threads)).toEqual(['t1']);
    });

    it('returns the same record when nothing is new', () => {
      const once = withThreads(record, [{ id: 't1', name: 'a', parentId: 'c-full' }]);
      expect(withThreads(once, [{ id: 't1', name: 'a', parentId: 'c-full' }])).toBe(once);
    });

    it('keeps a renamed thread\'s cursor', () => {
      const once = withCursor(withThreads(record, [{ id: 't1', name: 'a', parentId: 'c-full' }]), 't1', '99');
      const renamed = withThreads(once, [{ id: 't1', name: 'renamed', parentId: 'c-full' }]);
      expect(renamed.threads.t1.name).toBe('renamed');
      expect(renamed.cursors.t1).toBe('99');
    });
  });
});

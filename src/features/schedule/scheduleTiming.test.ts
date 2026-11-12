import { describe, it, expect } from 'vitest';
import { createSchedule } from './scheduleRecord';
import { MAX_JITTER_MS, dueSchedules, maxJitterMs, nextRunTime, retryRunTime, soonestRun } from './scheduleTiming';
import type { ScheduleRecord } from './scheduleTypes';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe('scheduleTiming', () => {
  describe('maxJitterMs', () => {
    it('is a tenth of the interval', () => {
      expect(maxJitterMs(1)).toBe(6000);
      expect(maxJitterMs(30)).toBe(3 * MIN);
    });

    it('never exceeds five minutes', () => {
      expect(maxJitterMs(60)).toBe(MAX_JITTER_MS);
      expect(maxJitterMs(24 * 60)).toBe(MAX_JITTER_MS);
    });
  });

  describe('nextRunTime', () => {
    const started = 1_000_000;

    it('spaces runs start to start', () => {
      expect(nextRunTime(60, started, started + 2 * MIN, false, () => 0)).toBe(started + HOUR);
    });

    it('adds the random offset', () => {
      expect(nextRunTime(60, started, started, false, () => 0.5)).toBe(started + HOUR + MAX_JITTER_MS / 2);
    });

    it('stays inside the offset window', () => {
      const latest = nextRunTime(60, started, started, false, () => 0.999999);
      expect(latest).toBeLessThan(started + HOUR + MAX_JITTER_MS);
    });

    it('runs again at once after a run that left a backlog', () => {
      expect(nextRunTime(60, started, started + 5 * MIN, true)).toBe(started + 5 * MIN);
    });

    it('is never in the past after a run longer than the interval', () => {
      const now = started + 90 * MIN;
      expect(nextRunTime(60, started, now, false, () => 0)).toBe(now);
    });
  });

  it('retries a failed run one interval later', () => {
    expect(retryRunTime(60, 5)).toBe(5 + HOUR);
  });

  describe('dueSchedules and soonestRun', () => {
    const make = (id: string, nextRunAt: number, extra: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
      ...createSchedule(
        {
          name: id,
          userId: 'u1',
          scope: { kind: 'dms' },
          intervalMinutes: 60,
          targets: [{ id: 'dm', name: 'dm', type: 1, start: { kind: 'full' } }],
        },
        id,
        0,
      ),
      nextRunAt,
      ...extra,
    });

    const records = [
      make('later', 300),
      make('overdue', 50),
      make('due', 100),
      make('stopped', 10, { status: 'stopped' }),
      make('other-user', 10, { userId: 'u2' }),
    ];

    it('picks this account\'s running, due schedules, most overdue first', () => {
      expect(dueSchedules(records, 'u1', 100).map((r) => r.id)).toEqual(['overdue', 'due']);
    });

    it('finds the soonest running schedule of this account', () => {
      expect(soonestRun(records, 'u1')).toBe(50);
      expect(soonestRun(records, 'nobody')).toBeNull();
    });
  });
});

import type { ScheduleRecord } from './scheduleTypes';

/**
 * When scheduled runs happen. Runs are spaced start to start, so a run that
 * takes a few minutes does not push every later run back. Each run lands a
 * random offset after the interval, up to a tenth of it and never more than
 * five minutes, so runs do not fire on the same second every hour.
 */

export const MAX_JITTER_MS = 5 * 60 * 1000;

/** The longest random offset for an interval. */
export const maxJitterMs = (intervalMinutes: number): number =>
  Math.min(MAX_JITTER_MS, intervalMinutes * 60 * 1000 * 0.1);

/**
 * The next run after one that started at `startedAt`. A run that left a
 * backlog goes again at `now`. A run that took longer than the interval
 * makes the next one due at once, never in the past.
 */
export function nextRunTime(
  intervalMinutes: number,
  startedAt: number,
  now: number,
  more: boolean,
  random: () => number = Math.random,
): number {
  if (more) return now;
  const due = startedAt + intervalMinutes * 60 * 1000 + Math.floor(random() * maxJitterMs(intervalMinutes));
  return Math.max(due, now);
}

/** After a run that failed outright (the zip could not be written): try again one interval later. */
export const retryRunTime = (intervalMinutes: number, now: number): number => now + intervalMinutes * 60 * 1000;

/** Schedules of this account that are running and due, the most overdue first. */
export function dueSchedules(records: readonly ScheduleRecord[], userId: string, now: number): ScheduleRecord[] {
  return records
    .filter((r) => r.status === 'running' && r.userId === userId && r.nextRunAt <= now)
    .sort((a, b) => a.nextRunAt - b.nextRunAt);
}

/** When the soonest running schedule of this account is due, or null. */
export function soonestRun(records: readonly ScheduleRecord[], userId: string): number | null {
  let soonest: number | null = null;
  for (const r of records) {
    if (r.status !== 'running' || r.userId !== userId) continue;
    if (soonest === null || r.nextRunAt < soonest) soonest = r.nextRunAt;
  }
  return soonest;
}

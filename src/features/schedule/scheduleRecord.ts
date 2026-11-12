import { compareSnowflakes, initialCursor } from './scheduleCursor';
import type { NewScheduleInput, ScheduleRecord, ScheduleThread } from './scheduleTypes';

/**
 * Pure helpers for schedule records. Every helper returns a new record and
 * leaves the one it was given alone, so a caller can hand them to
 * `updateSchedule` without copying first.
 */

/** A new schedule, running, with every target's first cursor set. */
export function createSchedule(input: NewScheduleInput, id: string, now: number): ScheduleRecord {
  if (input.targets.length === 0) throw new Error('A schedule needs at least one channel');
  if (!(input.intervalMinutes > 0)) throw new Error(`Invalid interval: ${input.intervalMinutes}`);
  const ids = new Set<string>();
  for (const target of input.targets) {
    if (ids.has(target.id)) throw new Error(`Channel ${target.id} is listed twice`);
    ids.add(target.id);
  }
  const startedAt = new Date(now);
  const cursors: Record<string, string> = {};
  for (const target of input.targets) cursors[target.id] = initialCursor(target.start, startedAt);
  return {
    version: 1,
    id,
    name: input.name,
    userId: input.userId,
    scope: input.scope,
    intervalMinutes: input.intervalMinutes,
    targets: input.targets.map((t) => ({ ...t })),
    threads: {},
    threadsBackfilled: input.targets.filter((t) => t.start.kind === 'now').map((t) => t.id),
    cursors,
    status: 'running',
    createdAt: now,
    nextRunAt: now,
    lastRun: null,
    runCount: 0,
  };
}

/**
 * The cursor for a channel or thread. A thread seen for the first time
 * starts where its parent channel started: a "from now on" parent's threads
 * start at the schedule's creation, the others at the parent's start point.
 */
export function cursorFor(record: ScheduleRecord, channelId: string, parentId?: string): string {
  const saved = record.cursors[channelId];
  if (saved !== undefined) return saved;
  const parent = record.targets.find((t) => t.id === (parentId ?? record.threads[channelId]?.parentId));
  if (!parent) throw new Error(`Channel ${channelId} is not part of schedule ${record.id}`);
  return initialCursor(parent.start, new Date(record.createdAt));
}

/** Saves a cursor. A cursor never moves backwards. */
export function withCursor(record: ScheduleRecord, channelId: string, cursor: string): ScheduleRecord {
  const saved = record.cursors[channelId];
  if (saved !== undefined && compareSnowflakes(cursor, saved) <= 0) return record;
  return { ...record, cursors: { ...record.cursors, [channelId]: cursor } };
}

const newer = (a: string | undefined, b: string | undefined): string | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return compareSnowflakes(a, b) >= 0 ? a : b;
};

/**
 * Adds threads found under scheduled channels and updates known ones. A
 * thread keeps its cursor, and its last message id only moves forward.
 */
export function withThreads(record: ScheduleRecord, threads: readonly ScheduleThread[]): ScheduleRecord {
  const targetIds = new Set(record.targets.map((t) => t.id));
  const next = { ...record.threads };
  let changed = false;
  for (const thread of threads) {
    if (!targetIds.has(thread.parentId)) continue;
    const known = next[thread.id];
    const lastMessageId = newer(known?.lastMessageId, thread.lastMessageId);
    if (known && known.name === thread.name && known.parentId === thread.parentId && known.lastMessageId === lastMessageId) {
      continue;
    }
    next[thread.id] = { id: thread.id, name: thread.name, parentId: thread.parentId, ...(lastMessageId ? { lastMessageId } : {}) };
    changed = true;
  }
  return changed ? { ...record, threads: next } : record;
}

/** Marks targets whose archived threads have now all been listed. */
export function withThreadsBackfilled(record: ScheduleRecord, targetIds: readonly string[]): ScheduleRecord {
  const done = new Set(record.threadsBackfilled);
  const added = targetIds.filter((id) => !done.has(id));
  return added.length === 0 ? record : { ...record, threadsBackfilled: [...record.threadsBackfilled, ...added] };
}

/** True when the thread may have messages after its cursor. */
export function threadHasNew(record: ScheduleRecord, threadId: string): boolean {
  const thread = record.threads[threadId];
  if (!thread) return false;
  if (!thread.lastMessageId) return true;
  return compareSnowflakes(thread.lastMessageId, cursorFor(record, threadId)) > 0;
}

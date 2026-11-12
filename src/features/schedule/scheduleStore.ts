import { storage } from '@/extension/storage';
import type { ScheduleRecord } from './scheduleTypes';

/**
 * Schedules persist in the `schedules` IndexedDB store, one record per
 * schedule, keyed by id. Reset Discrub Data clears the store along with the
 * others; sign out clears it through `clearSchedules`.
 */

// Writes to one schedule run one after another, so a Stop from the UI and a
// cursor save from a run in this window cannot overwrite each other.
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(id, next);
  void next.finally(() => {
    if (queues.get(id) === next) queues.delete(id);
  }).catch(() => undefined);
  return next;
}

export function getSchedule(id: string): Promise<ScheduleRecord | null> {
  return storage.schedules.get<ScheduleRecord>(id);
}

/** Every schedule, oldest first. */
export async function listSchedules(): Promise<ScheduleRecord[]> {
  const entries = await storage.schedules.entries<ScheduleRecord>();
  return entries.map(([, record]) => record).sort((a, b) => a.createdAt - b.createdAt);
}

export function saveSchedule(record: ScheduleRecord): Promise<void> {
  return serialize(record.id, () => storage.schedules.set(record.id, record));
}

/**
 * Reads, changes and writes one schedule in turn with any other write to
 * it. Returns the saved record, or null when the schedule is gone (deleted
 * while a run was going), in which case nothing is written.
 */
export function updateSchedule(
  id: string,
  change: (record: ScheduleRecord) => ScheduleRecord,
): Promise<ScheduleRecord | null> {
  return serialize(id, async () => {
    const current = await storage.schedules.get<ScheduleRecord>(id);
    if (!current) return null;
    const next = change(current);
    if (next !== current) await storage.schedules.set(id, next);
    return next;
  });
}

export function deleteSchedule(id: string): Promise<void> {
  return serialize(id, () => storage.schedules.remove(id));
}

/**
 * Drops every schedule. Used on sign out, so it never throws: a storage
 * problem comes back as a rejected promise for the caller to log.
 */
export async function clearSchedules(): Promise<void> {
  await storage.schedules.clear();
}

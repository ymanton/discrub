import { PAGE_SIZE, compareSnowflakes, pageForward } from './scheduleCursor';
import {
  MANIFEST_FORMAT,
  RunOutput,
  channelFolder,
  runZipName,
  threadFolder,
  type ManifestChannel,
  type ManifestSkip,
  type RunSink,
} from './scheduleOutput';
import { cursorFor, threadHasNew, withCursor, withThreads, withThreadsBackfilled } from './scheduleRecord';
import type { ScheduleRecord, ScheduleRunSummary, ScheduleTarget, ScheduleThread } from './scheduleTypes';

/**
 * One scheduled run: every target's new messages, then the new messages of
 * their threads, into one zip. Discord, the zip and the run controls come in
 * through `RunDeps`, so the run itself has no store or network code.
 *
 * Budgets keep one long backlog (a full-history baseline) from holding up
 * the rest: a channel or thread gets at most `pagesPerChannel` pages per run
 * and the run at most `pagesPerRun`. Targets go first, so every channel is
 * checked each run, then threads, most recently active first. A run that
 * leaves a backlog returns `more`, and the scheduler starts the next run
 * straight away.
 *
 * Nothing is saved here. The run returns its changes once the zip is
 * complete, and the caller applies them with `applyRunResult`. A run whose
 * zip fails throws, and the next run fetches the same messages again.
 */

/** Channel types that can have threads: text, announcement, forum, media. */
export const THREAD_PARENT_TYPES: readonly number[] = [0, 5, 15, 16];
/** Forum and media channels: posts are threads, the parent has no messages of its own. */
export const FORUM_TYPES: readonly number[] = [15, 16];

export const PAGES_PER_CHANNEL = 20;
export const PAGES_PER_RUN = 500;

/** Discord answered 401: the sign in expired. The run stops. */
export class SignInExpired extends Error {
  constructor() {
    super('Sign in expired');
    this.name = 'SignInExpired';
  }
}

/** A request failed after its retries. The channel is skipped this run. */
export class ApiFailure extends Error {
  /** HTTP status, or `network`. */
  readonly reason: string;
  constructor(reason: string) {
    super(`Request failed (${reason})`);
    this.name = 'ApiFailure';
    this.reason = reason;
  }
}

class Stopped extends Error {}

export type RunEvent =
  | { type: 'channel'; name: string; kind: 'channel' | 'thread'; messages: number }
  | { type: 'skipped'; name: string; reason: string }
  | { type: 'backlog' };

export interface RunDeps<M extends { id: string }> {
  now(): number;
  /** One page of `channelId`'s messages after `after`, in any order. `name` is for the log. */
  listMessages(channelId: string, after: string, name: string): Promise<M[]>;
  /** Active threads in a server. `name` is for the log. */
  listActiveThreads(guildId: string, name: string): Promise<ScheduleThread[]>;
  /** A target's archived threads: all of them, or only the most recent page. */
  listArchivedThreads(target: ScheduleTarget, all: boolean): Promise<ScheduleThread[]>;
  openSink(zipName: string): RunSink;
  /** Why the run must stop now, or null to go on. */
  stopReason(): 'cancelled' | 'rateLimited' | null;
  waitWhilePaused(): Promise<void>;
  onEvent?(event: RunEvent): void;
  pagesPerChannel?: number;
  pagesPerRun?: number;
  messagesPerFile?: number;
}

/** What a run changed, applied to the stored record afterwards. */
export interface RunChanges {
  cursors: Record<string, string>;
  threads: ScheduleThread[];
  backfilled: string[];
}

export interface RunResult {
  changes: RunChanges;
  summary: ScheduleRunSummary;
  /** A backlog is left; run again straight away. */
  more: boolean;
  /** A zip was downloaded (false when nothing was new). */
  downloaded: boolean;
}

const errorReason = (error: unknown): string =>
  error instanceof ApiFailure ? error.reason : error instanceof Error ? error.message : String(error);

export async function runSchedule<M extends { id: string }>(
  record: ScheduleRecord,
  deps: RunDeps<M>,
): Promise<RunResult> {
  const pagesPerChannel = deps.pagesPerChannel ?? PAGES_PER_CHANNEL;
  const pagesPerRun = deps.pagesPerRun ?? PAGES_PER_RUN;
  const startedAt = deps.now();
  const output = new RunOutput(() => deps.openSink(runZipName(record.name, startedAt)), deps.messagesPerFile);

  let work = record;
  const channels: ManifestChannel[] = [];
  const skipped: ManifestSkip[] = [];
  const backfilled: string[] = [];
  let pagesUsed = 0;
  let more = false;
  let stopped = false;
  let stoppedBy: ScheduleRunSummary['stoppedBy'];

  const checkStop = (): boolean => {
    if (stopped) return true;
    const reason = deps.stopReason();
    if (reason) {
      stopped = true;
      if (reason === 'rateLimited') stoppedBy = 'rateLimited';
    }
    return stopped;
  };

  const fail = (id: string, name: string, error: unknown): void => {
    if (error instanceof Stopped) return;
    if (error instanceof SignInExpired) {
      stopped = true;
      stoppedBy = 'signInExpired';
      return;
    }
    // A request that failed because the run was stopping (a cancel during a
    // retry wait, a rate-limit stop) is the stop, not a skip.
    if (checkStop()) return;
    const reason = errorReason(error);
    skipped.push({ id, name, reason });
    deps.onEvent?.({ type: 'skipped', name, reason });
  };

  /** Walks one channel or thread forward. Returns true when it reached the end. */
  const walk = async (entry: Omit<ManifestChannel, 'files' | 'messages' | 'through'>): Promise<boolean> => {
    const writer = output.channel<M>(entry);
    let pages = 0;
    let reachedEnd = false;
    try {
      const fetchPage = async (after: string): Promise<M[]> => {
        await deps.waitWhilePaused();
        if (checkStop()) throw new Stopped();
        return deps.listMessages(entry.id, after, entry.name);
      };
      reachedEnd = true;
      for await (const page of pageForward(fetchPage, entry.after)) {
        await writer.add(page.messages);
        pages += 1;
        pagesUsed += 1;
        if (pages >= pagesPerChannel || pagesUsed >= pagesPerRun) {
          if (page.messages.length >= PAGE_SIZE) {
            reachedEnd = false;
            more = true;
          }
          break;
        }
      }
    } catch (error) {
      reachedEnd = false;
      fail(entry.id, entry.name, error);
    } finally {
      const done = await writer.close();
      if (done) {
        channels.push(done);
        deps.onEvent?.({ type: 'channel', name: entry.name, kind: entry.kind, messages: done.messages });
      }
      work = withCursor(work, entry.id, writer.through);
    }
    return reachedEnd;
  };

  const folders = new Map<string, string>();
  for (const target of record.targets) folders.set(target.id, channelFolder(target.name, target.id));

  // Targets first, so every channel is checked each run.
  for (const target of record.targets) {
    if (checkStop()) break;
    if (FORUM_TYPES.includes(target.type)) continue;
    if (pagesUsed >= pagesPerRun) {
      more = true;
      break;
    }
    await walk({
      id: target.id,
      name: target.name,
      kind: 'channel',
      type: target.type,
      folder: folders.get(target.id)!,
      after: cursorFor(work, target.id),
    });
  }

  // Then threads, in a server schedule.
  if (record.scope.kind === 'guild' && !checkStop()) {
    const parents = record.targets.filter((t) => THREAD_PARENT_TYPES.includes(t.type));
    if (parents.length > 0) {
      const found: ScheduleThread[] = [];
      try {
        found.push(...await deps.listActiveThreads(record.scope.guildId, record.scope.guildName));
      } catch (error) {
        fail(record.scope.guildId, record.scope.guildName, error);
      }
      for (const target of parents) {
        if (checkStop()) break;
        const all = !work.threadsBackfilled.includes(target.id);
        try {
          found.push(...await deps.listArchivedThreads(target, all));
          if (all) backfilled.push(target.id);
        } catch (error) {
          fail(target.id, target.name, error);
        }
      }
      work = withThreadsBackfilled(withThreads(work, found), backfilled);

      const parentIds = new Set(parents.map((t) => t.id));
      const pending = Object.values(work.threads)
        .filter((t) => parentIds.has(t.parentId) && threadHasNew(work, t.id))
        .sort((a, b) => {
          if (!a.lastMessageId) return 1;
          if (!b.lastMessageId) return -1;
          return compareSnowflakes(b.lastMessageId, a.lastMessageId);
        });
      for (const thread of pending) {
        if (checkStop()) break;
        if (pagesUsed >= pagesPerRun) {
          more = true;
          break;
        }
        const reachedEnd = await walk({
          id: thread.id,
          name: thread.name,
          kind: 'thread',
          parentId: thread.parentId,
          folder: threadFolder(folders.get(thread.parentId)!, thread.name, thread.id),
          after: cursorFor(work, thread.id),
        });
        // Caught up: the thread is not fetched again until a listing shows a
        // newer message. Nothing up to the listed last message exists past the
        // cursor (the walk saw everything up to now), so the cursor can move
        // there. Without this a thread whose last message was deleted, as a
        // wipe does, would be fetched every run for good.
        if (reachedEnd) {
          const listed = work.threads[thread.id]?.lastMessageId;
          if (listed) work = withCursor(work, thread.id, listed);
          else work = withThreads(work, [{ ...thread, lastMessageId: work.cursors[thread.id] }]);
        }
      }
    }
  }

  if (more) deps.onEvent?.({ type: 'backlog' });

  const finishedAt = deps.now();
  const summary: ScheduleRunSummary = {
    startedAt,
    finishedAt,
    messages: channels.reduce((sum, c) => sum + c.messages, 0),
    skipped: skipped.map((s) => s.id),
    ...(stoppedBy ? { stoppedBy } : {}),
  };

  let downloaded: boolean;
  try {
    downloaded = await output.finalize({
      format: MANIFEST_FORMAT,
      version: 1,
      schedule: { id: record.id, name: record.name, scope: record.scope },
      run: {
        number: record.runCount + 1,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        more: more && !stoppedBy,
        ...(stoppedBy ? { stoppedBy } : {}),
      },
      channels,
      skipped,
    });
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw error;
  }

  const cursors: Record<string, string> = {};
  for (const [id, cursor] of Object.entries(work.cursors)) {
    if (record.cursors[id] !== cursor) cursors[id] = cursor;
  }
  const threads = Object.values(work.threads).filter((t) => {
    const before = record.threads[t.id];
    return !before || before.name !== t.name || before.parentId !== t.parentId || before.lastMessageId !== t.lastMessageId;
  });

  return {
    changes: { cursors, threads, backfilled },
    summary,
    more: more && !stoppedBy,
    downloaded,
  };
}

/**
 * Applies a finished run to the stored record, which may have changed while
 * the run went (a Stop). Cursors only move forward, and a run that stopped
 * for a sign in or rate limit stops the schedule.
 */
export function applyRunResult(current: ScheduleRecord, result: RunResult): ScheduleRecord {
  let next = withThreads(current, result.changes.threads);
  for (const [id, cursor] of Object.entries(result.changes.cursors)) next = withCursor(next, id, cursor);
  next = withThreadsBackfilled(next, result.changes.backfilled);
  return {
    ...next,
    lastRun: result.summary,
    runCount: current.runCount + 1,
    status: result.summary.stoppedBy ? 'stopped' : current.status,
  };
}

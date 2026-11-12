import { dueSchedules } from './scheduleTiming';
import type { ScheduleRecord } from './scheduleTypes';

/**
 * The scheduler: a loop that checks every `tickMs` for a due schedule and
 * runs it. It waits while signed out and while any other operation runs,
 * because Discrub's pause and cancel flags are shared by every operation.
 * After a run it checks again at once, so a run that left a backlog is
 * followed straight away by the next.
 *
 * Only one window runs schedules: the loop holds the `discrub-scheduler`
 * Web Lock while it is going. A second window waits for the lock and takes
 * over when the first closes. Browsers without the Locks API run the loop
 * in every window (Discrub assumes one window there, as workspaces do).
 */

export const SCHEDULER_LOCK = 'discrub-scheduler';
export const TICK_MS = 15_000;

export interface LoopDeps {
  sleep(ms: number): Promise<void>;
  now(): number;
  listSchedules(): Promise<ScheduleRecord[]>;
  /** Signed-in account, or null while signed out. */
  userId(): string | null;
  /** Another operation, or a scheduled run, is going. */
  isBusy(): boolean;
  /** Runs one schedule; resolves 'notRun' when it did not run. */
  run(id: string): Promise<string>;
  onError?(error: unknown): void;
  tickMs?: number;
}

export interface LoopHandle {
  stop(): void;
  /** Settles when the loop has ended. */
  done: Promise<void>;
}

/** One check: runs the most overdue schedule. Returns true when a run happened. */
export async function checkOnce(deps: LoopDeps): Promise<boolean> {
  const userId = deps.userId();
  if (!userId || deps.isBusy()) return false;
  const [due] = dueSchedules(await deps.listSchedules(), userId, deps.now());
  if (!due) return false;
  return (await deps.run(due.id)) !== 'notRun';
}

function locksApi(): LockManager | null {
  if (typeof navigator === 'undefined') return null;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/** Starts the loop. It runs only while this window holds the scheduler lock. */
export function startScheduleLoop(deps: LoopDeps, locks: LockManager | null = locksApi()): LoopHandle {
  const tickMs = deps.tickMs ?? TICK_MS;
  let stopped = false;
  const abort = new AbortController();

  const loop = async (): Promise<void> => {
    while (!stopped) {
      let ran = false;
      try {
        ran = await checkOnce(deps);
      } catch (error) {
        deps.onError?.(error);
      }
      if (!ran && !stopped) await deps.sleep(tickMs);
    }
  };

  let done: Promise<void>;
  if (!locks) {
    done = loop();
  } else {
    done = locks
      .request(SCHEDULER_LOCK, { mode: 'exclusive', signal: abort.signal }, () => loop())
      .then(() => undefined)
      .catch((error: unknown) => {
        // Stopped while waiting for another window's lock.
        if (error instanceof DOMException && error.name === 'AbortError') return;
        deps.onError?.(error);
      });
  }

  return {
    stop: () => {
      stopped = true;
      abort.abort();
    },
    done,
  };
}

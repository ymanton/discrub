import { describe, it, expect, vi } from 'vitest';
import { createSchedule } from './scheduleRecord';
import { SCHEDULER_LOCK, checkOnce, startScheduleLoop, type LoopDeps } from './scheduleLoop';
import type { ScheduleRecord } from './scheduleTypes';

const make = (id: string, nextRunAt: number, userId = 'u1'): ScheduleRecord => ({
  ...createSchedule(
    {
      name: id,
      userId,
      scope: { kind: 'dms' },
      intervalMinutes: 60,
      targets: [{ id: 'dm', name: 'dm', type: 1, start: { kind: 'full' } }],
    },
    id,
    0,
  ),
  nextRunAt,
});

const deps = (overrides: Partial<LoopDeps> = {}): LoopDeps => ({
  sleep: vi.fn(async () => undefined),
  now: () => 100,
  listSchedules: async () => [make('later', 500), make('due', 50), make('overdue', 10)],
  userId: () => 'u1',
  isBusy: () => false,
  run: vi.fn(async () => 'saved'),
  ...overrides,
});

describe('checkOnce', () => {
  it('runs the most overdue schedule', async () => {
    const d = deps();
    expect(await checkOnce(d)).toBe(true);
    expect(d.run).toHaveBeenCalledWith('overdue');
  });

  it('waits while signed out', async () => {
    const d = deps({ userId: () => null });
    expect(await checkOnce(d)).toBe(false);
    expect(d.run).not.toHaveBeenCalled();
  });

  it('waits while another operation runs', async () => {
    const d = deps({ isBusy: () => true });
    expect(await checkOnce(d)).toBe(false);
    expect(d.run).not.toHaveBeenCalled();
  });

  it('does nothing when no schedule is due', async () => {
    const d = deps({ listSchedules: async () => [make('later', 500)] });
    expect(await checkOnce(d)).toBe(false);
  });

  it('reports no run when the run declined', async () => {
    expect(await checkOnce(deps({ run: async () => 'notRun' }))).toBe(false);
  });
});

describe('startScheduleLoop', () => {
  it('sleeps a tick between checks with nothing due, and stops', async () => {
    let handle: ReturnType<typeof startScheduleLoop> | null = null;
    let sleeps = 0;
    const d = deps({
      listSchedules: async () => [],
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 3) handle!.stop();
      },
      tickMs: 1234,
    });
    handle = startScheduleLoop(d, null);
    await handle.done;
    expect(sleeps).toBe(3);
  });

  it('checks again without sleeping after a run', async () => {
    let handle: ReturnType<typeof startScheduleLoop> | null = null;
    const order: string[] = [];
    let runs = 0;
    const d = deps({
      run: async (id) => {
        order.push(`run ${id}`);
        runs += 1;
        if (runs === 2) handle!.stop();
        return 'saved';
      },
      sleep: async () => {
        order.push('sleep');
      },
    });
    handle = startScheduleLoop(d, null);
    await handle.done;
    expect(order).toEqual(['run overdue', 'run overdue']);
  });

  it('keeps going after an error', async () => {
    let handle: ReturnType<typeof startScheduleLoop> | null = null;
    const onError = vi.fn();
    let calls = 0;
    const d = deps({
      listSchedules: async () => {
        calls += 1;
        if (calls === 1) throw new Error('idb');
        handle!.stop();
        return [];
      },
      onError,
    });
    handle = startScheduleLoop(d, null);
    await handle.done;
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(calls).toBe(2);
  });

  it('runs inside the scheduler lock', async () => {
    let handle: ReturnType<typeof startScheduleLoop> | null = null;
    const request = vi.fn((_name: string, _opts: LockOptions, cb: () => Promise<void>) => cb());
    const d = deps({ listSchedules: async () => [], sleep: async () => handle!.stop() });
    handle = startScheduleLoop(d, { request } as unknown as LockManager);
    await handle.done;
    expect(request).toHaveBeenCalledWith(SCHEDULER_LOCK, expect.objectContaining({ mode: 'exclusive' }), expect.any(Function));
  });

  it('gives up waiting for another window\'s lock when stopped', async () => {
    const request = vi.fn((_name: string, opts: LockOptions) =>
      new Promise((_resolve, reject) => {
        opts.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
    const onError = vi.fn();
    const d = deps({ onError });
    const handle = startScheduleLoop(d, { request } as unknown as LockManager);
    handle.stop();
    await handle.done;
    expect(d.run).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import type { AppDispatch, RootState } from '@/app/store';
import type { RunResult } from './scheduleRun';

const mockRunSchedule = vi.fn<[], Promise<RunResult>>();

vi.mock('./scheduleRun', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scheduleRun')>();
  return { ...actual, runSchedule: () => mockRunSchedule() };
});
vi.mock('./scheduleDeps', () => ({ createRunDeps: () => ({}) }));
const mockShowNotification = vi.fn(async () => undefined);
vi.mock('./scheduleNotify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scheduleNotify')>();
  return { ...actual, showNotification: (...args: unknown[]) => mockShowNotification(...(args as [])) };
});

import authReducer from '@features/auth/authSlice';
import userReducer from '@features/user/userSlice';
import appReducer from '@features/app/appSlice';
import statusReducer from '@features/status/statusSlice';
import scheduleReducer, {
  addSchedule,
  removeSchedule,
  resumeSchedule,
  runScheduledExport,
  scheduleRunStarted,
  selectActiveScheduleRun,
  selectSchedules,
  stopSchedule,
} from './scheduleSlice';
import { clearSchedules, getSchedule } from './scheduleStore';
import type { NewScheduleInput } from './scheduleTypes';

const input: NewScheduleInput = {
  name: 'Friends',
  userId: 'u1',
  scope: { kind: 'dms' },
  intervalMinutes: 60,
  targets: [{ id: 'dm1', name: 'Alice', type: 1, start: { kind: 'full' } }],
};

const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  changes: { cursors: { dm1: '42' }, threads: [], backfilled: [] },
  summary: { startedAt: Date.now(), finishedAt: Date.now(), messages: 3, skipped: [] },
  more: false,
  downloaded: true,
  ...overrides,
});

/** Only the reducers the thunks touch; `dispatch` is typed as the app's so the thunks fit. */
const makeStore = (signedIn = true) => {
  const store = configureStore({
    reducer: { auth: authReducer, user: userReducer, app: appReducer, status: statusReducer, schedule: scheduleReducer },
    preloadedState: signedIn
      ? ({
        auth: { ...authReducer(undefined, { type: '@@init' }), token: 't', isAuthenticated: true },
        user: { ...userReducer(undefined, { type: '@@init' }), currentUser: { id: 'u1', username: 'me' } },
      } as never)
      : undefined,
  });
  return store as Omit<typeof store, 'dispatch'> & { dispatch: AppDispatch };
};

type Store = ReturnType<typeof makeStore>;
const messages = (store: Store) => (store.getState() as unknown as RootState).status.entries.map((e) => e.message);

describe('scheduleSlice', () => {
  beforeEach(async () => {
    await clearSchedules();
    mockRunSchedule.mockReset();
    mockShowNotification.mockClear();
  });

  it('adds a schedule that is due at once and lists it', async () => {
    const store = makeStore();
    const record = await store.dispatch(addSchedule(input)).unwrap();
    expect(record.nextRunAt).toBeLessThanOrEqual(Date.now());
    expect(selectSchedules(store.getState() as unknown as RootState).map((s) => s.id)).toEqual([record.id]);
  });

  it('stops, resumes and removes a schedule', async () => {
    const store = makeStore();
    const { id } = await store.dispatch(addSchedule(input)).unwrap();
    await store.dispatch(stopSchedule({ id }));
    expect((await getSchedule(id))?.status).toBe('stopped');
    await store.dispatch(resumeSchedule({ id }));
    expect((await getSchedule(id))?.status).toBe('running');
    await store.dispatch(removeSchedule({ id }));
    expect(await getSchedule(id)).toBeNull();
    expect(selectSchedules(store.getState() as unknown as RootState)).toEqual([]);
  });

  it('cancels the run that is going when its schedule is stopped', async () => {
    const store = makeStore();
    const { id } = await store.dispatch(addSchedule(input)).unwrap();
    store.dispatch(scheduleRunStarted({ id, name: 'Friends', startedAt: 0 }));
    await store.dispatch(stopSchedule({ id }));
    expect((store.getState() as unknown as RootState).app.discrubCancelled).toBe(true);
  });

  describe('runScheduledExport', () => {
    it('runs, saves the cursors and the next run, and logs the saved file', async () => {
      const store = makeStore();
      const { id } = await store.dispatch(addSchedule(input)).unwrap();
      mockRunSchedule.mockImplementation(async () => {
        expect(selectActiveScheduleRun(store.getState() as unknown as RootState)?.id).toBe(id);
        return result();
      });

      expect(await store.dispatch(runScheduledExport({ id })).unwrap()).toBe('saved');
      const saved = await getSchedule(id);
      expect(saved?.cursors.dm1).toBe('42');
      expect(saved?.runCount).toBe(1);
      expect(saved?.nextRunAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
      expect(selectActiveScheduleRun(store.getState() as unknown as RootState)).toBeNull();
      expect(messages(store).some((m) => m.includes('3') && m.includes('.zip'))).toBe(true);
    });

    it('is due again at once after a run that left a backlog', async () => {
      const store = makeStore();
      const { id } = await store.dispatch(addSchedule(input)).unwrap();
      mockRunSchedule.mockResolvedValue(result({ more: true }));
      await store.dispatch(runScheduledExport({ id }));
      expect((await getSchedule(id))!.nextRunAt).toBeLessThanOrEqual(Date.now());
    });

    it('reports nothing new without a file', async () => {
      const store = makeStore();
      const { id } = await store.dispatch(addSchedule(input)).unwrap();
      mockRunSchedule.mockResolvedValue(result({ downloaded: false, summary: { startedAt: 1, finishedAt: 2, messages: 0, skipped: [] } }));
      expect(await store.dispatch(runScheduledExport({ id })).unwrap()).toBe('nothingNew');
    });

    it('stops the schedule when the sign in expired', async () => {
      const store = makeStore();
      const { id } = await store.dispatch(addSchedule(input)).unwrap();
      mockRunSchedule.mockResolvedValue(result({
        downloaded: false,
        summary: { startedAt: 1, finishedAt: 2, messages: 0, skipped: [], stoppedBy: 'signInExpired' },
      }));
      expect(await store.dispatch(runScheduledExport({ id })).unwrap()).toBe('stopped');
      expect((await getSchedule(id))?.status).toBe('stopped');
      expect(mockShowNotification).toHaveBeenCalledWith(
        'Discrub scheduled export: Friends',
        expect.stringContaining('sign in expired'),
      );
    });

    it('notifies about a skipped channel', async () => {
      const store = makeStore();
      const { id } = await store.dispatch(addSchedule(input)).unwrap();
      mockRunSchedule.mockResolvedValue(result({ summary: { startedAt: 1, finishedAt: 2, messages: 0, skipped: ['dm1'] } }));
      await store.dispatch(runScheduledExport({ id }));
      expect(mockShowNotification).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Alice'));
    });

    it('does not notify about a clean run', async () => {
      const store = makeStore();
      const { id } = await store.dispatch(addSchedule(input)).unwrap();
      mockRunSchedule.mockResolvedValue(result());
      await store.dispatch(runScheduledExport({ id }));
      expect(mockShowNotification).not.toHaveBeenCalled();
    });

    it('tries again one interval later when the zip fails, keeping the cursors', async () => {
      const store = makeStore();
      const { id } = await store.dispatch(addSchedule(input)).unwrap();
      mockRunSchedule.mockRejectedValue(new Error('download failed'));
      expect(await store.dispatch(runScheduledExport({ id })).unwrap()).toBe('failed');
      const saved = await getSchedule(id);
      expect(saved?.cursors.dm1).toBe('0');
      expect(saved?.nextRunAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
      expect(selectActiveScheduleRun(store.getState() as unknown as RootState)).toBeNull();
      expect(messages(store).some((m) => m.includes('download failed'))).toBe(true);
      expect(mockShowNotification).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('download failed'));
    });

    it('does not run when signed out', async () => {
      const { id } = await makeStore().dispatch(addSchedule(input)).unwrap();
      expect(await makeStore(false).dispatch(runScheduledExport({ id })).unwrap()).toBe('notRun');
      expect(mockRunSchedule).not.toHaveBeenCalled();
    });

    it('never runs another account\'s schedule', async () => {
      const store = makeStore();
      const { id } = await store.dispatch(addSchedule({ ...input, userId: 'someone-else' })).unwrap();
      expect(await store.dispatch(runScheduledExport({ id })).unwrap()).toBe('notRun');
      expect(mockRunSchedule).not.toHaveBeenCalled();
    });

    it('does not run a stopped schedule', async () => {
      const store = makeStore();
      const { id } = await store.dispatch(addSchedule(input)).unwrap();
      await store.dispatch(stopSchedule({ id }));
      expect(await store.dispatch(runScheduledExport({ id })).unwrap()).toBe('notRun');
    });
  });
});

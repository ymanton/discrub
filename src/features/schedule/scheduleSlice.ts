import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '@/app/store';
import { selectAuthToken } from '@features/auth/authSlice';
import { selectCurrentUser } from '@features/user/userSlice';
import { setDiscrubCancelled, setDiscrubPaused } from '@features/app/appSlice';
import { addStatusEntry } from '@features/status/statusSlice';
import type { ExportDispatch } from '@features/export/exportSlice';
import { t } from '@/i18n';
import { createSchedule } from './scheduleRecord';
import { applyRunResult, runSchedule } from './scheduleRun';
import { createRunDeps } from './scheduleDeps';
import { runZipName } from './scheduleOutput';
import { nextRunTime, retryRunTime } from './scheduleTiming';
import { deleteSchedule, getSchedule, listSchedules, saveSchedule, updateSchedule } from './scheduleStore';
import { alertsForRun, showNotification, type ScheduleAlert } from './scheduleNotify';
import type { NewScheduleInput, ScheduleRecord } from './scheduleTypes';

/**
 * Scheduled exports in the store: the list for the UI and the run that is
 * going. The records themselves live in IndexedDB (scheduleStore); the list
 * here is a copy, refreshed after every change.
 */

export interface ActiveScheduleRun {
  id: string;
  name: string;
  startedAt: number;
}

export interface ScheduleState {
  schedules: ScheduleRecord[];
  activeRun: ActiveScheduleRun | null;
}

export const initialScheduleState: ScheduleState = { schedules: [], activeRun: null };

const scheduleSlice = createSlice({
  name: 'schedule',
  initialState: initialScheduleState,
  reducers: {
    schedulesLoaded: (state, action: PayloadAction<ScheduleRecord[]>) => {
      state.schedules = action.payload;
    },
    scheduleRunStarted: (state, action: PayloadAction<ActiveScheduleRun>) => {
      state.activeRun = action.payload;
    },
    scheduleRunFinished: (state) => {
      state.activeRun = null;
    },
    clearScheduleState: () => initialScheduleState,
  },
});

export const { schedulesLoaded, scheduleRunStarted, scheduleRunFinished, clearScheduleState } = scheduleSlice.actions;
export default scheduleSlice.reducer;

export const selectSchedules = (state: RootState): ScheduleRecord[] => state.schedule?.schedules ?? [];
export const selectActiveScheduleRun = (state: RootState): ActiveScheduleRun | null => state.schedule?.activeRun ?? null;

type ThunkConfig = { state: RootState };

export const createScheduleId = (): string =>
  `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const refreshSchedules = createAsyncThunk<ScheduleRecord[], void, ThunkConfig>(
  'schedule/refresh',
  async (_, { dispatch }) => {
    const list = await listSchedules();
    dispatch(schedulesLoaded(list));
    return list;
  },
);

/** Saves a new schedule. It is due at once, so the scheduler runs it on its next check. */
export const addSchedule = createAsyncThunk<ScheduleRecord, NewScheduleInput, ThunkConfig>(
  'schedule/add',
  async (input, { dispatch }) => {
    const record = createSchedule(input, createScheduleId(), Date.now());
    await saveSchedule(record);
    await dispatch(refreshSchedules());
    return record;
  },
);

/** Stops a schedule. A run of it that is going ends at the next page. */
export const stopSchedule = createAsyncThunk<void, { id: string }, ThunkConfig>(
  'schedule/stop',
  async ({ id }, { dispatch, getState }) => {
    await updateSchedule(id, (record) => ({ ...record, status: 'stopped' }));
    if (selectActiveScheduleRun(getState())?.id === id) dispatch(setDiscrubCancelled(true));
    await dispatch(refreshSchedules());
  },
);

/** Starts a stopped schedule again; it runs on the scheduler's next check. */
export const resumeSchedule = createAsyncThunk<void, { id: string }, ThunkConfig>(
  'schedule/resume',
  async ({ id }, { dispatch }) => {
    await updateSchedule(id, (record) => ({ ...record, status: 'running', nextRunAt: Date.now() }));
    await dispatch(refreshSchedules());
  },
);

export const removeSchedule = createAsyncThunk<void, { id: string }, ThunkConfig>(
  'schedule/remove',
  async ({ id }, { dispatch, getState }) => {
    if (selectActiveScheduleRun(getState())?.id === id) dispatch(setDiscrubCancelled(true));
    await deleteSchedule(id);
    await dispatch(refreshSchedules());
  },
);

/** The notification text for an alert. */
export function alertMessage(alert: ScheduleAlert, intervalMinutes: number): string {
  switch (alert.kind) {
    case 'signInExpired':
      return t('status.schedule.notify.signInExpired');
    case 'rateLimited':
      return t('status.schedule.notify.rateLimited');
    case 'skipped':
      return t('status.schedule.notify.skipped', { names: alert.names.join(', ') });
    case 'failed':
      return t('status.schedule.notify.failed', { error: alert.error, minutes: intervalMinutes });
  }
}

export type ScheduleRunOutcome = 'saved' | 'nothingNew' | 'stopped' | 'failed' | 'notRun';

/**
 * One run of a schedule, started by the scheduler. Runs only for the
 * account that made the schedule, and only while it is running.
 */
export const runScheduledExport = createAsyncThunk<ScheduleRunOutcome, { id: string }, ThunkConfig>(
  'schedule/run',
  async ({ id }, { dispatch, getState }) => {
    const token = selectAuthToken(getState());
    const user = selectCurrentUser(getState());
    if (!token || !user) return 'notRun';
    const record = await getSchedule(id);
    if (!record || record.status !== 'running' || record.userId !== user.id) return 'notRun';

    const log = (level: 'info' | 'success' | 'warning' | 'error', key: string, params: Record<string, unknown> = {}) =>
      dispatch(addStatusEntry({ level, message: t(key, { name: record.name, ...params }) }));
    const alert = (alerts: ScheduleAlert[]) => Promise.all(alerts.map((a) =>
      showNotification(t('status.schedule.notify.title', { name: record.name }), alertMessage(a, record.intervalMinutes))));

    dispatch(setDiscrubCancelled(false));
    dispatch(setDiscrubPaused(false));
    dispatch(scheduleRunStarted({ id, name: record.name, startedAt: Date.now() }));
    log('info', 'status.schedule.runStarted', { number: record.runCount + 1 });

    try {
      const result = await runSchedule(record, createRunDeps(getState, dispatch as ExportDispatch, token));
      const now = Date.now();
      await updateSchedule(id, (current) => ({
        ...applyRunResult(current, result),
        nextRunAt: nextRunTime(current.intervalMinutes, result.summary.startedAt, now, result.more),
      }));

      const { summary } = result;
      await alert(alertsForRun(record, result));
      if (summary.skipped.length > 0) log('warning', 'status.schedule.runSkipped', { count: summary.skipped.length });
      if (result.downloaded) {
        log('success', 'status.schedule.runSaved', {
          count: summary.messages,
          file: `${runZipName(record.name, summary.startedAt)}.zip`,
        });
      } else if (!summary.stoppedBy) {
        log('info', 'status.schedule.runNothingNew');
      }
      if (summary.stoppedBy === 'signInExpired') {
        log('error', 'status.schedule.stoppedSignIn');
        return 'stopped';
      }
      if (summary.stoppedBy === 'rateLimited') {
        log('error', 'status.schedule.stoppedRateLimited');
        return 'stopped';
      }
      return result.downloaded ? 'saved' : 'nothingNew';
    } catch (error) {
      await updateSchedule(id, (current) => ({ ...current, nextRunAt: retryRunTime(current.intervalMinutes, Date.now()) }))
        .catch(() => null);
      const message = error instanceof Error ? error.message : String(error);
      log('error', 'status.schedule.runFailed', { error: message, minutes: record.intervalMinutes });
      await alert([{ kind: 'failed', error: message }]);
      return 'failed';
    } finally {
      dispatch(scheduleRunFinished());
      await dispatch(refreshSchedules());
    }
  },
);

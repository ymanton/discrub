import { useEffect } from 'react';
import { useAppDispatch, useAppSelector, useAppStore } from '@/app/hooks';
import { selectAuthToken } from '@features/auth/authSlice';
import { selectCurrentUser } from '@features/user/userSlice';
import { selectIsOperationRunning } from '@features/app/operationSelectors';
import { refreshSchedules, runScheduledExport, selectActiveScheduleRun } from '@features/schedule/scheduleSlice';
import { listSchedules } from '@features/schedule/scheduleStore';
import { startScheduleLoop } from '@features/schedule/scheduleLoop';
import { throttleImmuneSleep } from '@/utils/workerTimers';

/**
 * Runs scheduled exports while signed in. Mounted once in MainLayout. On
 * sign in (or a reload) it loads the schedules and starts the scheduler, so
 * a schedule that was running picks up where it was; a run that came due
 * while Discrub was closed runs once, at once. Sign out stops it.
 *
 * Sleeps use the worker timer, so a background tab does not slow the checks.
 */
export function useScheduler(): void {
  const dispatch = useAppDispatch();
  const store = useAppStore();
  const token = useAppSelector(selectAuthToken);
  const userId = useAppSelector((state) => selectCurrentUser(state)?.id ?? null);

  useEffect(() => {
    if (!token || !userId) return undefined;
    void dispatch(refreshSchedules());
    const handle = startScheduleLoop({
      sleep: throttleImmuneSleep,
      now: () => Date.now(),
      listSchedules,
      userId: () => {
        const state = store.getState();
        return selectAuthToken(state) ? selectCurrentUser(state)?.id ?? null : null;
      },
      isBusy: () => {
        const state = store.getState();
        return selectIsOperationRunning(state) || selectActiveScheduleRun(state) !== null;
      },
      run: async (id) => dispatch(runScheduledExport({ id })).unwrap(),
      onError: (error) => console.error('[schedule] scheduler check failed', error),
    });
    return () => handle.stop();
  }, [token, userId, dispatch, store]);
}

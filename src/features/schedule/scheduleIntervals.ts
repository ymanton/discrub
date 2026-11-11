/**
 * Interval options for scheduled exports.
 *
 * A 1-minute interval is for testing only. It is offered on the dev server
 * (`npm run dev`) and in builds made with `VITE_SHORT_SCHEDULE=true`, such as
 * `VITE_SHORT_SCHEDULE=true npm run build:extension:chrome`. Store builds
 * never have it: `import.meta.env.DEV` is false there and the extension
 * config defines the flag as empty unless it is set at build time.
 */

/** The test-only interval, in minutes. */
export const SHORT_SCHEDULE_INTERVAL_MINUTES = 1;

type ScheduleEnv = { DEV?: boolean; VITE_SHORT_SCHEDULE?: string };

/** True when the 1-minute test interval should be offered. */
export const shortScheduleIntervalsEnabled = (
  env: ScheduleEnv = import.meta.env as ScheduleEnv,
): boolean => env.DEV === true || env.VITE_SHORT_SCHEDULE === 'true';

/**
 * The interval choices to show, in minutes, ascending. Adds the 1-minute
 * test interval in front of `options` when it is enabled.
 */
export const scheduleIntervalOptions = (
  options: readonly number[],
  env: ScheduleEnv = import.meta.env as ScheduleEnv,
): number[] => {
  const base = [...options].sort((a, b) => a - b);
  if (!shortScheduleIntervalsEnabled(env) || base.includes(SHORT_SCHEDULE_INTERVAL_MINUTES)) {
    return base;
  }
  return [SHORT_SCHEDULE_INTERVAL_MINUTES, ...base];
};

import type { TFunction } from 'i18next';

/** The intervals a schedule can have, in minutes. The dev and test builds add one minute (scheduleIntervals). */
export const SCHEDULE_INTERVALS = [15, 30, 60, 120, 360, 720, 1440] as const;

export const DEFAULT_INTERVAL = 60;

/** "Every 15 minutes", "Every hour", "Every 6 hours". */
export const intervalLabel = (t: TFunction, minutes: number): string =>
  minutes % 60 === 0
    ? t('schedule.everyHours', { count: minutes / 60 })
    : t('schedule.everyMinutes', { count: minutes });

import { describe, it, expect } from 'vitest';
import {
  SHORT_SCHEDULE_INTERVAL_MINUTES,
  scheduleIntervalOptions,
  shortScheduleIntervalsEnabled,
} from './scheduleIntervals';

const PROD = { DEV: false, VITE_SHORT_SCHEDULE: '' };

describe('scheduleIntervals', () => {
  describe('shortScheduleIntervalsEnabled', () => {
    it('is off in a production build without the flag', () => {
      expect(shortScheduleIntervalsEnabled(PROD)).toBe(false);
    });

    it('is on in dev', () => {
      expect(shortScheduleIntervalsEnabled({ DEV: true })).toBe(true);
    });

    it('is on in a production build with VITE_SHORT_SCHEDULE=true', () => {
      expect(shortScheduleIntervalsEnabled({ DEV: false, VITE_SHORT_SCHEDULE: 'true' })).toBe(true);
    });

    it('needs the exact value "true"', () => {
      expect(shortScheduleIntervalsEnabled({ DEV: false, VITE_SHORT_SCHEDULE: '1' })).toBe(false);
    });
  });

  describe('scheduleIntervalOptions', () => {
    it('returns the options sorted when the test interval is off', () => {
      expect(scheduleIntervalOptions([60, 15, 30], PROD)).toEqual([15, 30, 60]);
    });

    it('puts the 1-minute interval first when enabled', () => {
      expect(scheduleIntervalOptions([60, 15], { DEV: true })).toEqual([
        SHORT_SCHEDULE_INTERVAL_MINUTES, 15, 60,
      ]);
    });

    it('does not duplicate it', () => {
      expect(scheduleIntervalOptions([1, 60], { DEV: true })).toEqual([1, 60]);
    });

    it('does not change the input array', () => {
      const options = [60, 15];
      scheduleIntervalOptions(options, { DEV: true });
      expect(options).toEqual([60, 15]);
    });
  });
});

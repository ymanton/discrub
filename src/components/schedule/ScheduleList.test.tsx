import { describe, it, expect, beforeEach } from 'vitest';
import { renderWithProviders, screen, userEvent, waitFor } from '@/test/test-utils';
import { createBaseState } from '@/test/state-factories';
import ScheduleList from './ScheduleList';
import { createSchedule } from '@features/schedule/scheduleRecord';
import { clearSchedules, getSchedule, saveSchedule } from '@features/schedule/scheduleStore';
import type { ScheduleRecord } from '@features/schedule/scheduleTypes';

const make = (id: string, extra: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  ...createSchedule(
    {
      name: `Schedule ${id}`,
      userId: 'u1',
      scope: { kind: 'guild', guildId: 'g1', guildName: 'Raid server' },
      intervalMinutes: 60,
      targets: [
        { id: 'c1', name: 'general', type: 0, start: { kind: 'full' } },
        { id: 'c2', name: 'wiped', type: 0, start: { kind: 'now' } },
      ],
    },
    id,
    Date.now(),
  ),
  ...extra,
});

const render = (schedules: ScheduleRecord[], activeRun: { id: string; name: string; startedAt: number } | null = null) =>
  renderWithProviders(<ScheduleList />, {
    preloadedState: { ...createBaseState(), schedule: { schedules, activeRun } },
  });

describe('ScheduleList', () => {
  beforeEach(async () => {
    await clearSchedules();
  });

  it('says how to make one when there are none', () => {
    render([]);
    expect(screen.getByTestId('schedule-list-empty')).toBeInTheDocument();
  });

  it('shows the scope, size, interval and that it has not run', () => {
    render([make('s1')]);
    expect(screen.getByText('Schedule s1')).toBeInTheDocument();
    expect(screen.getByText('Raid server · 2 channels · Every hour')).toBeInTheDocument();
    expect(screen.getByTestId('schedule-last-run')).toHaveTextContent('Not run yet');
    expect(screen.getByTestId('schedule-status')).toHaveTextContent('Running');
    expect(screen.getByTestId('schedule-next-run')).toHaveTextContent('Next run shortly');
  });

  it('summarizes the last run', () => {
    render([make('s1', {
      lastRun: { startedAt: 1, finishedAt: Date.now(), messages: 1234, skipped: ['c2'] },
      nextRunAt: Date.now() + 3_600_000,
    })]);
    expect(screen.getByTestId('schedule-last-run')).toHaveTextContent('1,234 new messages, 1 skipped');
    expect(screen.getByTestId('schedule-next-run')).toHaveTextContent(/^Next run /);
  });

  it('says why a schedule stopped itself', () => {
    render([make('s1', {
      status: 'stopped',
      lastRun: { startedAt: 1, finishedAt: 2, messages: 0, skipped: [], stoppedBy: 'signInExpired' },
    })]);
    expect(screen.getByTestId('schedule-last-run')).toHaveTextContent('Stopped because the sign in expired');
    expect(screen.getByTestId('schedule-status')).toHaveTextContent('Stopped');
    expect(screen.queryByTestId('schedule-next-run')).not.toBeInTheDocument();
  });

  it('marks the schedule whose run is going', () => {
    render([make('s1')], { id: 's1', name: 'Schedule s1', startedAt: 0 });
    expect(screen.getByTestId('schedule-status')).toHaveTextContent('Running now');
  });

  it('stops and starts a schedule', async () => {
    const record = make('s1');
    await saveSchedule(record);
    render([record]);
    await userEvent.click(screen.getByTestId('schedule-stop'));
    await waitFor(async () => expect((await getSchedule('s1'))?.status).toBe('stopped'));
    await userEvent.click(await screen.findByTestId('schedule-resume'));
    await waitFor(async () => expect((await getSchedule('s1'))?.status).toBe('running'));
  });

  it('asks before deleting', async () => {
    const record = make('s1');
    await saveSchedule(record);
    render([record]);
    await userEvent.click(screen.getByTestId('schedule-delete'));
    expect(screen.getByText(/Delete this schedule/)).toBeInTheDocument();
    await userEvent.click(screen.getByText('Keep'));
    expect(await getSchedule('s1')).not.toBeNull();

    await userEvent.click(screen.getByTestId('schedule-delete'));
    await userEvent.click(screen.getByTestId('schedule-delete-yes'));
    await waitFor(async () => expect(await getSchedule('s1')).toBeNull());
    expect(await screen.findByTestId('schedule-list-empty')).toBeInTheDocument();
  });
});

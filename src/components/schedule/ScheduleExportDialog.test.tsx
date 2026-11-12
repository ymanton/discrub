import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, userEvent, waitFor, within, fireEvent } from '@/test/test-utils';
import { createBaseState } from '@/test/state-factories';
import type { Channel } from 'discrub-core/types/discord-types';

const mockRequestPermission = vi.fn(async () => true);
vi.mock('@features/schedule/scheduleNotify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@features/schedule/scheduleNotify')>()),
  requestNotificationPermission: () => mockRequestPermission(),
}));

import ScheduleExportDialog, { localDateToIso } from './ScheduleExportDialog';
import { clearSchedules, listSchedules } from '@features/schedule/scheduleStore';
import { afterCursorForDate } from '@features/schedule/scheduleCursor';

const channels = [
  { id: 'c1', name: 'general', type: 0 },
  { id: 'c2', name: 'wiped', type: 0 },
] as Channel[];

const signedIn = () => {
  const base = createBaseState();
  return {
    ...base,
    auth: { ...base.auth, token: 't', isAuthenticated: true },
    user: { ...base.user, currentUser: { id: 'u1', username: 'me' } as never },
  };
};

const open = (props: Partial<Parameters<typeof ScheduleExportDialog>[0]> = {}) =>
  renderWithProviders(
    <ScheduleExportDialog
      open
      onClose={vi.fn()}
      channels={channels}
      mode="channels"
      guild={{ id: 'g1', name: 'Raid server' }}
      {...props}
    />,
    { preloadedState: signedIn() },
  );

const pick = async (testId: string, option: string) => {
  fireEvent.mouseDown(screen.getByTestId(testId));
  await userEvent.click(within(await screen.findByRole('listbox')).getByText(option));
};

describe('ScheduleExportDialog', () => {
  beforeEach(async () => {
    await clearSchedules();
    mockRequestPermission.mockClear();
  });

  it('defaults the name to the server and every channel to "From now on"', () => {
    open();
    expect(screen.getByTestId('schedule-name')).toHaveValue('Raid server');
    expect(screen.getByTestId('schedule-start-c1')).toHaveTextContent('From now on');
    expect(screen.getByTestId('schedule-start-c2')).toHaveTextContent('From now on');
    expect(screen.getByTestId('schedule-interval')).toHaveTextContent('Every hour');
  });

  it('creates a server schedule with each channel\'s own start point', async () => {
    const onClose = vi.fn();
    open({ onClose });
    await pick('schedule-start-c1', 'Full history');
    await pick('schedule-interval', 'Every 30 minutes');
    await userEvent.click(screen.getByTestId('schedule-create'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [record] = await listSchedules();
    expect(record).toMatchObject({
      name: 'Raid server',
      userId: 'u1',
      intervalMinutes: 30,
      scope: { kind: 'guild', guildId: 'g1', guildName: 'Raid server' },
    });
    expect(record.targets.map((t) => [t.id, t.start.kind])).toEqual([['c1', 'full'], ['c2', 'now']]);
    expect(record.cursors.c1).toBe('0');
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
  });

  it('starts a channel from a chosen date at local midnight', async () => {
    open();
    await pick('schedule-start-c2', 'From a date');
    fireEvent.change(screen.getByTestId('schedule-date-c2'), { target: { value: '2026-01-15' } });
    await userEvent.click(screen.getByTestId('schedule-create'));

    await waitFor(async () => expect(await listSchedules()).toHaveLength(1));
    const [record] = await listSchedules();
    const iso = new Date('2026-01-15T00:00:00').toISOString();
    expect(record.targets[1].start).toEqual({ kind: 'date', date: iso });
    expect(record.cursors.c2).toBe(afterCursorForDate(new Date(iso)));
  });

  it('sets every channel at once', async () => {
    open();
    await pick('schedule-start-all', 'Full history');
    expect(screen.getByTestId('schedule-start-c1')).toHaveTextContent('Full history');
    expect(screen.getByTestId('schedule-start-c2')).toHaveTextContent('Full history');
  });

  it('cannot create without a name or with an invalid date', async () => {
    open();
    await userEvent.clear(screen.getByTestId('schedule-name'));
    expect(screen.getByTestId('schedule-create')).toBeDisabled();
    await userEvent.type(screen.getByTestId('schedule-name'), 'x');
    expect(screen.getByTestId('schedule-create')).toBeEnabled();

    await pick('schedule-start-c1', 'From a date');
    fireEvent.change(screen.getByTestId('schedule-date-c1'), { target: { value: '' } });
    expect(screen.getByTestId('schedule-create')).toBeDisabled();
  });

  it('makes a DM schedule named after DMs', async () => {
    const dms = [{ id: 'dm1', type: 1, recipients: [{ id: 'f', username: 'alice' }] }] as Channel[];
    open({ channels: dms, mode: 'dms', guild: null });
    expect(screen.getByTestId('schedule-name')).toHaveValue('Direct messages');
    await userEvent.click(screen.getByTestId('schedule-create'));
    await waitFor(async () => expect(await listSchedules()).toHaveLength(1));
    const [record] = await listSchedules();
    expect(record.scope).toEqual({ kind: 'dms' });
    expect(record.targets[0]).toMatchObject({ id: 'dm1', name: 'alice', type: 1 });
  });
});

describe('localDateToIso', () => {
  it('reads yyyy-mm-dd as local midnight', () => {
    expect(localDateToIso('2026-03-01')).toBe(new Date(2026, 2, 1).toISOString());
  });

  it('rejects anything else', () => {
    expect(localDateToIso('')).toBeNull();
    expect(localDateToIso('03/01/2026')).toBeNull();
  });
});

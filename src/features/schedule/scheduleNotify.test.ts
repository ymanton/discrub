import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

let extensionMode = false;
vi.mock('@/extension/messaging', () => ({ isExtensionMode: () => extensionMode }));

import { createSchedule, withThreads } from './scheduleRecord';
import { alertsForRun, notificationsAllowed, requestNotificationPermission, showNotification } from './scheduleNotify';
import type { RunResult } from './scheduleRun';

const record = withThreads(
  createSchedule(
    {
      name: 'Raid',
      userId: 'u1',
      scope: { kind: 'guild', guildId: 'g1', guildName: 'Raid server' },
      intervalMinutes: 60,
      targets: [
        { id: 'c1', name: 'general', type: 0, start: { kind: 'full' } },
        { id: 'c2', name: 'secret', type: 0, start: { kind: 'full' } },
      ],
    },
    's1',
    0,
  ),
  [{ id: 't1', name: 'raid night', parentId: 'c1' }],
);

const result = (summary: Partial<RunResult['summary']>): RunResult => ({
  changes: { cursors: {}, threads: [], backfilled: [] },
  summary: { startedAt: 0, finishedAt: 1, messages: 0, skipped: [], ...summary },
  more: false,
  downloaded: false,
});

describe('alertsForRun', () => {
  it('has nothing to say about a clean run', () => {
    expect(alertsForRun(record, result({ messages: 5 }))).toEqual([]);
  });

  it('alerts when the run stopped the schedule', () => {
    expect(alertsForRun(record, result({ stoppedBy: 'signInExpired' }))).toEqual([{ kind: 'signInExpired' }]);
    expect(alertsForRun(record, result({ stoppedBy: 'rateLimited' }))).toEqual([{ kind: 'rateLimited' }]);
  });

  it('names skipped channels, threads and the server', () => {
    expect(alertsForRun(record, result({ skipped: ['c2', 't1', 'g1', 'gone'] }))).toEqual([
      { kind: 'skipped', names: ['secret', 'raid night', 'Raid server', 'gone'] },
    ]);
  });

  it('alerts only on the first run a channel fails', () => {
    const after = { ...record, lastRun: { startedAt: 0, finishedAt: 1, messages: 0, skipped: ['c2'] } };
    expect(alertsForRun(after, result({ skipped: ['c2'] }))).toEqual([]);
    expect(alertsForRun(after, result({ skipped: ['c2', 'c1'] }))).toEqual([{ kind: 'skipped', names: ['general'] }]);
  });
});

describe('notifications', () => {
  const sendMessage = vi.fn();
  const NotificationMock = vi.fn() as unknown as Omit<typeof Notification, 'permission' | 'requestPermission'> & { permission: NotificationPermission; requestPermission: Mock<[], Promise<NotificationPermission>> };

  beforeEach(() => {
    extensionMode = false;
    sendMessage.mockReset().mockResolvedValue({ success: true });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    (NotificationMock as unknown as ReturnType<typeof vi.fn>).mockReset();
    NotificationMock.permission = 'default';
    NotificationMock.requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted');
    vi.stubGlobal('Notification', NotificationMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('goes through the background script in the extension', async () => {
    extensionMode = true;
    expect(notificationsAllowed()).toBe(true);
    await showNotification('Discrub', 'stopped');
    expect(sendMessage).toHaveBeenCalledWith({ action: 'showNotification', title: 'Discrub', message: 'stopped' });
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('uses the Notification API in the web app once allowed', async () => {
    await showNotification('Discrub', 'nope');
    expect(NotificationMock).not.toHaveBeenCalled();

    NotificationMock.permission = 'granted';
    await showNotification('Discrub', 'stopped');
    expect(NotificationMock).toHaveBeenCalledWith('Discrub', { body: 'stopped', tag: 'discrub-schedule' });
  });

  it('asks for permission only while it is undecided', async () => {
    expect(await requestNotificationPermission()).toBe(true);
    expect(NotificationMock.requestPermission).toHaveBeenCalledTimes(1);

    NotificationMock.permission = 'denied';
    expect(await requestNotificationPermission()).toBe(false);
    expect(NotificationMock.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('never throws when a notification fails', async () => {
    extensionMode = true;
    sendMessage.mockRejectedValue(new Error('no receiver'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(showNotification('a', 'b')).resolves.toBeUndefined();
    consoleError.mockRestore();
  });
});

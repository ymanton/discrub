import { isExtensionMode } from '@/extension/messaging';
import type { RunResult } from './scheduleRun';
import type { ScheduleRecord } from './scheduleTypes';

/**
 * Desktop notifications for scheduled exports, so a run that needs the user
 * is seen on an unattended machine. The extension shows them through the
 * background script (`chrome.notifications`): Discrub runs in a frame inside
 * the Discord tab, and browsers do not let a cross-origin frame show web
 * notifications. The web app uses the Notification API once the user allows
 * it, which the schedule dialog asks for.
 */

export type ScheduleAlert =
  | { kind: 'signInExpired' }
  | { kind: 'rateLimited' }
  | { kind: 'skipped'; names: string[] }
  | { kind: 'failed'; error: string };

/**
 * What a run should alert about. A channel that keeps failing alerts only on
 * the first run it fails, not every run after.
 */
export function alertsForRun(record: ScheduleRecord, result: RunResult): ScheduleAlert[] {
  const alerts: ScheduleAlert[] = [];
  const { summary } = result;
  if (summary.stoppedBy === 'signInExpired') alerts.push({ kind: 'signInExpired' });
  if (summary.stoppedBy === 'rateLimited') alerts.push({ kind: 'rateLimited' });
  const before = new Set(record.lastRun?.skipped ?? []);
  const fresh = summary.skipped.filter((id) => !before.has(id));
  if (fresh.length > 0) {
    const names = fresh.map((id) =>
      record.targets.find((t) => t.id === id)?.name
      ?? record.threads[id]?.name
      ?? (record.scope.kind === 'guild' && record.scope.guildId === id ? record.scope.guildName : id));
    alerts.push({ kind: 'skipped', names });
  }
  return alerts;
}

/** True when notifications can be shown without asking. */
export function notificationsAllowed(): boolean {
  if (isExtensionMode()) return true;
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

/**
 * Asks to show notifications (web app). Call from a click, as browsers
 * ignore the request otherwise. Resolves true when they are allowed.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (isExtensionMode()) return true;
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'default') return Notification.permission === 'granted';
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/** Shows one notification. Never throws: a notification is a courtesy, the status log has it all. */
export async function showNotification(title: string, message: string): Promise<void> {
  try {
    if (isExtensionMode()) {
      await chrome.runtime.sendMessage({ action: 'showNotification', title, message });
      return;
    }
    if (notificationsAllowed()) new Notification(title, { body: message, tag: 'discrub-schedule' });
  } catch (error) {
    console.error('[schedule] could not show a notification', error);
  }
}

import type { Channel, Message } from 'discrub-core/types/discord-types';
import { QueryStringParam } from 'discrub-core/discord-enum';
import type { RootState } from '@/app/store';
import { getDiscordService } from '@services/discordService';
import { StreamingZipService } from '@services/streamingZipService';
import { buildZipOptions, type ExportDispatch } from '@features/export/exportSlice';
import {
  selectDelayModifier,
  selectRateLimitStopped,
  selectRequestsRefusedStopped,
  selectSearchDelay,
} from '@features/app/appSlice';
import { addStatusEntry } from '@features/status/statusSlice';
import { calculateRandomDelay } from '@/utils/delayUtils';
import {
  cancellableDelay,
  checkCancelled,
  isSignInExpired,
  waitWhilePaused,
  withTransientRetry,
  type RetryableResponse,
} from '@/utils/operationLoopUtils';
import { t } from '@/i18n';
import { ApiFailure, FORUM_TYPES, SignInExpired, type RunDeps, type RunEvent } from './scheduleRun';
import type { RunSink } from './scheduleOutput';
import type { ScheduleTarget, ScheduleThread } from './scheduleTypes';

/**
 * The real `RunDeps`: Discord through the shared service with the same
 * pacing, retries and stops as every other long operation, the zip through
 * StreamingZipService, and status log entries for what the run does.
 *
 * The shared service has its own pre-request delay off (#241), so every
 * request here first waits the search delay plus a random part of the
 * modifier, as the other loops do.
 */

const FORUM_PAGE = 25;

/** Channels where the archived private threads endpoint answered 403 (no Manage Threads); asked once per session. */
const noManageThreads = new Set<string>();

export const toScheduleThread = (channel: Channel): ScheduleThread => ({
  id: channel.id,
  name: channel.name || channel.id,
  parentId: channel.parent_id ?? '',
  ...(channel.last_message_id ? { lastMessageId: channel.last_message_id } : {}),
});

type ApiResponse<T> = RetryableResponse & { data?: T };

export function createRunDeps(
  getState: () => RootState,
  dispatch: ExportDispatch,
  token: string,
): RunDeps<Message> {
  const discord = getDiscordService();

  const pace = async (): Promise<void> => {
    const { delayMs } = calculateRandomDelay(selectSearchDelay(getState()), selectDelayModifier(getState()));
    // A cancel during the wait fails the request; the run treats it as the stop.
    if (await cancellableDelay(delayMs, getState)) throw new ApiFailure('cancelled');
  };

  /** One paced request with transient retries; a failure throws. */
  const request = async <T>(label: string, call: () => Promise<ApiResponse<T>>): Promise<T> => {
    await pace();
    const response = await withTransientRetry(call, {
      getState,
      dispatch,
      onRetry: (attempt, delayMs, _last, max) => {
        dispatch(addStatusEntry({
          level: 'warning',
          message: t('status.schedule.retry', { name: label, seconds: Math.round(delayMs / 1000), attempt, max }),
        }));
      },
    });
    if (response.success && response.data !== undefined) return response.data;
    if (isSignInExpired(response)) throw new SignInExpired();
    throw new ApiFailure(response.status !== undefined ? String(response.status) : 'network');
  };

  const listForumPosts = async (target: ScheduleTarget, all: boolean): Promise<ScheduleThread[]> => {
    const found: ScheduleThread[] = [];
    for (let offset = 0; ; offset += FORUM_PAGE) {
      const page = await request(target.name, () => discord.fetchForumThreadSearch(token, target.id, {
        sort_by: 'last_message_time',
        sort_order: 'desc',
        limit: FORUM_PAGE,
        offset,
        // No `archived`: the endpoint then returns active and archived posts (#151).
      }));
      found.push(...page.threads.map(toScheduleThread));
      if (!all || !page.has_more || page.threads.length === 0) return found;
    }
  };

  const listPublicArchived = async (target: ScheduleTarget, all: boolean): Promise<ScheduleThread[]> => {
    const found: ScheduleThread[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await request(target.name, () => discord.fetchPublicThreads(token, target.id, before));
      found.push(...page.threads.map(toScheduleThread));
      const last = page.threads[page.threads.length - 1];
      before = last?.thread_metadata?.archive_timestamp;
      if (!all || !page.has_more || !before) return found;
    }
  };

  /**
   * Private archived threads: all of them with Manage Threads, else only the
   * ones this account joined. Losing these never skips the channel; only an
   * expired sign in stops the run.
   */
  const listPrivateArchived = async (target: ScheduleTarget, all: boolean): Promise<ScheduleThread[]> => {
    const passOn = (error: unknown): void => {
      if (error instanceof SignInExpired) throw error;
    };
    if (!noManageThreads.has(target.id)) {
      try {
        const page = await request(target.name, () => discord.fetchPrivateThreads(token, target.id));
        return page.threads.map(toScheduleThread);
      } catch (error) {
        passOn(error);
        if (error instanceof ApiFailure && error.reason === '403') noManageThreads.add(target.id);
      }
    }
    const found: ScheduleThread[] = [];
    let before: string | undefined;
    try {
      for (;;) {
        const page = await request(target.name, () => discord.fetchJoinedPrivateArchivedThreads(token, target.id, before));
        found.push(...page.threads.map(toScheduleThread));
        before = page.threads[page.threads.length - 1]?.id;
        if (!all || !page.has_more || !before) break;
      }
    } catch (error) {
      passOn(error);
    }
    return found;
  };

  const onEvent = (event: RunEvent): void => {
    switch (event.type) {
      case 'channel':
        dispatch(addStatusEntry({
          level: 'info',
          message: t('status.schedule.channel', { name: event.name, count: event.messages }),
        }));
        return;
      case 'skipped':
        dispatch(addStatusEntry({
          level: 'warning',
          message: t('status.schedule.skipped', { name: event.name, reason: event.reason }),
        }));
        return;
      case 'backlog':
        dispatch(addStatusEntry({ level: 'info', message: t('status.schedule.backlog') }));
    }
  };

  return {
    now: () => Date.now(),
    listMessages: (channelId, after, name) =>
      request(name, () => discord.fetchMessageData(token, after, channelId, QueryStringParam.AFTER)),
    listActiveThreads: async (guildId, name) =>
      (await request(name, () => discord.fetchActiveGuildThreads(token, guildId))).threads.map(toScheduleThread),
    listArchivedThreads: async (target, all) => {
      if (FORUM_TYPES.includes(target.type)) return listForumPosts(target, all);
      const [pub, priv] = [await listPublicArchived(target, all), await listPrivateArchived(target, all)];
      return [...pub, ...priv];
    },
    openSink: (zipName): RunSink => {
      const zip = new StreamingZipService(zipName, buildZipOptions(getState, dispatch));
      return {
        addFile: async (path, content) => {
          await zip.addFile(new Blob([content], { type: 'application/json' }), path);
        },
        finalize: () => zip.finalize(),
        cancel: () => zip.cancel(),
      };
    },
    stopReason: () => {
      const state = getState();
      if (selectRateLimitStopped(state) || selectRequestsRefusedStopped(state)) return 'rateLimited';
      if (checkCancelled(getState)) return 'cancelled';
      return null;
    },
    waitWhilePaused: () => waitWhilePaused(getState),
    onEvent,
  };
}

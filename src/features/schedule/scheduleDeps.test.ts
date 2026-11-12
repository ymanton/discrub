import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RootState } from '@/app/store';

const discord = {
  fetchMessageData: vi.fn(),
  fetchActiveGuildThreads: vi.fn(),
  fetchForumThreadSearch: vi.fn(),
  fetchPublicThreads: vi.fn(),
  fetchPrivateThreads: vi.fn(),
  fetchJoinedPrivateArchivedThreads: vi.fn(),
};

vi.mock('@services/discordService', () => ({ getDiscordService: () => discord }));

const zipFiles: Array<{ path: string; blob: Blob }> = [];
const zipCalls = { finalize: 0, cancel: 0, names: [] as string[] };
vi.mock('@services/streamingZipService', () => ({
  StreamingZipService: class {
    constructor(name: string) {
      zipCalls.names.push(name);
    }
    async addFile(blob: Blob, path: string) {
      zipFiles.push({ path, blob });
      return path;
    }
    async finalize() {
      zipCalls.finalize += 1;
    }
    async cancel() {
      zipCalls.cancel += 1;
    }
  },
}));

vi.mock('@features/export/exportSlice', () => ({ buildZipOptions: () => ({}) }));

import { createRunDeps, toScheduleThread } from './scheduleDeps';
import { ApiFailure, SignInExpired } from './scheduleRun';
import type { ScheduleTarget } from './scheduleTypes';

let app: Record<string, unknown>;
const getState = () => ({ app } as unknown as RootState);
const dispatch = vi.fn();

const ok = <T>(data: T) => Promise.resolve({ success: true, data });
const fail = (status?: number) => Promise.resolve({ success: false, status });

const text: ScheduleTarget = { id: 'c1', name: 'general', type: 0, start: { kind: 'full' } };
const forum: ScheduleTarget = { id: 'f1', name: 'help', type: 15, start: { kind: 'full' } };

const deps = () => createRunDeps(getState, dispatch, 'token');

describe('createRunDeps', () => {
  beforeEach(() => {
    Object.values(discord).forEach((fn) => fn.mockReset());
    dispatch.mockReset();
    zipFiles.length = 0;
    zipCalls.finalize = 0;
    zipCalls.cancel = 0;
    zipCalls.names = [];
    app = {
      settings: { searchDelay2: '0', delayModifier2: '0' },
      discrubCancelled: false,
      discrubPaused: false,
      rateLimitStopped: false,
      requestsRefusedStopped: false,
    };
  });

  describe('listMessages', () => {
    it('asks for messages after the cursor', async () => {
      discord.fetchMessageData.mockReturnValue(ok([{ id: '5' }]));
      expect(await deps().listMessages('c1', '4', 'general')).toEqual([{ id: '5' }]);
      expect(discord.fetchMessageData).toHaveBeenCalledWith('token', '4', 'c1', 'after');
    });

    it('throws SignInExpired on 401', async () => {
      discord.fetchMessageData.mockReturnValue(fail(401));
      await expect(deps().listMessages('c1', '0', 'general')).rejects.toBeInstanceOf(SignInExpired);
    });

    it('throws ApiFailure with the status otherwise', async () => {
      discord.fetchMessageData.mockReturnValue(fail(403));
      await expect(deps().listMessages('c1', '0', 'general')).rejects.toMatchObject({ reason: '403' });
    });

    it('fails without a request when cancelled during the pacing wait', async () => {
      app.settings = { searchDelay2: '5', delayModifier2: '0' };
      app.discrubCancelled = true;
      await expect(deps().listMessages('c1', '0', 'general')).rejects.toBeInstanceOf(ApiFailure);
      expect(discord.fetchMessageData).not.toHaveBeenCalled();
    });
  });

  describe('threads', () => {
    it('maps a thread channel', () => {
      expect(toScheduleThread({ id: 't1', name: 'raid', parent_id: 'c1', last_message_id: '9' } as never))
        .toEqual({ id: 't1', name: 'raid', parentId: 'c1', lastMessageId: '9' });
      expect(toScheduleThread({ id: 't2' } as never)).toEqual({ id: 't2', name: 't2', parentId: '' });
    });

    it('lists a server\'s active threads', async () => {
      discord.fetchActiveGuildThreads.mockReturnValue(ok({ threads: [{ id: 't1', name: 'a', parent_id: 'c1' }] }));
      expect(await deps().listActiveThreads('g1', 'Raid')).toEqual([{ id: 't1', name: 'a', parentId: 'c1' }]);
    });

    it('pages a forum\'s posts when backfilling, one page otherwise', async () => {
      discord.fetchForumThreadSearch
        .mockReturnValueOnce(ok({ threads: [{ id: 'p1', parent_id: 'f1' }], has_more: true }))
        .mockReturnValueOnce(ok({ threads: [{ id: 'p2', parent_id: 'f1' }], has_more: false }));
      const all = await deps().listArchivedThreads(forum, true);
      expect(all.map((t) => t.id)).toEqual(['p1', 'p2']);
      expect(discord.fetchForumThreadSearch.mock.calls.map((c) => c[2].offset)).toEqual([0, 25]);

      discord.fetchForumThreadSearch.mockReset();
      discord.fetchForumThreadSearch.mockReturnValue(ok({ threads: [{ id: 'p1', parent_id: 'f1' }], has_more: true }));
      expect((await deps().listArchivedThreads(forum, false)).map((t) => t.id)).toEqual(['p1']);
      expect(discord.fetchForumThreadSearch).toHaveBeenCalledTimes(1);
    });

    it('pages public archived threads by archive time when backfilling', async () => {
      discord.fetchPublicThreads
        .mockReturnValueOnce(ok({ threads: [{ id: 't1', parent_id: 'c1', thread_metadata: { archive_timestamp: 'T1' } }], has_more: true }))
        .mockReturnValueOnce(ok({ threads: [{ id: 't2', parent_id: 'c1', thread_metadata: { archive_timestamp: 'T2' } }], has_more: false }));
      discord.fetchPrivateThreads.mockReturnValue(ok({ threads: [] }));
      const found = await deps().listArchivedThreads(text, true);
      expect(found.map((t) => t.id)).toEqual(['t1', 't2']);
      expect(discord.fetchPublicThreads.mock.calls.map((c) => c[2])).toEqual([undefined, 'T1']);
    });

    it('falls back to joined private threads without Manage Threads, and stops asking', async () => {
      discord.fetchPublicThreads.mockReturnValue(ok({ threads: [], has_more: false }));
      discord.fetchPrivateThreads.mockReturnValue(fail(403));
      discord.fetchJoinedPrivateArchivedThreads.mockReturnValue(ok({ threads: [{ id: 'pt1', parent_id: 'c-nomt' }], has_more: false }));
      const target = { ...text, id: 'c-nomt' };

      expect((await deps().listArchivedThreads(target, false)).map((t) => t.id)).toEqual(['pt1']);
      await deps().listArchivedThreads(target, false);
      expect(discord.fetchPrivateThreads).toHaveBeenCalledTimes(1);
      expect(discord.fetchJoinedPrivateArchivedThreads).toHaveBeenCalledTimes(2);
    });

    it('does not skip the channel when private thread listings fail', async () => {
      discord.fetchPublicThreads.mockReturnValue(ok({ threads: [{ id: 't1', parent_id: 'c2' }], has_more: false }));
      discord.fetchPrivateThreads.mockReturnValue(fail(500));
      discord.fetchJoinedPrivateArchivedThreads.mockReturnValue(fail(403));
      const found = await deps().listArchivedThreads({ ...text, id: 'c2' }, false);
      expect(found.map((t) => t.id)).toEqual(['t1']);
    }, 60_000);

    it('still stops on an expired sign in from a private listing', async () => {
      discord.fetchPublicThreads.mockReturnValue(ok({ threads: [], has_more: false }));
      discord.fetchPrivateThreads.mockReturnValue(fail(401));
      await expect(deps().listArchivedThreads({ ...text, id: 'c3' }, false)).rejects.toBeInstanceOf(SignInExpired);
    });
  });

  describe('run controls', () => {
    it('reports a rate-limit stop or a refusal stop as rateLimited', () => {
      expect(deps().stopReason()).toBeNull();
      app.rateLimitStopped = true;
      expect(deps().stopReason()).toBe('rateLimited');
      app.rateLimitStopped = false;
      app.requestsRefusedStopped = true;
      expect(deps().stopReason()).toBe('rateLimited');
    });

    it('reports a cancel', () => {
      app.discrubCancelled = true;
      expect(deps().stopReason()).toBe('cancelled');
    });
  });

  describe('openSink', () => {
    it('writes JSON files into a StreamingZipService named after the run', async () => {
      const sink = deps().openSink('discrub-schedule_x');
      await sink.addFile('a/messages-0001.json', '[{"id":"1"}]');
      await sink.finalize();
      expect(zipCalls.names).toEqual(['discrub-schedule_x']);
      expect(zipFiles[0].path).toBe('a/messages-0001.json');
      expect(zipFiles[0].blob.type).toBe('application/json');
      expect(zipFiles[0].blob.size).toBe('[{"id":"1"}]'.length);
      expect(zipCalls.finalize).toBe(1);
    });
  });

  describe('status log', () => {
    it('logs channels, skips and backlogs', () => {
      const { onEvent } = deps();
      onEvent!({ type: 'channel', name: 'general', kind: 'channel', messages: 3 });
      onEvent!({ type: 'skipped', name: 'secret', reason: '403' });
      onEvent!({ type: 'backlog' });
      const entries = dispatch.mock.calls.map(([action]) => action.payload);
      expect(entries.map((e) => e.level)).toEqual(['info', 'warning', 'info']);
      expect(entries[0].message).toContain('general');
      expect(entries[1].message).toContain('403');
    });
  });
});

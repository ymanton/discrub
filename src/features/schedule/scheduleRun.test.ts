import { describe, it, expect, vi } from 'vitest';
import { createSchedule } from './scheduleRecord';
import { ApiFailure, SignInExpired, applyRunResult, runSchedule, type RunDeps } from './scheduleRun';
import type { RunManifest, RunSink } from './scheduleOutput';
import type { NewScheduleInput, ScheduleRecord, ScheduleTarget, ScheduleThread } from './scheduleTypes';

type Msg = { id: string; channel_id: string };

const NOW = Date.parse('2026-11-11T10:00:00Z');

/** A fake Discord: message ids per channel, threads, and failures to inject. */
class FakeDiscord {
  messages = new Map<string, number[]>();
  active: ScheduleThread[] = [];
  archived = new Map<string, ScheduleThread[]>();
  failures = new Map<string, Error | { afterCalls: number; error: Error }>();
  calls: Array<{ channelId: string; after: string }> = [];
  archivedCalls: Array<{ id: string; all: boolean }> = [];
  activeCalls = 0;

  add(channelId: string, from: number, to: number): this {
    const list = this.messages.get(channelId) ?? [];
    for (let id = from; id <= to; id++) list.push(id);
    this.messages.set(channelId, list);
    return this;
  }

  async listMessages(channelId: string, after: string): Promise<Msg[]> {
    this.calls.push({ channelId, after });
    const failure = this.failures.get(channelId);
    if (failure instanceof Error) throw failure;
    if (failure && this.calls.filter((c) => c.channelId === channelId).length > failure.afterCalls) throw failure.error;
    return (this.messages.get(channelId) ?? [])
      .filter((id) => BigInt(id) > BigInt(after))
      .slice(0, 100)
      .reverse()
      .map((id) => ({ id: String(id), channel_id: channelId }));
  }

  callsFor(channelId: string): number {
    return this.calls.filter((c) => c.channelId === channelId).length;
  }
}

const fakeSink = () => {
  const files = new Map<string, string>();
  return {
    files,
    names: [] as string[],
    finalized: false,
    cancelled: false,
    failFinalize: false,
  };
};

const setup = (discord: FakeDiscord, overrides: Partial<RunDeps<Msg>> = {}) => {
  const sink = fakeSink();
  const events: unknown[] = [];
  const deps: RunDeps<Msg> = {
    now: () => NOW,
    listMessages: (id, after) => discord.listMessages(id, after),
    listActiveThreads: async () => {
      discord.activeCalls += 1;
      return discord.active;
    },
    listArchivedThreads: async (target: ScheduleTarget, all: boolean) => {
      discord.archivedCalls.push({ id: target.id, all });
      return discord.archived.get(target.id) ?? [];
    },
    openSink: (name): RunSink => {
      sink.names.push(name);
      return {
        addFile: async (path, content) => {
          sink.files.set(path, content);
        },
        finalize: async () => {
          if (sink.failFinalize) throw new Error('download failed');
          sink.finalized = true;
        },
        cancel: async () => {
          sink.cancelled = true;
        },
      };
    },
    stopReason: () => null,
    waitWhilePaused: async () => undefined,
    onEvent: (e) => events.push(e),
    ...overrides,
  };
  const manifest = (): RunManifest => JSON.parse(sink.files.get('manifest.json')!);
  const ids = (path: string): number[] => JSON.parse(sink.files.get(path)!).map((m: Msg) => Number(m.id));
  return { deps, sink, events, manifest, ids };
};

const dms = (targets: ScheduleTarget[]): ScheduleRecord =>
  createSchedule({ name: 'Friends', userId: 'u1', scope: { kind: 'dms' }, intervalMinutes: 60, targets }, 's1', NOW - 1000);

const guild = (targets: ScheduleTarget[], extra: Partial<NewScheduleInput> = {}): ScheduleRecord =>
  createSchedule(
    { name: 'Raid', userId: 'u1', scope: { kind: 'guild', guildId: 'g1', guildName: 'Raid' }, intervalMinutes: 60, targets, ...extra },
    's1',
    NOW - 1000,
  );

const full = (id: string, type = 0, name = id): ScheduleTarget => ({ id, name, type, start: { kind: 'full' } });

describe('runSchedule', () => {
  it('exports each channel\'s new messages into one zip', async () => {
    const discord = new FakeDiscord().add('dm1', 1, 3).add('dm2', 10, 11);
    const { deps, sink, manifest, ids } = setup(discord);
    const result = await runSchedule(dms([full('dm1', 1), full('dm2', 1)]), deps);

    expect(result.downloaded).toBe(true);
    expect(sink.names).toHaveLength(1);
    expect(sink.names[0]).toMatch(/^discrub-schedule_friends_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    expect(ids('dm1_dm1/messages-0001.json')).toEqual([1, 2, 3]);
    expect(ids('dm2_dm2/messages-0001.json')).toEqual([10, 11]);
    expect(result.changes.cursors).toEqual({ dm1: '3', dm2: '11' });
    expect(result.summary).toMatchObject({ messages: 5, skipped: [], startedAt: NOW });
    expect(manifest()).toMatchObject({ run: { number: 1, more: false }, skipped: [] });
    expect(manifest().channels.map((c) => [c.id, c.messages, c.after, c.through])).toEqual([
      ['dm1', 3, '0', '3'],
      ['dm2', 2, '0', '11'],
    ]);
    expect(sink.finalized).toBe(true);
  });

  it('downloads nothing and costs one request per channel when nothing is new', async () => {
    const discord = new FakeDiscord().add('dm1', 1, 3);
    const record = { ...dms([full('dm1', 1)]), cursors: { dm1: '3' } };
    const { deps, sink } = setup(discord);
    const result = await runSchedule(record, deps);

    expect(result.downloaded).toBe(false);
    expect(sink.names).toEqual([]);
    expect(result.changes.cursors).toEqual({});
    expect(result.summary.messages).toBe(0);
    expect(discord.callsFor('dm1')).toBe(1);
  });

  it('starts a "from now on" channel after the schedule began', async () => {
    const discord = new FakeDiscord();
    const record = dms([{ id: 'dm1', name: 'a', type: 1, start: { kind: 'now' } }]);
    const { deps } = setup(discord);
    await runSchedule(record, deps);
    expect(discord.calls[0].after).toBe(record.cursors.dm1);
    expect(BigInt(record.cursors.dm1)).toBeGreaterThan(0n);
  });

  describe('budgets', () => {
    it('stops a long channel at pagesPerChannel and asks for another run', async () => {
      const discord = new FakeDiscord().add('dm1', 1, 2500);
      const record = dms([full('dm1', 1)]);
      const first = setup(discord, { pagesPerChannel: 20 });
      const r1 = await runSchedule(record, first.deps);

      expect(r1.more).toBe(true);
      expect(r1.summary.messages).toBe(2000);
      expect(r1.changes.cursors.dm1).toBe('2000');
      expect(first.manifest().run.more).toBe(true);
      expect(first.events).toContainEqual({ type: 'backlog' });

      const second = setup(discord, { pagesPerChannel: 20 });
      const r2 = await runSchedule(applyRunResult(record, r1), second.deps);
      expect(r2.more).toBe(false);
      expect(r2.summary.messages).toBe(500);
      expect(second.ids('dm1_dm1/messages-0001.json')[0]).toBe(2001);
    });

    it('does not ask for another run when the last allowed page was short', async () => {
      const discord = new FakeDiscord().add('dm1', 1, 150);
      const { deps } = setup(discord, { pagesPerChannel: 2 });
      expect((await runSchedule(dms([full('dm1', 1)]), deps)).more).toBe(false);
    });

    it('checks every channel before a backlog uses up the run', async () => {
      const discord = new FakeDiscord().add('big', 1, 5000).add('small', 9000, 9001);
      const { deps } = setup(discord, { pagesPerChannel: 20, pagesPerRun: 21 });
      const result = await runSchedule(dms([full('big', 1), full('small', 1)]), deps);
      expect(result.changes.cursors).toEqual({ big: '2000', small: '9001' });
      expect(result.more).toBe(true);
    });

    it('stops at pagesPerRun and leaves the rest for the next run', async () => {
      const discord = new FakeDiscord().add('a', 1, 1000).add('b', 2000, 2999).add('c', 5000, 5000);
      const { deps } = setup(discord, { pagesPerChannel: 20, pagesPerRun: 12 });
      const result = await runSchedule(dms([full('a', 1), full('b', 1), full('c', 1)]), deps);
      expect(result.more).toBe(true);
      expect(result.changes.cursors).toEqual({ a: '1000', b: '2199' });
      expect(discord.callsFor('c')).toBe(0);
    });
  });

  describe('failures', () => {
    it('skips a failing channel and goes on with the rest', async () => {
      const discord = new FakeDiscord().add('dm1', 1, 3).add('dm2', 10, 11);
      discord.failures.set('dm1', new ApiFailure('403'));
      const { deps, manifest, events } = setup(discord);
      const result = await runSchedule(dms([full('dm1', 1, 'Alice'), full('dm2', 1)]), deps);

      expect(result.summary.skipped).toEqual(['dm1']);
      expect(result.changes.cursors).toEqual({ dm2: '11' });
      expect(manifest().skipped).toEqual([{ id: 'dm1', name: 'Alice', reason: '403' }]);
      expect(events).toContainEqual({ type: 'skipped', name: 'Alice', reason: '403' });
      expect(result.summary.stoppedBy).toBeUndefined();
    });

    it('keeps what a channel wrote before it failed mid-walk', async () => {
      const discord = new FakeDiscord().add('dm1', 1, 250);
      discord.failures.set('dm1', { afterCalls: 2, error: new ApiFailure('500') });
      const { deps, ids } = setup(discord);
      const result = await runSchedule(dms([full('dm1', 1)]), deps);

      expect(result.summary.skipped).toEqual(['dm1']);
      expect(result.changes.cursors.dm1).toBe('200');
      expect(ids('dm1_dm1/messages-0001.json')).toHaveLength(200);
    });

    it('stops the run and the schedule when the sign in expires, keeping what was written', async () => {
      const discord = new FakeDiscord().add('dm1', 1, 3).add('dm2', 10, 11);
      discord.failures.set('dm2', new SignInExpired());
      const record = dms([full('dm1', 1), full('dm2', 1), full('dm3', 1)]);
      const { deps, manifest } = setup(discord);
      const result = await runSchedule(record, deps);

      expect(result.summary.stoppedBy).toBe('signInExpired');
      expect(result.summary.skipped).toEqual([]);
      expect(result.changes.cursors).toEqual({ dm1: '3' });
      expect(discord.callsFor('dm3')).toBe(0);
      expect(manifest().run.stoppedBy).toBe('signInExpired');
      expect(applyRunResult(record, result).status).toBe('stopped');
    });

    it('stops on a rate-limit storm without counting it as a skip', async () => {
      const discord = new FakeDiscord().add('dm1', 1, 3).add('dm2', 10, 11);
      let stop: 'rateLimited' | null = null;
      discord.failures.set('dm2', { afterCalls: 0, error: new ApiFailure('429') });
      const { deps } = setup(discord, {
        stopReason: () => stop,
        listMessages: async (id, after) => {
          if (id === 'dm2') stop = 'rateLimited';
          return discord.listMessages(id, after);
        },
      });
      const record = dms([full('dm1', 1), full('dm2', 1)]);
      const result = await runSchedule(record, deps);

      expect(result.summary.stoppedBy).toBe('rateLimited');
      expect(result.summary.skipped).toEqual([]);
      expect(result.changes.cursors).toEqual({ dm1: '3' });
      expect(applyRunResult(record, result).status).toBe('stopped');
    });

    it('a cancel ends the run but leaves the schedule running', async () => {
      const discord = new FakeDiscord().add('dm1', 1, 3).add('dm2', 10, 11);
      let cancelled = false;
      const { deps } = setup(discord, {
        stopReason: () => (cancelled ? 'cancelled' : null),
        listMessages: async (id, after) => {
          const page = await discord.listMessages(id, after);
          cancelled = true;
          return page;
        },
      });
      const record = dms([full('dm1', 1), full('dm2', 1)]);
      const result = await runSchedule(record, deps);

      expect(result.summary.stoppedBy).toBeUndefined();
      expect(result.changes.cursors).toEqual({ dm1: '3' });
      expect(discord.callsFor('dm2')).toBe(0);
      expect(applyRunResult(record, result).status).toBe('running');
    });

    it('throws and saves nothing when the zip cannot be finished', async () => {
      const discord = new FakeDiscord().add('dm1', 1, 3);
      const { deps, sink } = setup(discord);
      sink.failFinalize = true;
      await expect(runSchedule(dms([full('dm1', 1)]), deps)).rejects.toThrow('download failed');
      expect(sink.cancelled).toBe(true);
    });

    it('waits while paused before each request', async () => {
      const discord = new FakeDiscord().add('dm1', 1, 150);
      const waitWhilePaused = vi.fn(async () => undefined);
      const { deps } = setup(discord, { waitWhilePaused });
      await runSchedule(dms([full('dm1', 1)]), deps);
      expect(waitWhilePaused).toHaveBeenCalledTimes(2);
    });
  });

  describe('threads', () => {
    const thread = (id: string, parentId: string, lastMessageId?: string): ScheduleThread => ({
      id, name: `thread ${id}`, parentId, ...(lastMessageId ? { lastMessageId } : {}),
    });

    it('lists all archived threads on a full-history channel\'s first run, then only recent ones', async () => {
      const discord = new FakeDiscord().add('c1', 1, 2).add('t1', 100, 101);
      discord.archived.set('c1', [thread('t1', 'c1', '101')]);
      const record = guild([full('c1')]);
      const first = setup(discord);
      const r1 = await runSchedule(record, first.deps);

      expect(discord.archivedCalls).toEqual([{ id: 'c1', all: true }]);
      expect(r1.changes.backfilled).toEqual(['c1']);
      expect(first.ids('c1_c1/threads/thread_t1_t1/messages-0001.json')).toEqual([100, 101]);
      expect(first.manifest().channels.find((c) => c.id === 't1')).toMatchObject({ kind: 'thread', parentId: 'c1' });

      discord.archivedCalls = [];
      await runSchedule(applyRunResult(record, r1), setup(discord).deps);
      expect(discord.archivedCalls).toEqual([{ id: 'c1', all: false }]);
    });

    it('never backfills a "from now on" channel', async () => {
      const discord = new FakeDiscord();
      const { deps } = setup(discord);
      await runSchedule(guild([{ id: 'c1', name: 'c1', type: 0, start: { kind: 'now' } }]), deps);
      expect(discord.archivedCalls).toEqual([{ id: 'c1', all: false }]);
    });

    it('finds threads among the server\'s active threads', async () => {
      const discord = new FakeDiscord().add('t1', 100, 100);
      discord.active = [thread('t1', 'c1', '100'), thread('t9', 'not-scheduled', '900')];
      const { deps } = setup(discord);
      const result = await runSchedule(guild([full('c1')]), deps);
      expect(discord.activeCalls).toBe(1);
      expect(result.changes.threads.map((t) => t.id)).toEqual(['t1']);
      expect(discord.callsFor('t9')).toBe(0);
    });

    it('costs no request for a thread with nothing new', async () => {
      const discord = new FakeDiscord().add('t1', 100, 101);
      discord.active = [thread('t1', 'c1', '101')];
      const record = { ...guild([full('c1')]), cursors: { c1: '0', t1: '101' } };
      const { deps } = setup(discord);
      await runSchedule(record, deps);
      expect(discord.callsFor('t1')).toBe(0);
    });

    it('moves a wiped thread\'s cursor up to its listed last message so it is not fetched every run', async () => {
      // The thread's last message (500) was deleted; Discord still lists it.
      const discord = new FakeDiscord().add('t1', 100, 101);
      discord.active = [thread('t1', 'c1', '500')];
      const record = guild([full('c1')]);
      const r1 = await runSchedule(record, setup(discord).deps);
      expect(r1.changes.cursors.t1).toBe('500');

      discord.calls = [];
      await runSchedule(applyRunResult(record, r1), setup(discord).deps);
      expect(discord.callsFor('t1')).toBe(0);
    });

    it('fetches the most recently active threads first', async () => {
      const discord = new FakeDiscord().add('t-old', 10, 10).add('t-new', 900, 900);
      discord.active = [thread('t-old', 'c1', '10'), thread('t-new', 'c1', '900')];
      const { deps } = setup(discord);
      await runSchedule(guild([full('c1')]), deps);
      const order = discord.calls.map((c) => c.channelId).filter((id) => id.startsWith('t-'));
      expect(order).toEqual(['t-new', 't-old']);
    });

    it('fetches only the posts of a forum, never the forum itself', async () => {
      const discord = new FakeDiscord().add('p1', 100, 102);
      discord.archived.set('f1', [thread('p1', 'f1', '102')]);
      const { deps, ids } = setup(discord);
      await runSchedule(guild([full('f1', 15, 'Help')]), deps);
      expect(discord.callsFor('f1')).toBe(0);
      expect(ids('help_f1/threads/thread_p1_p1/messages-0001.json')).toEqual([100, 101, 102]);
    });

    it('starts a new thread where its parent started', async () => {
      const discord = new FakeDiscord();
      discord.active = [thread('t1', 'c1', '999999999999999999999')];
      const record = guild([{ id: 'c1', name: 'c1', type: 0, start: { kind: 'date', date: '2026-01-01T00:00:00Z' } }]);
      await runSchedule(record, setup(discord).deps);
      expect(discord.calls.find((c) => c.channelId === 't1')?.after).toBe(record.cursors.c1);
    });

    it('does not look for threads in a DM schedule', async () => {
      const discord = new FakeDiscord();
      await runSchedule(dms([full('dm1', 1)]), setup(discord).deps);
      expect(discord.activeCalls).toBe(0);
      expect(discord.archivedCalls).toEqual([]);
    });

    it('skips a channel\'s threads when its archive listing fails, and backfills it next run', async () => {
      const discord = new FakeDiscord();
      const { deps } = setup(discord, {
        listArchivedThreads: async () => {
          throw new ApiFailure('403');
        },
      });
      const result = await runSchedule(guild([full('c1', 0, 'general')]), deps);
      expect(result.changes.backfilled).toEqual([]);
      expect(result.summary.skipped).toEqual(['c1']);
    });

    it('stops fetching threads at pagesPerRun', async () => {
      const discord = new FakeDiscord().add('t1', 100, 400).add('t2', 500, 500);
      discord.active = [thread('t1', 'c1', '400'), thread('t2', 'c1', '500')];
      // The parent has nothing, which uses no page; the newest thread uses the only one.
      const { deps } = setup(discord, { pagesPerRun: 1 });
      const result = await runSchedule(guild([full('c1')]), deps);
      expect(result.more).toBe(true);
      expect(discord.callsFor('t2')).toBe(1);
      expect(discord.callsFor('t1')).toBe(0);
      expect(result.changes.threads.map((t) => t.id).sort()).toEqual(['t1', 't2']);
    });
  });
});

describe('applyRunResult', () => {
  const record = dms([full('dm1', 1)]);
  const result = {
    changes: { cursors: { dm1: '50' }, threads: [], backfilled: [] },
    summary: { startedAt: 1, finishedAt: 2, messages: 50, skipped: [] },
    more: false,
    downloaded: true,
  };

  it('saves cursors, the summary and the run count', () => {
    const next = applyRunResult(record, result);
    expect(next.cursors.dm1).toBe('50');
    expect(next.lastRun).toEqual(result.summary);
    expect(next.runCount).toBe(1);
  });

  it('keeps a Stop made while the run went', () => {
    expect(applyRunResult({ ...record, status: 'stopped' }, result).status).toBe('stopped');
  });

  it('never moves a cursor backwards', () => {
    const ahead = { ...record, cursors: { dm1: '80' } };
    expect(applyRunResult(ahead, result).cursors.dm1).toBe('80');
  });
});

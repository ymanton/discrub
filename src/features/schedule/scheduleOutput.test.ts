import { describe, it, expect, vi } from 'vitest';
import {
  MANIFEST_FORMAT,
  RunOutput,
  channelFolder,
  runZipName,
  sanitizeName,
  threadFolder,
  type RunManifest,
  type RunSink,
} from './scheduleOutput';

const fakeSink = () => {
  const files = new Map<string, string>();
  const sink: RunSink & { files: Map<string, string>; finalized: boolean; cancelled: boolean } = {
    files,
    finalized: false,
    cancelled: false,
    addFile: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
    finalize: vi.fn(async () => {
      sink.finalized = true;
    }),
    cancel: vi.fn(async () => {
      sink.cancelled = true;
    }),
  };
  return sink;
};

const msgs = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ id: String(from + i), content: `m${from + i}` }));

const manifest = (): RunManifest => ({
  format: MANIFEST_FORMAT,
  version: 1,
  schedule: { id: 's1', name: 'Raid', scope: { kind: 'dms' } },
  run: { number: 1, startedAt: 'a', finishedAt: 'b', more: false },
  channels: [],
  skipped: [],
});

const entry = { id: 'c1', name: 'general', kind: 'channel' as const, type: 0, folder: 'general_c1', after: '0' };

describe('scheduleOutput', () => {
  describe('names', () => {
    it('sanitizes like Bulk Export folders', () => {
      expect(sanitizeName('Raid Night!! 2')).toBe('raid_night_2');
      expect(sanitizeName('日本語')).toBe('');
    });

    it('gives every channel folder its id', () => {
      expect(channelFolder('general', '123')).toBe('general_123');
      expect(channelFolder('日本語', '123')).toBe('channel_123');
    });

    it('puts threads inside their parent folder', () => {
      expect(threadFolder('general_123', 'Raid night', '456')).toBe('general_123/threads/raid_night_456');
      expect(threadFolder('general_123', '', '456')).toBe('general_123/threads/thread_456');
    });

    it('stamps the zip with the run start in local time', () => {
      const started = new Date(2026, 10, 11, 9, 5, 7).getTime();
      expect(runZipName('Raid server', started)).toBe('discrub-schedule_raid_server_2026-11-11_09-05-07');
      expect(runZipName('日本語', started)).toBe('discrub-schedule_2026-11-11_09-05-07');
    });

    it('only uses characters the download writer keeps', () => {
      expect(runZipName('a b/c:d', Date.now())).toMatch(/^[A-Za-z0-9._-]+$/);
    });
  });

  describe('RunOutput', () => {
    it('opens nothing and downloads nothing when no messages arrive', async () => {
      const open = vi.fn(fakeSink);
      const output = new RunOutput(open);
      const writer = output.channel(entry);
      await writer.add([]);
      expect(await writer.close()).toBeNull();
      expect(await output.finalize(manifest())).toBe(false);
      expect(open).not.toHaveBeenCalled();
    });

    it('splits a channel into numbered files of messagesPerFile', async () => {
      const sink = fakeSink();
      const output = new RunOutput(() => sink, 100);
      const writer = output.channel(entry);
      await writer.add(msgs(1, 100));
      await writer.add(msgs(101, 200));
      await writer.add(msgs(201, 250));
      const summary = await writer.close();

      expect([...sink.files.keys()]).toEqual([
        'general_c1/messages-0001.json',
        'general_c1/messages-0002.json',
        'general_c1/messages-0003.json',
      ]);
      expect(JSON.parse(sink.files.get('general_c1/messages-0003.json')!)).toHaveLength(50);
      expect(summary).toEqual({
        ...entry,
        files: ['general_c1/messages-0001.json', 'general_c1/messages-0002.json', 'general_c1/messages-0003.json'],
        messages: 250,
        through: '250',
      });
    });

    it('writes full files as soon as they fill, before close', async () => {
      const sink = fakeSink();
      const output = new RunOutput(() => sink, 100);
      const writer = output.channel(entry);
      await writer.add(msgs(1, 150));
      expect([...sink.files.keys()]).toEqual(['general_c1/messages-0001.json']);
      expect(writer.through).toBe('150');
    });

    it('keeps message order and content', async () => {
      const sink = fakeSink();
      const output = new RunOutput(() => sink);
      const writer = output.channel(entry);
      await writer.add(msgs(1, 3));
      await writer.close();
      expect(JSON.parse(sink.files.get('general_c1/messages-0001.json')!)).toEqual(msgs(1, 3));
    });

    it('reports the starting cursor as through when nothing was added', () => {
      const output = new RunOutput(fakeSink);
      expect(output.channel({ ...entry, after: '77' }).through).toBe('77');
    });

    it('adds the manifest last and finalizes', async () => {
      const sink = fakeSink();
      const output = new RunOutput(() => sink);
      const writer = output.channel(entry);
      await writer.add(msgs(1, 2));
      await writer.close();
      expect(await output.finalize(manifest())).toBe(true);

      expect([...sink.files.keys()].at(-1)).toBe('manifest.json');
      expect(JSON.parse(sink.files.get('manifest.json')!).format).toBe(MANIFEST_FORMAT);
      expect(sink.finalized).toBe(true);
    });

    it('opens one sink for every channel in the run', async () => {
      const open = vi.fn(fakeSink);
      const output = new RunOutput(open);
      const a = output.channel(entry);
      const b = output.channel({ ...entry, id: 'c2', folder: 'other_c2' });
      await a.add(msgs(1, 1));
      await b.add(msgs(2, 2));
      await a.close();
      await b.close();
      expect(open).toHaveBeenCalledTimes(1);
      expect(output.opened).toBe(true);
    });

    it('cancels an opened sink', async () => {
      const sink = fakeSink();
      const output = new RunOutput(() => sink);
      const writer = output.channel(entry);
      await writer.add(msgs(1, 1));
      await writer.close();
      await output.cancel();
      expect(sink.cancelled).toBe(true);
    });

    it('cancel without a sink does nothing', async () => {
      const open = vi.fn(fakeSink);
      await new RunOutput(open).cancel();
      expect(open).not.toHaveBeenCalled();
    });
  });
});

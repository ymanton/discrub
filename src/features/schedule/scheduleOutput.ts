import type { ScheduleScope, ScheduleRunSummary } from './scheduleTypes';

/**
 * The zip a scheduled run downloads. Each channel and thread gets a folder
 * of JSON files holding the run's new messages, oldest first, at most
 * `messagesPerFile` to a file:
 *
 *   manifest.json
 *   general_123/messages-0001.json
 *   general_123/threads/raid-night_456/messages-0001.json
 *
 * The zip opens on the first message, so a run with nothing new downloads
 * nothing. manifest.json goes in last and says what the run covered.
 */

/** Where the zip's bytes go. The real one is a StreamingZipService. */
export interface RunSink {
  addFile(path: string, content: string): Promise<void>;
  finalize(): Promise<void>;
  cancel(): Promise<void>;
}

export const MESSAGES_PER_FILE = 1000;

export const MANIFEST_FORMAT = 'discrub-scheduled-export';

/** One channel or thread in the manifest. */
export interface ManifestChannel {
  id: string;
  name: string;
  kind: 'channel' | 'thread';
  /** Discord channel type, for channels; threads carry their parent instead. */
  type?: number;
  parentId?: string;
  folder: string;
  files: string[];
  messages: number;
  /** Cursor the run fetched after. */
  after: string;
  /** Newest message id in this run's files. */
  through: string;
}

export interface ManifestSkip {
  id: string;
  name: string;
  /** HTTP status, or `network` when no answer came back. */
  reason: string;
}

export interface RunManifest {
  format: typeof MANIFEST_FORMAT;
  version: 1;
  schedule: { id: string; name: string; scope: ScheduleScope };
  run: {
    number: number;
    startedAt: string;
    finishedAt: string;
    /** Another run follows straight away because a backlog is left. */
    more: boolean;
    stoppedBy?: ScheduleRunSummary['stoppedBy'];
  };
  channels: ManifestChannel[];
  skipped: ManifestSkip[];
}

/** Letters and digits, lower case, other runs of characters as one underscore. Same rule as Bulk Export folders. */
export const sanitizeName = (name: string): string =>
  name.replace(/[^a-z0-9]/gi, '_').toLowerCase().replace(/_+/g, '_').replace(/^_|_$/g, '');

/** A channel's folder. The id keeps it unique and the same from run to run. */
export const channelFolder = (name: string, id: string): string => `${sanitizeName(name) || 'channel'}_${id}`;

/** A thread's folder, inside its parent's. */
export const threadFolder = (parentFolder: string, name: string, id: string): string =>
  `${parentFolder}/threads/${sanitizeName(name) || 'thread'}_${id}`;

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** `discrub-schedule_raid_2026-11-11_10-00-00`, local time. */
export const runZipName = (scheduleName: string, startedAt: number): string => {
  const d = new Date(startedAt);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const name = sanitizeName(scheduleName);
  return name ? `discrub-schedule_${name}_${stamp}` : `discrub-schedule_${stamp}`;
};

/** Writes one channel's or thread's messages into numbered files. */
export class ChannelWriter<T extends { id: string }> {
  private buffer: T[] = [];
  private fileCount = 0;
  private count = 0;
  private newest: string;
  readonly files: string[] = [];

  constructor(
    private readonly output: RunOutput,
    readonly entry: Omit<ManifestChannel, 'files' | 'messages' | 'through'>,
  ) {
    this.newest = entry.after;
  }

  get messages(): number {
    return this.count;
  }

  /** Newest id written or buffered so far; the cursor to save. */
  get through(): string {
    return this.newest;
  }

  /** Adds a page, oldest first. Full files go to the zip right away. */
  async add(page: readonly T[]): Promise<void> {
    if (page.length === 0) return;
    this.buffer.push(...page);
    this.count += page.length;
    this.newest = page[page.length - 1].id;
    while (this.buffer.length >= this.output.messagesPerFile) {
      await this.flush(this.buffer.splice(0, this.output.messagesPerFile));
    }
  }

  /** Writes what is left. Returns the manifest entry, or null when nothing was written. */
  async close(): Promise<ManifestChannel | null> {
    if (this.buffer.length > 0) await this.flush(this.buffer.splice(0));
    if (this.count === 0) return null;
    return { ...this.entry, files: [...this.files], messages: this.count, through: this.newest };
  }

  private async flush(messages: T[]): Promise<void> {
    this.fileCount += 1;
    const path = `${this.entry.folder}/messages-${pad(this.fileCount, 4)}.json`;
    await this.output.write(path, JSON.stringify(messages, null, 2));
    this.files.push(path);
  }
}

/** The zip of one run. */
export class RunOutput {
  private sink: RunSink | null = null;

  constructor(
    private readonly openSink: () => RunSink,
    readonly messagesPerFile: number = MESSAGES_PER_FILE,
  ) {}

  /** True once anything has been written, so the run downloads a zip. */
  get opened(): boolean {
    return this.sink !== null;
  }

  channel<T extends { id: string }>(entry: Omit<ManifestChannel, 'files' | 'messages' | 'through'>): ChannelWriter<T> {
    return new ChannelWriter<T>(this, entry);
  }

  /** @internal Used by ChannelWriter. */
  async write(path: string, content: string): Promise<void> {
    if (!this.sink) this.sink = this.openSink();
    await this.sink.addFile(path, content);
  }

  /**
   * Adds the manifest and completes the download. Returns false, with
   * nothing downloaded, when the run wrote no messages.
   */
  async finalize(manifest: RunManifest): Promise<boolean> {
    if (!this.sink) return false;
    await this.sink.addFile('manifest.json', JSON.stringify(manifest, null, 2));
    await this.sink.finalize();
    return true;
  }

  async cancel(): Promise<void> {
    if (this.sink) await this.sink.cancel();
  }
}

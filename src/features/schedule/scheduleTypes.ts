import type { StartPoint } from './scheduleCursor';

/** What a schedule covers: one server's channels, or a set of DMs. */
export type ScheduleScope =
  | { kind: 'guild'; guildId: string; guildName: string }
  | { kind: 'dms' };

/** A channel or DM picked for a schedule. */
export interface ScheduleTarget {
  id: string;
  name: string;
  /** Discord channel type. Forum and media parents (15, 16) only have threads. */
  type: number;
  /** Where this channel's export starts. Its threads start at the same point. */
  start: StartPoint;
}

/** A thread found under a scheduled channel. */
export interface ScheduleThread {
  id: string;
  name: string;
  parentId: string;
  /** Newest message id Discord last reported for the thread. A thread whose cursor is here has nothing new. */
  lastMessageId?: string;
}

export type ScheduleStatus = 'running' | 'stopped';

/** What the last run did, for the status bar and the log. */
export interface ScheduleRunSummary {
  startedAt: number;
  finishedAt: number;
  /** New messages written, all channels and threads together. */
  messages: number;
  /** Ids of channels or threads skipped this run (they retry next run). */
  skipped: string[];
  /** Set when the run stopped the schedule (sign-in expired, rate limited). */
  stoppedBy?: 'signInExpired' | 'rateLimited';
}

/**
 * A schedule, as stored. Holds no messages: each run downloads what it
 * fetched, and the record keeps only where every channel and thread is up to.
 */
export interface ScheduleRecord {
  /** Record format, bumped when the shape changes. */
  version: 1;
  id: string;
  name: string;
  /** Account the schedule belongs to; it never runs for another. */
  userId: string;
  scope: ScheduleScope;
  intervalMinutes: number;
  targets: ScheduleTarget[];
  /** Threads found so far, by id. */
  threads: Record<string, ScheduleThread>;
  /**
   * Targets whose archived threads have all been listed once. A target that
   * starts from the full history or a date lists them on its first run; a
   * "from now on" target never needs to.
   */
  threadsBackfilled: string[];
  /** `after` cursor of every target and thread, by channel id. */
  cursors: Record<string, string>;
  status: ScheduleStatus;
  createdAt: number;
  /** When the next run is due (ms). A new schedule runs straight away. */
  nextRunAt: number;
  lastRun: ScheduleRunSummary | null;
  runCount: number;
}

/** What the setup dialog hands over to make a schedule. */
export interface NewScheduleInput {
  name: string;
  userId: string;
  scope: ScheduleScope;
  intervalMinutes: number;
  targets: ScheduleTarget[];
}

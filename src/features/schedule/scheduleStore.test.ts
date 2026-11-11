import { describe, it, expect, beforeEach } from 'vitest';
import { createSchedule, withCursor } from './scheduleRecord';
import {
  clearSchedules,
  deleteSchedule,
  getSchedule,
  listSchedules,
  saveSchedule,
  updateSchedule,
} from './scheduleStore';
import type { ScheduleRecord } from './scheduleTypes';

const make = (id: string, createdAt: number): ScheduleRecord =>
  createSchedule(
    {
      name: id,
      userId: 'u1',
      scope: { kind: 'dms' },
      intervalMinutes: 60,
      targets: [{ id: 'dm1', name: 'friend', type: 1, start: { kind: 'full' } }],
    },
    id,
    createdAt,
  );

describe('scheduleStore', () => {
  beforeEach(async () => {
    await clearSchedules();
  });

  it('saves and reads a schedule', async () => {
    const record = make('s1', 1);
    await saveSchedule(record);
    expect(await getSchedule('s1')).toEqual(record);
  });

  it('returns null for a missing schedule', async () => {
    expect(await getSchedule('missing')).toBeNull();
  });

  it('lists schedules oldest first', async () => {
    await saveSchedule(make('newer', 20));
    await saveSchedule(make('older', 10));
    expect((await listSchedules()).map((s) => s.id)).toEqual(['older', 'newer']);
  });

  it('updates a schedule in place', async () => {
    await saveSchedule(make('s1', 1));
    const saved = await updateSchedule('s1', (r) => withCursor(r, 'dm1', '77'));
    expect(saved?.cursors.dm1).toBe('77');
    expect((await getSchedule('s1'))?.cursors.dm1).toBe('77');
  });

  it('writes nothing when the schedule is gone', async () => {
    expect(await updateSchedule('missing', (r) => ({ ...r, name: 'x' }))).toBeNull();
    expect(await getSchedule('missing')).toBeNull();
  });

  it('runs concurrent updates one after another so none is lost', async () => {
    await saveSchedule(make('s1', 1));
    await Promise.all([
      updateSchedule('s1', (r) => withCursor(r, 'dm1', '10')),
      updateSchedule('s1', (r) => ({ ...r, status: 'stopped' })),
      updateSchedule('s1', (r) => withCursor(r, 'dm1', '20')),
    ]);
    const saved = await getSchedule('s1');
    expect(saved?.status).toBe('stopped');
    expect(saved?.cursors.dm1).toBe('20');
  });

  it('keeps going after an update throws', async () => {
    await saveSchedule(make('s1', 1));
    const failed = updateSchedule('s1', () => {
      throw new Error('boom');
    });
    const next = updateSchedule('s1', (r) => ({ ...r, name: 'after' }));
    await expect(failed).rejects.toThrow('boom');
    expect((await next)?.name).toBe('after');
  });

  it('deletes one schedule', async () => {
    await saveSchedule(make('s1', 1));
    await saveSchedule(make('s2', 2));
    await deleteSchedule('s1');
    expect((await listSchedules()).map((s) => s.id)).toEqual(['s2']);
  });

  it('clears every schedule', async () => {
    await saveSchedule(make('s1', 1));
    await saveSchedule(make('s2', 2));
    await clearSchedules();
    expect(await listSchedules()).toEqual([]);
  });
});

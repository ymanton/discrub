import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { Schedule as ScheduleIcon } from '@mui/icons-material';
import type { Channel } from 'discrub-core/types/discord-types';
import { useTranslation } from 'react-i18next';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import DialogCloseIcon from '@components/ui/DialogCloseIcon';
import SelectedChannelsPill from '@components/dialogs/SelectedChannelsPill';
import { selectCurrentUser } from '@features/user/userSlice';
import { showToast } from '@features/status/statusSlice';
import { dmExportName } from '@features/export/exportSlice';
import { addSchedule, selectSchedules } from '@features/schedule/scheduleSlice';
import { requestNotificationPermission } from '@features/schedule/scheduleNotify';
import { scheduleIntervalOptions } from '@features/schedule/scheduleIntervals';
import type { StartPoint } from '@features/schedule/scheduleCursor';
import type { ScheduleScope, ScheduleTarget } from '@features/schedule/scheduleTypes';
import ScheduleList from './ScheduleList';
import { DEFAULT_INTERVAL, SCHEDULE_INTERVALS, intervalLabel } from './scheduleLabels';

type StartKind = StartPoint['kind'];

interface ChannelStart {
  kind: StartKind;
  /** yyyy-mm-dd, local, when kind is 'date'. */
  date: string;
}

export interface ScheduleExportDialogProps {
  open: boolean;
  onClose: () => void;
  channels: Channel[];
  mode: 'channels' | 'dms';
  /** The server, in channels mode. */
  guild?: { id: string; name: string } | null;
}

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A yyyy-mm-dd date as the ISO time of that local midnight, or null when invalid. */
export const localDateToIso = (value: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const toStartPoint = (start: ChannelStart): StartPoint | null => {
  if (start.kind !== 'date') return { kind: start.kind };
  const iso = localDateToIso(start.date);
  return iso ? { kind: 'date', date: iso } : null;
};

/**
 * Sets up a scheduled export of the channels or DMs picked in multi-select:
 * a name, how often it runs, and where each channel starts (full history,
 * from now on, or a date). Below it, the schedules that already exist.
 * Opened with nothing selected, it shows only that list, so every layout
 * can reach it from the multi-select bar.
 */
const ScheduleExportDialog = ({ open, onClose, channels, mode, guild }: ScheduleExportDialogProps) => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const user = useAppSelector(selectCurrentUser);
  const hasSchedules = useAppSelector(selectSchedules).length > 0;
  const isDm = mode === 'dms';
  const listOnly = channels.length === 0;

  const defaultName = isDm ? t('schedule.dmsName') : guild?.name ?? '';
  const [name, setName] = useState(defaultName);
  const [interval, setIntervalMinutes] = useState<number>(DEFAULT_INTERVAL);
  const [starts, setStarts] = useState<Record<string, ChannelStart>>({});
  const [saving, setSaving] = useState(false);

  // A fresh form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName(defaultName);
    setIntervalMinutes(DEFAULT_INTERVAL);
    setStarts(Object.fromEntries(channels.map((c) => [c.id, { kind: 'now' as StartKind, date: today() }])));
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const intervals = useMemo(() => scheduleIntervalOptions(SCHEDULE_INTERVALS), []);
  const startOf = (id: string): ChannelStart => starts[id] ?? { kind: 'now', date: today() };
  const setStart = (id: string, change: Partial<ChannelStart>) =>
    setStarts((prev) => ({ ...prev, [id]: { ...startOf(id), ...prev[id], ...change } }));
  const setAll = (kind: StartKind) =>
    setStarts((prev) => Object.fromEntries(channels.map((c) => [c.id, { ...(prev[c.id] ?? { date: today() }), kind }])));

  const labelOf = (channel: Channel): string =>
    isDm ? dmExportName(channel) : channel.name || `channel-${channel.id}`;

  const targets: ScheduleTarget[] | null = (() => {
    const list: ScheduleTarget[] = [];
    for (const channel of channels) {
      const start = toStartPoint(startOf(channel.id));
      if (!start) return null;
      list.push({ id: channel.id, name: labelOf(channel), type: Number(channel.type ?? 0), start });
    }
    return list;
  })();

  const scope: ScheduleScope | null = isDm
    ? { kind: 'dms' }
    : guild ? { kind: 'guild', guildId: guild.id, guildName: guild.name } : null;
  const canCreate = !!user && !!scope && !!targets && targets.length > 0 && name.trim().length > 0 && !saving;

  const handleCreate = async () => {
    if (!canCreate || !user || !scope || !targets) return;
    setSaving(true);
    // Asked from this click: browsers ignore a permission request without one.
    await requestNotificationPermission();
    try {
      const record = await dispatch(addSchedule({
        name: name.trim(),
        userId: user.id,
        scope,
        intervalMinutes: interval,
        targets,
      })).unwrap();
      dispatch(showToast({ level: 'success', message: t('schedule.created', { name: record.name }) }));
      onClose();
    } catch (error) {
      dispatch(showToast({ level: 'error', message: error instanceof Error ? error.message : String(error) }));
      setSaving(false);
    }
  };

  const startLabels: Record<StartKind, string> = {
    full: t('schedule.startFull'),
    now: t('schedule.startNow'),
    date: t('schedule.startDate'),
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-testid="schedule-export-dialog">
      <DialogTitle sx={{ pr: 5 }}>
        {listOnly ? t('schedule.listTitle') : t('schedule.title')}
        <DialogCloseIcon onClose={onClose} />
      </DialogTitle>
      <DialogContent>
        {listOnly ? <ScheduleList /> : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: 1 }}>
          <SelectedChannelsPill channels={channels} mode={isDm ? 'dms' : 'channels'} />

          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <TextField
              label={t('schedule.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              size="small"
              sx={{ flex: '1 1 14rem' }}
              inputProps={{ 'data-testid': 'schedule-name' }}
            />
            <TextField
              select
              label={t('schedule.interval')}
              value={interval}
              onChange={(e) => setIntervalMinutes(Number(e.target.value))}
              size="small"
              sx={{ flex: '1 1 10rem' }}
              SelectProps={{ SelectDisplayProps: { 'data-testid': 'schedule-interval' } as never }}
            >
              {intervals.map((minutes) => (
                <MenuItem key={minutes} value={minutes}>{intervalLabel(t, minutes)}</MenuItem>
              ))}
            </TextField>
          </Box>

          <Box>
            <TextField
              select
              label={t('schedule.startAll')}
              value=""
              onChange={(e) => setAll(e.target.value as StartKind)}
              size="small"
              fullWidth
              SelectProps={{ displayEmpty: true, SelectDisplayProps: { 'data-testid': 'schedule-start-all' } as never }}
            >
              <MenuItem value="" disabled sx={{ display: 'none' }} />
              {(Object.keys(startLabels) as StartKind[]).map((kind) => (
                <MenuItem key={kind} value={kind}>{startLabels[kind]}</MenuItem>
              ))}
            </TextField>
            <Box
              sx={{ mt: 1.5, maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}
              data-testid="schedule-channel-starts"
            >
              {channels.map((channel) => {
                const start = startOf(channel.id);
                const dateInvalid = start.kind === 'date' && !localDateToIso(start.date);
                return (
                  <Box key={channel.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography variant="body2" noWrap sx={{ flex: '1 1 8rem', minWidth: 0 }}>
                      {isDm ? labelOf(channel) : `# ${labelOf(channel)}`}
                    </Typography>
                    <TextField
                      select
                      value={start.kind}
                      onChange={(e) => setStart(channel.id, { kind: e.target.value as StartKind })}
                      size="small"
                      sx={{ width: '11rem' }}
                      inputProps={{ 'aria-label': `${t('schedule.startFrom')}: ${labelOf(channel)}` }}
                      SelectProps={{ SelectDisplayProps: { 'data-testid': `schedule-start-${channel.id}` } as never }}
                    >
                      {(Object.keys(startLabels) as StartKind[]).map((kind) => (
                        <MenuItem key={kind} value={kind}>{startLabels[kind]}</MenuItem>
                      ))}
                    </TextField>
                    {start.kind === 'date' && (
                      <TextField
                        type="date"
                        size="small"
                        value={start.date}
                        error={dateInvalid}
                        onChange={(e) => setStart(channel.id, { date: e.target.value })}
                        sx={{ width: '10rem' }}
                        inputProps={{ 'aria-label': `${t('schedule.startDateLabel')}: ${labelOf(channel)}`, 'data-testid': `schedule-date-${channel.id}` }}
                      />
                    )}
                  </Box>
                );
              })}
            </Box>
          </Box>

          <Alert severity="info" variant="outlined" sx={{ py: 0.5 }}>
            <Typography variant="body2">{t('schedule.howItWorks')}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{t('schedule.keepOpen')}</Typography>
          </Alert>

          {hasSchedules && (
            <>
              <Divider />
              <Typography variant="subtitle2">{t('schedule.listTitle')}</Typography>
              <ScheduleList />
            </>
          )}
        </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" onClick={onClose}>{listOnly ? t('schedule.close') : t('schedule.cancel')}</Button>
        {!listOnly && (
        <Button
          variant="contained"
          startIcon={<ScheduleIcon />}
          onClick={() => void handleCreate()}
          disabled={!canCreate}
          data-testid="schedule-create"
        >
          {t('schedule.create')}
        </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};

export default ScheduleExportDialog;

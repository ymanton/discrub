import { useState } from 'react';
import { Box, Button, Chip, Stack, Typography } from '@mui/material';
import {
  DeleteOutline as DeleteIcon,
  PlayArrow as StartIcon,
  Stop as StopIcon,
} from '@mui/icons-material';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { DiscrubSetting } from 'discrub-core/discrub-enum';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { selectSettings } from '@features/app/appSlice';
import { getDateLocale } from '@/i18n/dateLocale';
import {
  removeSchedule,
  resumeSchedule,
  selectActiveScheduleRun,
  selectSchedules,
  stopSchedule,
} from '@features/schedule/scheduleSlice';
import type { ScheduleRecord } from '@features/schedule/scheduleTypes';
import { intervalLabel } from './scheduleLabels';

/**
 * The account's scheduled exports, with Stop, Start and Delete. Shown in the
 * Scheduled exports dialog and under the schedule setup dialog.
 */
const ScheduleList = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const schedules = useAppSelector(selectSchedules);
  const activeRun = useAppSelector(selectActiveScheduleRun);
  const settings = useAppSelector(selectSettings);
  const timeFormat = settings?.[DiscrubSetting.TIME_FORMAT] || 'h:mm aa';
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const stamp = (ms: number): string => {
    try {
      return format(new Date(ms), `PP ${timeFormat}`, { locale: getDateLocale() });
    } catch {
      return new Date(ms).toLocaleString();
    }
  };

  if (schedules.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" data-testid="schedule-list-empty">
        {t('schedule.empty')}
      </Typography>
    );
  }

  const lastRunLine = (record: ScheduleRecord): string => {
    const last = record.lastRun;
    if (!last) return t('schedule.neverRun');
    if (last.stoppedBy === 'signInExpired') return t('schedule.stoppedSignIn');
    if (last.stoppedBy === 'rateLimited') return t('schedule.stoppedRateLimited');
    const parts = [last.messages > 0 ? t('schedule.lastRunMessages', { count: last.messages }) : t('schedule.lastRunNothing')];
    if (last.skipped.length > 0) parts.push(t('schedule.lastRunSkipped', { count: last.skipped.length }));
    return t('schedule.lastRun', { time: stamp(last.finishedAt), result: parts.join(', ') });
  };

  return (
    <Stack spacing={1.5} data-testid="schedule-list">
      {schedules.map((record) => {
        const runningNow = activeRun?.id === record.id;
        const running = record.status === 'running';
        const scope = record.scope.kind === 'guild' ? record.scope.guildName : t('schedule.dmsName');
        const count = record.scope.kind === 'guild'
          ? t('schedule.channelCount', { count: record.targets.length })
          : t('schedule.dmCount', { count: record.targets.length });
        return (
          <Box
            key={record.id}
            data-testid={`schedule-row-${record.id}`}
            sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{record.name}</Typography>
              <Chip
                size="small"
                label={runningNow ? t('schedule.statusRunningNow') : running ? t('schedule.statusRunning') : t('schedule.statusStopped')}
                color={runningNow ? 'primary' : running ? 'success' : 'default'}
                variant={runningNow ? 'filled' : 'outlined'}
                data-testid="schedule-status"
              />
            </Box>
            <Typography variant="caption" color="text.secondary" component="div">
              {scope} · {count} · {intervalLabel(t, record.intervalMinutes)}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="div" data-testid="schedule-last-run">
              {lastRunLine(record)}
            </Typography>
            {running && !runningNow && (
              <Typography variant="caption" color="text.secondary" component="div" data-testid="schedule-next-run">
                {record.nextRunAt <= Date.now() ? t('schedule.nextRunSoon') : t('schedule.nextRun', { time: stamp(record.nextRunAt) })}
              </Typography>
            )}

            {confirmDelete === record.id ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, flexWrap: 'wrap' }}>
                <Typography variant="body2">{t('schedule.deleteConfirm')}</Typography>
                <Button
                  size="small"
                  color="error"
                  variant="contained"
                  onClick={() => { setConfirmDelete(null); void dispatch(removeSchedule({ id: record.id })); }}
                  data-testid="schedule-delete-yes"
                  sx={{ textTransform: 'none' }}
                >
                  {t('schedule.deleteYes')}
                </Button>
                <Button size="small" onClick={() => setConfirmDelete(null)} sx={{ textTransform: 'none' }}>
                  {t('schedule.deleteNo')}
                </Button>
              </Box>
            ) : (
              <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
                {running ? (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<StopIcon fontSize="small" />}
                    onClick={() => void dispatch(stopSchedule({ id: record.id }))}
                    data-testid="schedule-stop"
                    sx={{ textTransform: 'none' }}
                  >
                    {t('schedule.stop')}
                  </Button>
                ) : (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<StartIcon fontSize="small" />}
                    onClick={() => void dispatch(resumeSchedule({ id: record.id }))}
                    data-testid="schedule-resume"
                    sx={{ textTransform: 'none' }}
                  >
                    {t('schedule.resume')}
                  </Button>
                )}
                <Button
                  size="small"
                  color="inherit"
                  startIcon={<DeleteIcon fontSize="small" />}
                  onClick={() => setConfirmDelete(record.id)}
                  data-testid="schedule-delete"
                  sx={{ textTransform: 'none' }}
                >
                  {t('schedule.delete')}
                </Button>
              </Box>
            )}
          </Box>
        );
      })}
    </Stack>
  );
};

export default ScheduleList;

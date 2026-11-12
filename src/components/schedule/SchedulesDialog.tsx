import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import { useTranslation } from 'react-i18next';
import DialogCloseIcon from '@components/ui/DialogCloseIcon';
import ScheduleList from './ScheduleList';

/** The Scheduled exports list on its own, opened from the More menu (`schedules` dialog flag). */
const SchedulesDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-testid="schedules-dialog">
      <DialogTitle sx={{ pr: 5 }}>
        {t('schedule.listTitle')}
        <DialogCloseIcon onClose={onClose} />
      </DialogTitle>
      <DialogContent>
        <ScheduleList />
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" onClick={onClose}>{t('schedule.close')}</Button>
      </DialogActions>
    </Dialog>
  );
};

export default SchedulesDialog;

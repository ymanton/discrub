import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { selectDialogOpen, setDialogOpen, toggleDialog } from '@features/app/appSlice';
import { useHotkey } from '@features/hotkeys/HotkeyProvider';
import SettingsModal from '@components/settings/SettingsModal';
import SchedulesDialog from '@components/schedule/SchedulesDialog';

/**
 * App-wide dialogs that every layout shares (2.2.0). Mounted once by
 * MainLayout, outside any shell, so they survive a layout swap and no shell
 * has to remember them. Settings opens from the store. Supporter access
 * lives in the Appearance popover, not in a dialog. Scheduled exports opens
 * from the store too, so any layout can show it.
 */
const AppDialogs = () => {
  const dispatch = useAppDispatch();
  const settingsOpen = useAppSelector(selectDialogOpen('settings'));
  const schedulesOpen = useAppSelector(selectDialogOpen('schedules'));
  useHotkey('openSettings', () => dispatch(toggleDialog('settings')), true);
  return (
    <>
      <SettingsModal open={settingsOpen} onClose={() => dispatch(setDialogOpen({ dialog: 'settings', open: false }))} />
      <SchedulesDialog open={schedulesOpen} onClose={() => dispatch(setDialogOpen({ dialog: 'schedules', open: false }))} />
    </>
  );
};

export default AppDialogs;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockDispatch = vi.fn();
const mockClearSchedules = vi.fn(() => Promise.resolve());

vi.mock('@/app/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: () => [],
}));

vi.mock('@features/workspace/workspaceThunks', () => ({
  clearAllWorkspaces: () => ({ type: 'workspace/clearAll' }),
}));

vi.mock('@features/schedule/scheduleStore', () => ({
  clearSchedules: () => mockClearSchedules(),
}));

vi.mock('@features/schedule/scheduleSlice', () => ({
  clearScheduleState: () => ({ type: 'schedule/clearScheduleState' }),
}));

import { useSignOut } from './useSignOut';

describe('useSignOut', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
    mockClearSchedules.mockClear();
  });

  it('clears workspaces and scheduled exports on sign out', () => {
    const { result } = renderHook(() => useSignOut());
    act(() => result.current.signOut());
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'workspace/clearAll' });
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'schedule/clearScheduleState' });
    expect(mockClearSchedules).toHaveBeenCalledTimes(1);
  });

  it('still signs out when clearing schedules fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockClearSchedules.mockImplementationOnce(() => Promise.reject(new Error('idb gone')));
    const { result } = renderHook(() => useSignOut());
    act(() => result.current.signOut());
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'workspace/clearAll' });
    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith('[schedule] could not clear schedules', expect.any(Error)),
    );
    consoleError.mockRestore();
  });
});

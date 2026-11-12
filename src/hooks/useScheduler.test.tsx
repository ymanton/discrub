import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import type { ReactNode } from 'react';
import type { LoopDeps } from '@features/schedule/scheduleLoop';

const stop = vi.fn();
let started: LoopDeps[] = [];
vi.mock('@features/schedule/scheduleLoop', () => ({
  startScheduleLoop: (deps: LoopDeps) => {
    started.push(deps);
    return { stop, done: Promise.resolve() };
  },
}));

import authReducer, { clearToken } from '@features/auth/authSlice';
import userReducer from '@features/user/userSlice';
import appReducer from '@features/app/appSlice';
import statusReducer from '@features/status/statusSlice';
import scheduleReducer, { scheduleRunStarted } from '@features/schedule/scheduleSlice';
import { createBaseState } from '@/test/state-factories';
import { useScheduler } from './useScheduler';

const makeStore = (signedIn: boolean) => {
  const base = createBaseState();
  return configureStore({
    reducer: { auth: authReducer, user: userReducer, app: appReducer, status: statusReducer, schedule: scheduleReducer,
      export: (s = base.export) => s, message: (s = base.message) => s, purge: (s = base.purge) => s,
      channel: (s = base.channel) => s, guild: (s = base.guild) => s, dm: (s = base.dm) => s,
      package: (s = base.package) => s, dev: (s = base.dev) => s },
    preloadedState: signedIn
      ? ({
        auth: { ...base.auth, token: 't', isAuthenticated: true },
        user: { ...base.user, currentUser: { id: 'u1', username: 'me' } },
      } as never)
      : undefined,
  });
};

const render = (store: ReturnType<typeof makeStore>) =>
  renderHook(() => useScheduler(), {
    wrapper: ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>,
  });

describe('useScheduler', () => {
  beforeEach(() => {
    started = [];
    stop.mockClear();
  });

  it('does not start while signed out', () => {
    render(makeStore(false));
    expect(started).toHaveLength(0);
  });

  it('starts the scheduler when signed in and stops it on sign out', () => {
    const store = makeStore(true);
    const { rerender } = render(store);
    expect(started).toHaveLength(1);
    expect(started[0].userId()).toBe('u1');

    store.dispatch(clearToken());
    rerender();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(1);
  });

  it('is busy while a scheduled run is going', () => {
    const store = makeStore(true);
    render(store);
    expect(started[0].isBusy()).toBe(false);
    store.dispatch(scheduleRunStarted({ id: 's1', name: 'x', startedAt: 0 }));
    expect(started[0].isBusy()).toBe(true);
  });

  it('stops when unmounted', () => {
    const { unmount } = render(makeStore(true));
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

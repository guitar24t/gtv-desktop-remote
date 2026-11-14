import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandDispatchRequest } from '../../../shared/types';
import { useRemoteSession } from '../useRemoteSession';

interface Deferred {
  request: CommandDispatchRequest;
  resolve: () => void;
  reject: (error: Error) => void;
}

function stubBridge() {
  const pending: Deferred[] = [];
  const sendCommand = vi.fn(
    (request: CommandDispatchRequest) =>
      new Promise<void>((resolve, reject) => {
        pending.push({ request, resolve, reject });
      })
  );
  vi.stubGlobal('gtvRemote', { sendCommand, recordCommandDrop: vi.fn() });
  return { sendCommand, pending };
}

async function settle(deferred: Deferred | undefined, error?: Error) {
  if (!deferred) throw new Error('No command in flight');
  await act(async () => {
    if (error) deferred.reject(error);
    else deferred.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useRemoteSession command queue', () => {
  it('sends queued commands one at a time in order', async () => {
    const bridge = stubBridge();
    const { result } = renderHook(() => useRemoteSession(vi.fn()));
    act(() => {
      result.current.handleCommand('home');
      result.current.handleCommand('back');
    });
    expect(bridge.sendCommand).toHaveBeenCalledTimes(1);
    await settle(bridge.pending[0]);
    await waitFor(() => {
      expect(bridge.sendCommand).toHaveBeenCalledTimes(2);
    });
    expect(bridge.pending.map((item) => item.request.command)).toEqual(['home', 'back']);
  });

  it('clearCommandQueue drops pending commands and ignores the in-flight result', async () => {
    const bridge = stubBridge();
    const onError = vi.fn();
    const { result } = renderHook(() => useRemoteSession(onError));
    act(() => {
      result.current.handleCommand('home');
      result.current.handleCommand('back');
      result.current.handleCommand('power');
    });
    act(() => {
      result.current.clearCommandQueue();
    });
    await settle(bridge.pending[0], new Error('No active device connected.'));
    expect(onError).not.toHaveBeenCalled();
    expect(bridge.sendCommand).toHaveBeenCalledTimes(1);

    // The queue keeps working for the next session.
    act(() => {
      result.current.handleCommand('select');
    });
    await waitFor(() => {
      expect(bridge.sendCommand).toHaveBeenCalledTimes(2);
    });
    expect(bridge.pending[1]?.request.command).toBe('select');
  });

  it('drops the rest of the queue after an error that means no TV is connected', async () => {
    const bridge = stubBridge();
    const onError = vi.fn();
    const { result } = renderHook(() => useRemoteSession(onError));
    act(() => {
      result.current.handleCommand('home');
      result.current.handleCommand('back');
      result.current.handleCommand('power');
    });
    await settle(bridge.pending[0], new Error('No active device connected.'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(new Error('No active device connected.'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('keeps sending after a transient command failure', async () => {
    const bridge = stubBridge();
    const onError = vi.fn();
    const { result } = renderHook(() => useRemoteSession(onError));
    act(() => {
      result.current.handleCommand('home');
      result.current.handleCommand('back');
    });
    await settle(bridge.pending[0], new Error('Could not send home to 10.0.0.5.'));
    expect(onError).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(bridge.sendCommand).toHaveBeenCalledTimes(2);
    });
  });
});

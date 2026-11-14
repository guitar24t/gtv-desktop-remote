import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CommandDispatchRequest,
  RemoteCommand,
  RemoteCommandSource,
} from '../../shared/types';
import { getDesktopApi } from '../api';
import { isConnectionUnavailableError } from '../lib/pure';
import { BURST_SENSITIVE_COMMANDS, MAX_QUEUED_COMMANDS } from '../lib/remoteCommands';

interface QueuedCommandBatch {
  command: RemoteCommand;
  source: RemoteCommandSource;
  requests: CommandDispatchRequest[];
}

/**
 * Manages remote command dispatch and busy state.
 *
 * @param onCommandError - callback when a command fails to send.
 *   Allows the hook to report errors without being tightly coupled to App's state.
 *   It is not called for a command whose queue was cleared while it was in flight.
 */
export function useRemoteSession(onCommandError?: (error: Error) => void) {
  const [busy, setBusy] = useState(false);

  const onCommandErrorRef = useRef(onCommandError);
  useEffect(() => {
    onCommandErrorRef.current = onCommandError;
  });
  const commandQueueRef = useRef<QueuedCommandBatch[]>([]);
  const queuedCommandCountRef = useRef(0);
  const isProcessingQueueRef = useRef(false);
  // Bumped by clearCommandQueue so results of commands sent before the clear are ignored.
  const queueGenerationRef = useRef(0);

  const createCommandRequest = useCallback(
    (command: RemoteCommand, source: RemoteCommandSource): CommandDispatchRequest => {
      return {
        id: crypto.randomUUID(),
        command,
        issuedAt: Date.now(),
        source,
      };
    },
    []
  );

  const recordQueuedCommandDrop = useCallback((request: CommandDispatchRequest) => {
    void getDesktopApi().recordCommandDrop({
      ...request,
      droppedAt: Date.now(),
      dropReason: 'renderer_burst_limit',
      pendingCommandCount: queuedCommandCountRef.current,
    });
  }, []);

  /**
   * Drops every queued command. A command already handed to main cannot be
   * recalled, but its result (including a failure) is ignored, so it can no
   * longer overwrite state for the session that replaced it.
   */
  const clearCommandQueue = useCallback(() => {
    queueGenerationRef.current += 1;
    commandQueueRef.current = [];
    queuedCommandCountRef.current = 0;
  }, []);

  const flushQueuedCommands = useCallback(async () => {
    if (isProcessingQueueRef.current) {
      return;
    }

    isProcessingQueueRef.current = true;

    try {
      while (commandQueueRef.current.length > 0) {
        const generation = queueGenerationRef.current;
        const currentBatch = commandQueueRef.current[0];
        if (!currentBatch) {
          break;
        }
        const request = currentBatch.requests.shift();

        if (!request) {
          commandQueueRef.current.shift();
          continue;
        }

        let failure: Error | undefined;
        try {
          await getDesktopApi().sendCommand(request);
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }

        if (generation !== queueGenerationRef.current) {
          // The queue was cleared while this command was in flight; the
          // queue now holds only commands for the current session.
          continue;
        }

        queuedCommandCountRef.current = Math.max(0, queuedCommandCountRef.current - 1);
        if (currentBatch.requests.length === 0) {
          commandQueueRef.current.shift();
        }

        if (failure) {
          if (isConnectionUnavailableError(failure.message)) {
            // Every remaining command would fail the same way.
            clearCommandQueue();
          }
          onCommandErrorRef.current?.(failure);
        }
      }
    } finally {
      isProcessingQueueRef.current = false;
      if (commandQueueRef.current.length > 0) {
        void flushQueuedCommands();
      }
    }
  }, [clearCommandQueue]);

  const enqueueCommand = useCallback(
    (request: CommandDispatchRequest) => {
      if (queuedCommandCountRef.current >= MAX_QUEUED_COMMANDS) {
        recordQueuedCommandDrop(request);
        return;
      }

      const lastBatch = commandQueueRef.current[commandQueueRef.current.length - 1];
      if (
        lastBatch &&
        BURST_SENSITIVE_COMMANDS.has(request.command) &&
        lastBatch.command === request.command &&
        lastBatch.source === request.source
      ) {
        lastBatch.requests.push(request);
      } else {
        commandQueueRef.current.push({
          command: request.command,
          source: request.source,
          requests: [request],
        });
      }

      queuedCommandCountRef.current += 1;
      void flushQueuedCommands();
    },
    [flushQueuedCommands, recordQueuedCommandDrop]
  );

  const handleCommand = useCallback(
    (command: RemoteCommand, source: RemoteCommandSource = 'button') => {
      const request = createCommandRequest(command, source);
      enqueueCommand(request);
    },
    [createCommandRequest, enqueueCommand]
  );

  return {
    busy,
    setBusy,
    handleCommand,
    clearCommandQueue,
  };
}

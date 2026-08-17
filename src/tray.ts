import { app, Menu, Tray } from 'electron';
import path from 'node:path';

import type { MonitorState } from './monitor-state';

export interface TrayController {
  tray: Tray;
  setState(state: MonitorState): void;
}

export interface TrayActions {
  onStart(): void;
  onStop(): void;
  onExit(): void;
}

function getStatusText(state: MonitorState): string {
    switch (state.status) {
        case 'idle':
        return 'Idle';

        case 'starting':
        return 'Starting...';

        case 'running':
        return `Running — ${state.model}`;

        case 'stopping':
        return 'Stopping...';

        case 'error':
        return `Error: ${state.message}`;
    }
}

export function createTray(actions: TrayActions): TrayController {
  const iconPath = path.join(
    app.getAppPath(),
    'assets',
    'tray.ico'
  );

  const tray = new Tray(iconPath);

  let state: MonitorState = {
    status: 'idle',
  };

  function renderMenu() {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Stream Deck Monitor',
        enabled: false,
      },
      {
        label: getStatusLabel(state),
        enabled: false,
      },
      ...(state.status === 'running'
        ? [
            {
                label: `Framebuffer: ${state.width}×${state.height}`,
                enabled: false,
            },
            ]
        : []),
      {
        type: 'separator',
      },
      {
        label: getActionLabel(state),
        enabled:
          state.status === 'idle' ||
          state.status === 'running' ||
          state.status === 'error',

        click: () => {
            switch (state.status) {
                case 'idle':
                case 'error':
                actions.onStart();
                break;

                case 'running':
                actions.onStop();
                break;
            }
        },
      },
      {
        type: 'separator',
      },
      {
            label: 'Exit',
            enabled:
                state.status !== 'starting' &&
                state.status !== 'stopping',

            click: () => {
                actions.onExit();
            },
        },
    ]);

    tray.setContextMenu(menu);
  }

    function setState(nextState: MonitorState) {
        state = nextState;

        tray.setToolTip(
            `Stream Deck Monitor — ${getStatusText(state)}`
        );

        renderMenu();
    }

  renderMenu();

  return {
    tray,
    setState,
  };
}

function getStatusLabel(state: MonitorState): string {
  return `Status: ${getStatusText(state)}`;
}

function getActionLabel(state: MonitorState): string {
  switch (state.status) {
    case 'idle':
      return 'Start';

    case 'starting':
      return 'Starting...';

    case 'running':
      return 'Stop';

    case 'stopping':
      return 'Stopping...';

    case 'error':
      return 'Retry';
  }
}
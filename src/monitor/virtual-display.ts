import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import path from 'node:path';

import { app, screen } from 'electron';

const IDD_ROOT = path.join(
  app.getAppPath(),
  'native',
  'virtual-display'
);

const IDD_APP_CANDIDATES = [
  path.join(
    IDD_ROOT,
    'x64',
    'Debug',
    'IddSampleApp.exe'
  ),

  path.join(
    IDD_ROOT,
    'IddSampleApp',
    'x64',
    'Debug',
    'IddSampleApp.exe'
  ),

  path.join(
    IDD_ROOT,
    'x64',
    'Release',
    'IddSampleApp.exe'
  ),

  path.join(
    IDD_ROOT,
    'IddSampleApp',
    'x64',
    'Release',
    'IddSampleApp.exe'
  ),
];

const VIRTUAL_DISPLAY_HOST_CANDIDATES = [
  path.join(
    IDD_ROOT,
    'VirtualDisplayHost',
    'x64',
    'Debug',
    'VirtualDisplayHost.exe'
  ),

  path.join(
    IDD_ROOT,
    'VirtualDisplayHost',
    'x64',
    'Release',
    'VirtualDisplayHost.exe'
  ),
];

export class VirtualDisplaySession {
  private controlServer: Server | null = null;

  private controlSocket: Socket | null = null;

  constructor(
    private readonly monitorIndex: number
  ) {}

  async start(): Promise<void> {
    if (
      this.controlServer ||
      this.controlSocket
    ) {
      return;
    }

    const existingDisplays =
      screen.getAllDisplays().length;

    if (existingDisplays > this.monitorIndex) {
      throw new Error(
        `Monitor index ${this.monitorIndex} already exists ` +
        `before virtual display startup`
      );
    }

    const iddExecutable =
      findIddSampleApp();

    const hostExecutable =
      findVirtualDisplayHost();

    const pipeName =
      `\\\\.\\pipe\\streamdeck-monitor-` +
      `${process.pid}-${Date.now()}`;

    const server =
      createServer();

    let socket: Socket | null = null;

    try {
      await listenNamedPipe(
        server,
        pipeName
      );

      /*
      * Register the connection listener BEFORE
      * launching the helper. The elevated helper
      * can connect very quickly after UAC succeeds.
      */
      const connectionPromise =
        waitForPipeConnection(
          server,
          15_000
        );

      console.log(
        `Starting virtual display: ${iddExecutable}`
      );

      await launchElevatedHelper(
        hostExecutable,
        iddExecutable,
        pipeName
      );

      socket =
        await connectionPromise;

      this.controlServer = server;
      this.controlSocket = socket;

      console.log(
        'Virtual display helper connected'
      );

      await waitForCondition(
        () =>
          screen.getAllDisplays().length >
          this.monitorIndex,
        12_000
      );
    } catch (error) {
      if (
        socket &&
        !socket.destroyed
      ) {
        socket.end('stop\n');
        socket.destroy();
      }

      await closeServer(server);

      this.controlServer = null;
      this.controlSocket = null;

      throw error;
    }

    console.log(
      `Virtual display available at monitor ${this.monitorIndex}`
    );
  }

  async stop(): Promise<void> {
    const server =
      this.controlServer;

    const socket =
      this.controlSocket;

    this.controlServer = null;
    this.controlSocket = null;

    if (!server) {
      return;
    }

    console.log(
      'Stopping virtual display...'
    );

    if (
      socket &&
      !socket.destroyed
    ) {
      socket.end(
        'stop\n'
      );
    }

    await closeServer(
      server
    );

    try {
      await waitForCondition(
        () =>
          screen.getAllDisplays().length <=
          this.monitorIndex,
        5_000
      );
    } catch {
      // PnP removal is asynchronous.
      // Don't fail the whole stop operation just because
      // Windows hasn't finished removing the display yet.
      console.warn(
        'Virtual display removal is still pending'
      );
    }

    console.log(
      'Virtual display stopped'
    );
  }
}

function findIddSampleApp(): string {
  const executable =
    IDD_APP_CANDIDATES.find(
      candidate =>
        existsSync(candidate)
    );

  if (!executable) {
    throw new Error(
      'Could not find IddSampleApp.exe'
    );
  }

  return executable;
}

function findVirtualDisplayHost(): string {
  const executable =
    VIRTUAL_DISPLAY_HOST_CANDIDATES.find(
      candidate =>
        existsSync(candidate)
    );

  if (!executable) {
    throw new Error(
      'Could not find VirtualDisplayHost.exe'
    );
  }

  return executable;
}

function listenNamedPipe(
  server: Server,
  pipeName: string
): Promise<void> {
  return new Promise(
    (resolve, reject) => {
      const handleError = (
        error: Error
      ) => {
        reject(
          new Error(
            `Failed to create control pipe: ${error.message}`
          )
        );
      };

      server.once(
        'error',
        handleError
      );

      server.listen(
        pipeName,
        () => {
          server.off(
            'error',
            handleError
          );

          resolve();
        }
      );
    }
  );
}

function waitForPipeConnection(
  server: Server,
  timeoutMs: number
): Promise<Socket> {
  return new Promise(
    (resolve, reject) => {
      const timeout =
        setTimeout(
          () => {
            cleanup();

            reject(
              new Error(
                'Timed out waiting for virtual display helper'
              )
            );
          },
          timeoutMs
        );

      const handleConnection = (
        socket: Socket
      ) => {
        cleanup();
        resolve(socket);
      };

      const handleError = (
        error: Error
      ) => {
        cleanup();

        reject(
          new Error(
            `Control pipe error: ${error.message}`
          )
        );
      };

      const handleClose = () => {
        cleanup();

        reject(
          new Error(
            'Control pipe closed before helper connected'
          )
        );
      };

      const cleanup = () => {
        clearTimeout(timeout);

        server.off(
          'connection',
          handleConnection
        );

        server.off(
          'error',
          handleError
        );

        server.off(
          'close',
          handleClose
        );
      };

      server.once(
        'connection',
        handleConnection
      );

      server.once(
        'error',
        handleError
      );

      server.once(
        'close',
        handleClose
      );
    }
  );
}

async function launchElevatedHelper(
  hostExecutable: string,
  iddExecutable: string,
  pipeName: string
): Promise<void> {
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$arguments = '"{0}" "{1}"' -f ` +
      `$env:SDM_IDD_EXECUTABLE, ` +
      `$env:SDM_PIPE_NAME`,
    `try {`,
    `  Start-Process ` +
      `-FilePath $env:SDM_HOST_EXECUTABLE ` +
      `-ArgumentList $arguments ` +
      `-Verb RunAs ` +
      `-WindowStyle Hidden | Out-Null`,
    `} catch {`,
    `  [Console]::Error.WriteLine(` +
      `$_.Exception.Message)`,
    `  exit 1`,
    `}`,
  ].join('; ');

  const launcher =
    spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ],
      {
        windowsHide: true,

        stdio: [
          'ignore',
          'ignore',
          'pipe',
        ],

        env: {
          ...process.env,

          SDM_HOST_EXECUTABLE:
            hostExecutable,

          SDM_IDD_EXECUTABLE:
            iddExecutable,

          SDM_PIPE_NAME:
            pipeName,
        },
      }
    );

  let stderr = '';

  launcher.stderr?.on(
    'data',
    (data: Buffer) => {
      stderr +=
        data.toString();
    }
  );

  const exitCode =
    await waitForProcessExit(
      launcher
    );

  if (exitCode !== 0) {
    const message =
      stderr.trim();

    if (
      message
        .toLowerCase()
        .includes('canceled') ||
      message
        .toLowerCase()
        .includes('cancelled')
    ) {
      throw new Error(
        'Administrator permission was denied'
      );
    }

    throw new Error(
      message ||
      `Failed to launch virtual display helper ` +
      `(PowerShell exited with code ${exitCode})`
    );
  }
}

function waitForProcessExit(
  child: ChildProcess
): Promise<number | null> {
  return new Promise(
    (resolve, reject) => {
      const handleError = (
        error: Error
      ) => {
        child.off(
          'exit',
          handleExit
        );

        reject(
          new Error(
            `Failed to launch elevation process: ${error.message}`
          )
        );
      };

      const handleExit = (
        code: number | null
      ) => {
        child.off(
          'error',
          handleError
        );

        resolve(code);
      };

      child.once(
        'error',
        handleError
      );

      child.once(
        'exit',
        handleExit
      );
    }
  );
}

function closeServer(
  server: Server
): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise(
    resolve => {
      server.close(
        () => resolve()
      );
    }
  );
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number
): Promise<void> {
  const started = performance.now();

  while (
    performance.now() - started <
    timeoutMs
  ) {
    if (condition()) {
      return;
    }

    await delay(100);
  }

    const displays =
        screen.getAllDisplays();

    console.error(
        'Displays visible to Electron:',
        displays.map(
            (display, index) => ({
            index,
            id: display.id,
            bounds: display.bounds,
            size: display.size,
            })
        )
    );

    throw new Error(
        'Timed out waiting for virtual display'
    );
}

function delay(
  ms: number
): Promise<void> {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}
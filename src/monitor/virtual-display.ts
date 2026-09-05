import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  createServer,
  type Server,
  type Socket,
} from 'node:net';
import path from 'node:path';

import { app } from 'electron';

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

  private monitorIndex: number | null = null;

  async start(): Promise<number> {
    if (
      this.controlServer ||
      this.controlSocket
    ) {
      if (this.monitorIndex === null) {
        throw new Error(
          'Virtual display is already starting'
        );
      }

      return this.monitorIndex;
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

      this.monitorIndex =
        await waitForReadyMessage(
          socket,
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
      this.monitorIndex = null;

      throw error;
    }

    if (this.monitorIndex === null) {
      throw new Error(
        'Virtual display did not provide a monitor index'
      );
    }

    console.log(
      `Virtual display available at monitor ${this.monitorIndex}`
    );

    return this.monitorIndex;
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

    this.monitorIndex = null;

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

function waitForReadyMessage(
  socket: Socket,
  timeoutMs: number
): Promise<number> {
  return new Promise(
    (resolve, reject) => {
      let pending = '';

      const timeout =
        setTimeout(
          () => {
            cleanup();

            reject(
              new Error(
                'Timed out waiting for virtual display readiness'
              )
            );
          },
          timeoutMs
        );

      const handleData = (
        data: Buffer
      ) => {
        pending += data.toString();

        const newline =
          pending.indexOf('\n');

        if (newline === -1) {
          return;
        }

        const message =
          pending
            .slice(0, newline)
            .trim();

        const match =
          /^ready (\d+)$/.exec(
            message
          );

        if (!match) {
          cleanup();

          reject(
            new Error(
              `Unexpected virtual display helper message: ${message}`
            )
          );

          return;
        }

        const monitorIndex =
          Number.parseInt(
            match[1],
            10
          );

        cleanup();

        resolve(
          monitorIndex
        );
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
            'Control pipe closed before virtual display became ready'
          )
        );
      };

      const cleanup = () => {
        clearTimeout(timeout);

        socket.off(
          'data',
          handleData
        );

        socket.off(
          'error',
          handleError
        );

        socket.off(
          'close',
          handleClose
        );
      };

      socket.on(
        'data',
        handleData
      );

      socket.once(
        'error',
        handleError
      );

      socket.once(
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
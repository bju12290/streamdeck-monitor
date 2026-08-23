import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
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

export class VirtualDisplaySession {
  private child: ChildProcess | null = null;

  constructor(
    private readonly monitorIndex: number
  ) {}

  async start(): Promise<void> {
    if (this.child) {
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

    const executable =
      findIddSampleApp();

    console.log(
      `Starting virtual display: ${executable}`
    );

    const child = spawn(
        executable,
        [],
        {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        }
    );

    this.child = child;

    child.stdout?.on(
        'data',
        (data: Buffer) => {
            console.log(
            'IddSampleApp stdout:',
            data.toString().trim()
            );
        }
    );

    child.stderr?.on(
        'data',
        (data: Buffer) => {
            console.error(
            'IddSampleApp stderr:',
            data.toString().trim()
            );
        }
    );

    child.on(
        'error',
        (error) => {
            console.error(
            'IddSampleApp process error:',
            error
            );
        }
    );

    child.on(
        'exit',
        (code, signal) => {
            console.log(
            `IddSampleApp exited: code=${code}, signal=${signal}`
            );
        }
    );

    try {
      await waitForSpawn(child);

      await waitForCondition(
        () =>
          screen.getAllDisplays().length >
          this.monitorIndex,
        12_000
      );
    } catch (error) {
      this.child = null;

      if (
        child.exitCode === null &&
        child.signalCode === null
      ) {
        child.kill();
      }

      throw error;
    }

    console.log(
      `Virtual display available at monitor ${this.monitorIndex}`
    );
  }

  async stop(): Promise<void> {
    const child = this.child;

    this.child = null;

    if (!child) {
      return;
    }

    console.log('Stopping virtual display...');

    if (
      child.exitCode === null &&
      child.signalCode === null
    ) {
      child.kill();
    }

    await waitForExit(
      child,
      2_000
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

    console.log('Virtual display stopped');
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

function waitForSpawn(
  child: ChildProcess
): Promise<void> {
  return new Promise(
    (resolve, reject) => {
      const handleSpawn = () => {
        child.off(
          'error',
          handleError
        );

        resolve();
      };

      const handleError = (
        error: Error
      ) => {
        child.off(
          'spawn',
          handleSpawn
        );

        reject(
          new Error(
            `Failed to start virtual display helper: ${error.message}`
          )
        );
      };

      child.once(
        'spawn',
        handleSpawn
      );

      child.once(
        'error',
        handleError
      );
    }
  );
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<void> {
  if (
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }

  await Promise.race([
    new Promise<void>(
      resolve => {
        child.once(
          'exit',
          () => resolve()
        );
      }
    ),

    delay(timeoutMs),
  ]);
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
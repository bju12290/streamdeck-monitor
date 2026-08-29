import { spawn } from 'node:child_process';

export interface CaptureOptions {
  width: number;
  height: number;
  monitorIndex: number;
  fps: number;
}

export interface CapturedFrame {
  buffer: Buffer;
  sequence: number;
}

const CAPTURE_START_TIMEOUT_MS = 5_000;
const CAPTURE_ATTEMPT_TIMEOUT_MS = 1_000;
const CAPTURE_RETRY_DELAY_MS = 100;

export class CaptureSession {
  private ffmpeg: ReturnType<typeof spawn> | null = null;

  private pending = Buffer.alloc(0);

  private latestFrame: Buffer | null = null;
  private latestSequence = 0;

  constructor(
    private readonly options: CaptureOptions
  ) {}

  async start(): Promise<void> {
    if (this.ffmpeg) {
      return;
    }

    const {
      width,
      height,
      monitorIndex,
      fps,
    } = this.options;

    const frameSize =
      width *
      height *
      3;

    const filter =
      `gfxcapture=` +
      `monitor_idx=${monitorIndex}:` +
      `width=${width}:` +
      `height=${height}:` +
      `resize_mode=scale_aspect:` +
      `max_framerate=${fps},` +
      `hwdownload,format=bgra,format=rgb24`;

    const started =
      performance.now();

    let lastError: Error | null = null;

    while (
      performance.now() - started <
      CAPTURE_START_TIMEOUT_MS
    ) {
      this.resetFrames();

      try {
        await this.startAttempt(
          filter,
          frameSize
        );

        console.log(
          `Capture started: monitor ${monitorIndex}, ` +
          `${width}x${height} @ ${fps} FPS`
        );

        return;
      } catch (error) {
        lastError =
          error instanceof Error
            ? error
            : new Error(String(error));

        await this.stopFfmpegProcess();

        if (
          performance.now() - started >=
          CAPTURE_START_TIMEOUT_MS
        ) {
          break;
        }

        await delay(
          CAPTURE_RETRY_DELAY_MS
        );
      }
    }

    this.resetFrames();

    throw new Error(
      `Failed to start capture: ` +
      (
        lastError?.message ??
        'timed out waiting for first frame'
      )
    );
  }

  getLatestFrame(
    afterSequence: number
  ): CapturedFrame | null {
    if (
      !this.latestFrame ||
      this.latestSequence === afterSequence
    ) {
      return null;
    }

    return {
      buffer: this.latestFrame,
      sequence: this.latestSequence,
    };
  }

  async stop(): Promise<void> {
    await this.stopFfmpegProcess();

    this.resetFrames();

    console.log(
      'Capture stopped.'
    );
  }

  private async startAttempt(
    filter: string,
    frameSize: number
  ): Promise<void> {
    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',

        '-filter_complex', filter,

        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',

        'pipe:1',
      ],
      {
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      }
    );

    this.ffmpeg = ffmpeg;

    let startupError = '';

    await new Promise<void>(
      (resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          clearTimeout(timeout);

          ffmpeg.off(
            'error',
            handleError
          );

          ffmpeg.off(
            'exit',
            handleStartupExit
          );
        };

        const succeed = () => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();

          resolve();
        };

        const fail = (
          error: Error
        ) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();

          reject(error);
        };

        const handleError = (
          error: Error
        ) => {
          fail(
            new Error(
              `Failed to start FFmpeg: ${error.message}`
            )
          );
        };

        const handleStartupExit = (
          code: number | null
        ) => {
          fail(
            new Error(
              startupError ||
              `FFmpeg exited before first frame ` +
              `(code ${code})`
            )
          );
        };

        const timeout =
          setTimeout(
            () => {
              fail(
                new Error(
                  'Timed out waiting for first captured frame'
                )
              );
            },
            CAPTURE_ATTEMPT_TIMEOUT_MS
          );

        ffmpeg.stdout!.on(
          'data',
          (chunk: Buffer) => {
            const completedFrame =
              this.handleChunk(
                chunk,
                frameSize
              );

            if (completedFrame) {
              succeed();
            }
          }
        );

        ffmpeg.stderr!.on(
          'data',
          (data: Buffer) => {
            const message =
              data.toString().trim();

            if (!message) {
              return;
            }

            startupError =
              message;

            console.error(
              'FFmpeg:',
              message
            );
          }
        );

        ffmpeg.on(
          'exit',
          (code, signal) => {
            if (code !== null) {
              console.log(
                `FFmpeg exited with code ${code}`
              );
            } else if (signal) {
              console.log(
                `FFmpeg exited from signal ${signal}`
              );
            }

            if (
              this.ffmpeg === ffmpeg
            ) {
              this.ffmpeg = null;
            }
          }
        );

        ffmpeg.once(
          'error',
          handleError
        );

        ffmpeg.once(
          'exit',
          handleStartupExit
        );
      }
    );
  }

  private async stopFfmpegProcess(): Promise<void> {
    const ffmpeg =
      this.ffmpeg;

    this.ffmpeg = null;

    if (!ffmpeg) {
      return;
    }

    if (
      ffmpeg.exitCode !== null ||
      ffmpeg.signalCode !== null
    ) {
      return;
    }

    const exited =
      new Promise<void>(
        resolve => {
          ffmpeg.once(
            'exit',
            () => resolve()
          );
        }
      );

    const killed =
      ffmpeg.kill();

    if (killed) {
      await exited;
    }
  }

  private handleChunk(
    chunk: Buffer,
    frameSize: number
  ): boolean {
    let completedFrame = false;

    this.pending = Buffer.concat([
      this.pending,
      chunk,
    ]);

    while (
      this.pending.length >= frameSize
    ) {
      const frame =
        this.pending.subarray(
          0,
          frameSize
        );

      this.pending =
        this.pending.subarray(
          frameSize
        );

      // The pending backing buffer changes as
      // new stdout data arrives, so keep our
      // own copy of the completed frame.
      this.latestFrame =
        Buffer.from(frame);

      this.latestSequence++;
      completedFrame = true;
    }
    return completedFrame;
  }

  private resetFrames(): void {
    this.pending = Buffer.alloc(0);
    this.latestFrame = null;
    this.latestSequence = 0;
  }
}

function delay(
  ms: number
): Promise<void> {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}
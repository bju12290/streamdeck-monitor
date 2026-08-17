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
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    this.ffmpeg = ffmpeg;

    ffmpeg.stdout!.on(
      'data',
      (chunk: Buffer) => {
        this.handleChunk(
          chunk,
          frameSize
        );
      }
    );

    ffmpeg.stderr!.on(
      'data',
      (data: Buffer) => {
        console.error(
          'FFmpeg:',
          data.toString().trim()
        );
      }
    );

    ffmpeg.on('exit', (code) => {
      console.log(
        `FFmpeg exited with code ${code}`
      );

      if (this.ffmpeg === ffmpeg) {
        this.ffmpeg = null;
      }
    });

    await new Promise<void>(
      (resolve, reject) => {
        const handleSpawn = () => {
          ffmpeg.off(
            'error',
            handleError
          );

          resolve();
        };

        const handleError = (
          error: Error
        ) => {
          ffmpeg.off(
            'spawn',
            handleSpawn
          );

          this.ffmpeg = null;

          reject(
            new Error(
              `Failed to start FFmpeg: ${error.message}`
            )
          );
        };

        ffmpeg.once(
          'spawn',
          handleSpawn
        );

        ffmpeg.once(
          'error',
          handleError
        );
      }
    );

    console.log(
      `Capture started: monitor ${monitorIndex}, ` +
      `${width}x${height} @ ${fps} FPS`
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
    const ffmpeg = this.ffmpeg;

    this.ffmpeg = null;

    if (ffmpeg) {
      if (
        ffmpeg.exitCode === null &&
        ffmpeg.signalCode === null
      ) {
        const exited =
          new Promise<void>(
            (resolve) => {
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
    }

    this.resetFrames();

    console.log(
      'Capture stopped.'
    );
  }

  private handleChunk(
    chunk: Buffer,
    frameSize: number
  ): void {
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
    }
  }

  private resetFrames(): void {
    this.pending = Buffer.alloc(0);
    this.latestFrame = null;
    this.latestSequence = 0;
  }
}
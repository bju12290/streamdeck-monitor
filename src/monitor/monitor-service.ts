import {
  listStreamDecks,
  openStreamDeck,
} from '@elgato-stream-deck/node';

import type { MonitorState } from '../monitor-state';

import { CaptureSession } from './capture';
import { VirtualDisplaySession } from './virtual-display';

const CAPTURE_FPS = 60;
const CAPTURE_MONITOR_INDEX = 3;

export type MonitorStateListener = (
  state: MonitorState
) => void;

type StreamDeck = Awaited<
  ReturnType<typeof openStreamDeck>
>;

export class MonitorService {
  private state: MonitorState = {
    status: 'idle',
  };

  private deck: StreamDeck | null = null;

  private capture: CaptureSession | null = null;

  private virtualDisplay:
    VirtualDisplaySession | null = null;

  private displayRunning = false;

  private displayLoopPromise:
    Promise<void> | null = null;

  private listeners = new Set<MonitorStateListener>();

  getState(): MonitorState {
    return this.state;
  }

  subscribe(listener: MonitorStateListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (
      this.state.status !== 'idle' &&
      this.state.status !== 'error'
    ) {
      return;
    }

    this.setState({
      status: 'starting',
    });

    let deck: StreamDeck | null = null;
    let capture: CaptureSession | null = null;
    let virtualDisplay:
      VirtualDisplaySession | null = null;

    try {
      const devices = await listStreamDecks();

      if (devices.length === 0) {
        throw new Error('No Stream Deck detected');
      }

      deck = await openStreamDeck(
        devices[0].path
      );

      const dimensions =
        deck.calculateFillPanelDimensions();

      if (!dimensions) {
        throw new Error(
          'Stream Deck does not have a fillable panel'
        );
      }

      const { width, height } = dimensions;

      virtualDisplay =
        new VirtualDisplaySession(
          CAPTURE_MONITOR_INDEX
        );

      await virtualDisplay.start();

      capture = new CaptureSession({
        width,
        height,
        monitorIndex:
          CAPTURE_MONITOR_INDEX,
        fps: CAPTURE_FPS,
      });

      await capture.start();

      deck.on('error', (error) => {
        console.error(
          'Stream Deck error:',
          error
        );

        this.setState({
          status: 'error',
          message: getErrorMessage(error),
        });
      });

      this.deck = deck;
      this.capture = capture;
      this.virtualDisplay =
        virtualDisplay;

      this.displayRunning = true;

      this.displayLoopPromise =
        this.displayLoop(
          deck,
          capture
        );

      console.log(
        `Connected to ${deck.PRODUCT_NAME} (${width}x${height})`
      );

      this.setState({
        status: 'running',
        model: deck.PRODUCT_NAME,
        width,
        height,
      });
    } catch (error) {
      this.displayRunning = false;

      if (capture) {
        try {
          await capture.stop();
        } catch {}
      }

      if (virtualDisplay) {
        try {
          await virtualDisplay.stop();
        } catch {}
      }

      if (deck) {
        try {
          await deck.close();
        } catch {}
      }

      this.capture = null;
      this.deck = null;
      this.virtualDisplay = null;

      this.displayLoopPromise = null;

      this.setState({
        status: 'error',
        message: getErrorMessage(error),
      });
    }
  }

  async stop(): Promise<void> {
    if (this.state.status !== 'running') {
      return;
    }

    this.setState({
      status: 'stopping',
    });

    try {
      this.displayRunning = false;

      if (this.displayLoopPromise) {
        await this.displayLoopPromise;
        this.displayLoopPromise = null;
      }

      if (this.capture) {
        await this.capture.stop();
        this.capture = null;
      }

      if (this.virtualDisplay) {
        await this.virtualDisplay.stop();
        this.virtualDisplay = null;
      }

      if (this.deck) {
        await this.deck.close();
        this.deck = null;
      }

      this.setState({
        status: 'idle',
      });
    } catch (error) {
      this.setState({
        status: 'error',
        message: getErrorMessage(error),
      });
    }
  }

  private async displayLoop(
    deck: StreamDeck,
    capture: CaptureSession
  ): Promise<void> {
    let lastSentSequence = -1;

    try {
      while (this.displayRunning) {
        const frame =
          capture.getLatestFrame(
            lastSentSequence
          );

        if (frame) {
          await deck.fillPanelBuffer(
            frame.buffer,
            {
              format: 'rgb',
            }
          );

          lastSentSequence =
            frame.sequence;
        } else {
          await new Promise<void>(
            (resolve) =>
              setImmediate(resolve)
          );
        }
      }
    } catch (error) {
      console.error(
        'Display loop error:',
        error
      );

      this.displayRunning = false;

      this.setState({
        status: 'error',
        message:
          getErrorMessage(error),
      });
    }
  }

  private setState(state: MonitorState): void {
    this.state = state;

    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    console.log(error.message)
    return error.message;
  }

  return String(error);
}
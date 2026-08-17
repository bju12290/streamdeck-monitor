import { app } from 'electron';
import started from 'electron-squirrel-startup';

import { MonitorService } from './monitor/monitor-service';
import {
  createTray,
  type TrayController,
} from './tray';

if (started) {
  app.quit();
}

let trayController: TrayController | null = null;

const monitor = new MonitorService();

app.whenReady().then(() => {
  trayController = createTray({
    onStart: () => {
      void monitor.start();
    },

    onStop: () => {
      void monitor.stop();
    },

    onExit: () => {
      void monitor
        .stop()
        .finally(() => {
          app.quit();
        });
    },
  });

  trayController.setState(
    monitor.getState()
  );

  monitor.subscribe((state) => {
    trayController?.setState(state);
  });

  console.log('Stream Deck Monitor started.');
});
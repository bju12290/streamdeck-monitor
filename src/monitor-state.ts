export type MonitorState =
  | {
      status: 'idle';
    }
  | {
      status: 'starting';
    }
  | {
      status: 'running';
      model: string;
      width: number;
      height: number;
    }
  | {
      status: 'stopping';
    }
  | {
      status: 'error';
      message: string;
    };
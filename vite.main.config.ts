import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        '@elgato-stream-deck/node',
        'node-hid',
      ],
    },
  },
});
import { createServer } from 'node:http';

import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDatabasePool } from './db/pool.js';
import { createSocketServer } from './realtime/socket.js';

const app = createApp();
const httpServer = createServer(app);
const socketServer = createSocketServer(httpServer);

httpServer.listen(env.port, env.host, () => {
  console.log(`Kinetra backend is listening on http://${env.host}:${env.port} (${env.nodeEnv}).`);
});

let shutdownStarted = false;

const closeHttpServer = async (): Promise<void> => {
  if (!httpServer.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
};

const closeSocketServer = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    socketServer.close(() => resolve());
  });
};

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  console.log(`${signal} received. Closing Kinetra backend.`);

  try {
    await closeSocketServer();
    await closeHttpServer();
    await closeDatabasePool();
  } catch (error) {
    console.error('Failed to close Kinetra backend cleanly.', error);
    process.exitCode = 1;
  }
};

process.on('SIGINT', (signal) => {
  void shutdown(signal);
});
process.on('SIGTERM', (signal) => {
  void shutdown(signal);
});

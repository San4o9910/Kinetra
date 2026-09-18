import { TrainingReminders } from './training/reminders.js';
import { WebPushSender } from './push/webpush-sender.js';
import { TrainingService } from './training/service.js';
import { TrainingMedia } from './training/media.js';
import { ResumableTrainingMedia } from './training/resumable-media.js';
import { databasePool } from './db/pool.js';
import { createServer } from 'node:http';

import { createApp } from './app.js';
import { createProductionAuthRuntime } from './auth/runtime.js';
import { attachChatRealtime } from './chat/realtime.js';
import { createProductionChatRuntime } from './chat/runtime.js';
import { env } from './config/env.js';
import { closeDatabasePool } from './db/pool.js';
import { createSocketServer } from './realtime/socket.js';
import { createShutdownHandler } from './shutdown.js';

const authRuntime = createProductionAuthRuntime();
const chatRuntime = createProductionChatRuntime({
  accessTokenVerifier: authRuntime.accessTokenVerifier,
});
let shutdownStarted = false;
const trainingDirectory = process.env.TRAINING_MEDIA_DIR?.trim() || null;
const trainingWorker = new ResumableTrainingMedia(
  new TrainingMedia(
    new TrainingService(databasePool, trainingDirectory !== null),
    trainingDirectory,
    env.auth.jwtAccessSecret,
  ),
);
const trainingTimer = setInterval(() => {
  if (!shutdownStarted) void trainingWorker.processNext();
}, 15_000);
trainingTimer.unref();
const reminders =
  env.vapid && process.env.TRAINING_REMINDERS_ENABLED === 'true'
    ? new TrainingReminders(databasePool, new WebPushSender(env.vapid))
    : null;
let remindersRunning = false;
const remindersTimer = setInterval(() => {
  if (!shutdownStarted && reminders && !remindersRunning) {
    remindersRunning = true;
    void reminders
      .run()
      .catch(() => console.error('Personal reminder delivery failed.'))
      .finally(() => {
        remindersRunning = false;
      });
  }
}, 30_000);
remindersTimer.unref();
const app = createApp({ authRuntime, chatRuntime, isDraining: () => shutdownStarted });
const httpServer = createServer(app);
httpServer.requestTimeout = Math.max(env.chat.photoUploadTotalTimeoutMs + 5_000, 610_000);
const socketServer = createSocketServer(httpServer);
const detachChatRealtime = attachChatRealtime(socketServer, {
  accessTokenVerifier: authRuntime.accessTokenVerifier,
  service: chatRuntime.service,
  eventHub: chatRuntime.eventHub,
  rateLimiter: chatRuntime.rateLimiter,
  allowedOrigins: env.corsOrigins,
  trustedProxyHops: chatRuntime.trustedProxyHops,
});

httpServer.listen(env.port, env.host, () => {
  console.log(`Kinetra backend is listening on http://${env.host}:${env.port} (${env.nodeEnv}).`);
});

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

const shutdown = createShutdownHandler({
  ...env.shutdown,
  markDraining: () => {
    shutdownStarted = true;
    clearInterval(trainingTimer);
    clearInterval(remindersTimer);
    void trainingWorker.stop();
    console.log('Kinetra backend is draining.');
  },
  closeRealtime: async () => {
    try {
      detachChatRealtime();
    } finally {
      await closeSocketServer();
    }
  },
  closeHttp: closeHttpServer,
  closeDatabase: closeDatabasePool,
  reportFailure: (stage) => {
    console.error('Kinetra backend shutdown failed.', { stage });
    process.exitCode = 1;
  },
  forceExit: () => {
    httpServer.closeAllConnections();
    process.exit(1);
  },
});

process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});

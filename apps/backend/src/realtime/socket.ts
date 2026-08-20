import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';

import { env } from '../config/env.js';

export const createSocketServer = (httpServer: HttpServer): SocketServer =>
  new SocketServer(httpServer, {
    cors: {
      origin: env.corsOrigins,
      credentials: true,
    },
  });

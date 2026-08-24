import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';

import { env } from '../config/env.js';

export const createSocketServer = (httpServer: HttpServer): SocketServer =>
  new SocketServer(httpServer, {
    transports: ['websocket'],
    maxHttpBufferSize: 32 * 1024,
    cors: {
      origin: [...env.corsOrigins],
      credentials: true,
    },
  });

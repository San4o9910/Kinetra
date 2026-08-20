import { io, type Socket } from 'socket.io-client';

import { apiBaseUrl } from '../lib/api';

export type KinetraSocket = Socket;

export const createSocketClient = (url = apiBaseUrl): KinetraSocket =>
  io(url, {
    autoConnect: false,
    transports: ['websocket'],
  });

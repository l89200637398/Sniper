import { io } from 'socket.io-client';

// Same-origin connection: the JWT cookie is httpOnly, so JS can't read it.
// Instead we rely on `withCredentials: true` — the browser attaches the cookie
// to the WS handshake header, and server.ts reads it from `socket.request.headers.cookie`.
// In dev, vite.config.ts proxies /socket.io to the backend on :3001.
const url = import.meta.env.VITE_API_URL;
const options = {
  autoConnect: true,
  reconnection: true,
  reconnectionDelay: 2000,
  withCredentials: true,
};
export const socket = url ? io(url, options) : io(options);

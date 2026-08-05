// WebSocket handshake — RFC 6455 Section 4.2 (server side).

import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { WebSocket } from './websocket.js';
import type { MessageHandler, CloseHandler } from './websocket.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Compute the Sec-WebSocket-Accept header value from the client's key. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/**
 * Complete a WebSocket upgrade: write the 101 Switching Protocols response and
 * return a WebSocket wrapper over the socket. Returns undefined if the request
 * is not a valid upgrade.
 */
export function upgrade(
  socket: Socket,
  key: string | undefined,
  protocols: string[] | undefined,
  onMessage?: MessageHandler,
  onClose?: CloseHandler,
  onPing?: () => void,
  onPong?: () => void,
): WebSocket | undefined {
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return undefined;
  }
  const accept = acceptKey(key);
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`];
  if (protocols && protocols.length) lines.push(`Sec-WebSocket-Protocol: ${protocols[0]}`);
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  return new WebSocket(socket, onMessage, onClose, onPing, onPong);
}

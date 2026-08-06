# JATA Qi Python SDK — WebSocket streaming (from-scratch RFC 6455 client).
#
# Pure standard library (socket + base64 + hashlib + struct) so the SDK has
# zero dependencies. Implements the client side of the gateway's /ws protocol:
#
#   send { "type": "tanya.chat", "message": ..., "persona": ... }
#   recv tanya.chunk (content) ... tanya.done | tanya.error
#
# TanyaChatStream is an iterator that yields reply chunks as they arrive.

import base64
import hashlib
import json
import os
import socket
import struct
from typing import Any, Dict, Iterator, Optional
from urllib.parse import quote, urlparse


class TanyaStreamError(Exception):
    """Raised when the server sends a tanya.error frame or the socket fails."""


class TanyaChatStream(Iterator[str]):
    """Live iterator over a TANYA conversational reply (word-by-word chunks).

    Usage:
        with TanyaChatStream(base_url, token, "hello", persona="main") as s:
            for chunk in s:
                print(chunk, end="", flush=True)
    """

    def __init__(self, base_url: str, token: Optional[str], message: str,
                 persona: Optional[str] = None, conversation_id: Optional[str] = None,
                 org_id: Optional[str] = None, model_routing: bool = False,
                 timeout: float = 15.0):
        self._sock: Optional[socket.socket] = None
        self._buffer = b""
        self._message = message
        self._persona = persona
        self._conversation_id = conversation_id
        self._org_id = org_id
        self._model_routing = model_routing
        self._timeout = timeout
        self._done = False
        self._url = self._build_url(base_url, token)

    @staticmethod
    def _build_url(base_url: str, token: Optional[str]) -> str:
        parsed = urlparse(base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        host = parsed.netloc
        path = parsed.path.rstrip("/") + "/ws"
        if token:
            path += "?token=" + quote(token, safe="")
        return f"{scheme}://{host}{path}"

    # ---- context manager ----------------------------------------------------

    def __enter__(self) -> "TanyaChatStream":
        self._connect()
        self._send_frame(json.dumps({
            "type": "tanya.chat",
            "message": self._message,
            **({"persona": self._persona} if self._persona else {}),
            **({"conversationId": self._conversation_id} if self._conversation_id else {}),
            **({"orgId": self._org_id} if self._org_id else {}),
            **({"modelRouting": True} if self._model_routing else {}),
        }))
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def __iter__(self) -> "TanyaChatStream":
        return self

    def __next__(self) -> str:
        if self._done:
            raise StopIteration
        while True:
            frame = self._recv_frame()
            if frame is None:
                raise StopIteration
            opcode, payload = frame
            if opcode == 0x1:  # text
                try:
                    msg: Dict[str, Any] = json.loads(payload.decode("utf-8"))
                except ValueError:
                    continue
                mtype = msg.get("type")
                if mtype == "tanya.chunk":
                    return str(msg.get("content", ""))
                if mtype == "tanya.done":
                    self._done = True
                    raise StopIteration
                if mtype == "tanya.error":
                    self._done = True
                    raise TanyaStreamError(str(msg.get("error", "stream error")))
                # other frames (realtime.*) are ignored
            elif opcode == 0x8:  # close
                self._done = True
                raise StopIteration

    # ---- RFC 6455 client ----------------------------------------------------

    def _connect(self) -> None:
        parsed = urlparse(self._url)
        host = parsed.hostname or "localhost"
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        sock = socket.create_connection((host, port), timeout=self._timeout)
        if parsed.scheme == "wss":
            import ssl
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        self._sock = sock
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        path = parsed.path or "/ws"
        if parsed.query:
            path += "?" + parsed.query
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        sock.sendall(request.encode("ascii"))
        response = self._read_until(b"\r\n\r\n")
        if b"101" not in response.split(b"\r\n", 1)[0]:
            sock.close()
            raise TanyaStreamError(f"websocket handshake failed: {response[:200]!r}")
        accept = b""
        for line in response.split(b"\r\n"):
            if line.lower().startswith(b"sec-websocket-accept:"):
                accept = line.split(b":", 1)[1].strip()
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest())
        if accept != expected:
            sock.close()
            raise TanyaStreamError("websocket handshake: invalid Sec-WebSocket-Accept")
        self._sock = sock

    def _read_until(self, marker: bytes) -> bytes:
        data = b""
        while marker not in data:
            chunk = self._sock.recv(4096)  # type: ignore[union-attr]
            if not chunk:
                break
            data += chunk
        return data

    def _send_frame(self, text: str) -> None:
        payload = text.encode("utf-8")
        mask = os.urandom(4)
        header = bytearray([0x81])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self._sock.sendall(bytes(header) + mask + masked)  # type: ignore[union-attr]

    def _recv_frame(self):
        """Read one frame → (opcode, payload) or None on clean EOF."""
        while True:
            head = self._read_exact(2)
            if head is None:
                return None
            opcode = head[0] & 0x0F
            length = head[1] & 0x7F
            masked = bool(head[1] & 0x80)
            if length == 126:
                ext = self._read_exact(2)
                if ext is None:
                    return None
                length = struct.unpack(">H", ext)[0]
            elif length == 127:
                ext = self._read_exact(8)
                if ext is None:
                    return None
                length = struct.unpack(">Q", ext)[0]
            if masked:
                mask_key = self._read_exact(4)
                if mask_key is None:
                    return None
            else:
                mask_key = None
            payload = self._read_exact(length)
            if payload is None:
                return None
            if masked and mask_key is not None:
                payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
            if opcode == 0x9:  # ping → pong
                self._send_raw_frame(0xA, payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x8:  # close
                return (0x8, payload)
            return (opcode, payload)

    def _send_raw_frame(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self._sock.sendall(bytes(header) + mask + masked)  # type: ignore[union-attr]

    def _read_exact(self, n: int):
        while len(self._buffer) < n:
            chunk = self._sock.recv(4096)  # type: ignore[union-attr]
            if not chunk:
                return None
            self._buffer += chunk
        out, self._buffer = self._buffer[:n], self._buffer[n:]
        return out

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

# JATA Qi Python SDK — zero-dependency client for the JATA Qi API gateway.
#
# Mirrors the TypeScript SDK's surface: auth, health, QiL, TANYA chat
# (HTTP + WebSocket streaming), mobile native, marketplace, cloud,
# PKI/IdP session rotation, notifications, audit, and orgs.
#
# Only the Python standard library is used (urllib + a from-scratch
# RFC 6455 WebSocket client), so it runs anywhere Python 3.9+ does.

from .client import (
    JataQiClient,
    JataQiError,
    JataQiUnauthorized,
)
from .streaming import TanyaChatStream, TanyaStreamError

__all__ = [
    "JataQiClient",
    "JataQiError",
    "JataQiUnauthorized",
    "TanyaChatStream",
    "TanyaStreamError",
]

__version__ = "0.1.0"

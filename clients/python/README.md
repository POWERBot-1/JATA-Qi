# JATA Qi — Python SDK

A **zero-dependency** Python client for the JATA Qi API gateway (stdlib only —
`urllib` for HTTP and a from-scratch RFC 6455 WebSocket client for streaming).
It mirrors the TypeScript SDK's surface: auth, health, QiL, TANYA chat
(HTTP + live word-by-word streaming), TANYA Mobile Native, MAZA marketplace,
cloud autoscaling, PKI/IdP session rotation, notifications, audit, and orgs.

## Install

```bash
pip install -e clients/python        # from the repo root
# or just add clients/python/jataqi_sdk to your path — there are no deps
```

## Quick start

```python
from jataqi_sdk import JataQiClient, TanyaChatStream

client = JataQiClient("http://localhost:7400")
client.login("admin", "admin")

# QiL program
r = client.qil_run('MISSION "hello" { REASON REPORT }')
print(r["result"]["finalReport"])

# TANYA chat (HTTP)
reply = client.tanya_chat("hello", persona="main")["reply"]

# TANYA chat (live streaming, word-by-word over /ws)
with TanyaChatStream(client.base_url, client.token, "tell me a story") as stream:
    for chunk in stream:
        print(chunk, end="", flush=True)

# TANYA Mobile Native
client.mobile_register_device("android", push_token="fcm-token", name="Pixel")
snapshot = client.mobile_snapshot()

# MAZA marketplace purchase flow
sf = client.marketplace_register_storefront("vendor-1", "My Shop")
listing = client.marketplace_create_listing(sf["storefront"]["id"], "Basket", "crafts", 1500, stock=5)
cart = client.marketplace_cart("buyer-1")
cart = client.marketplace_add_to_cart(cart["cart"]["id"], listing["listing"]["id"], 2)
order = client.marketplace_checkout(cart["cart"]["id"])

# Cloud autoscaling
group = client.cloud_autoscale_create("web", region_id, template_id, 0, 4, cooldown_ms=60000)
decision = client.cloud_autoscale_evaluate(group["group"]["id"], cpu=0.95)
```

## Errors

- `JataQiError` — HTTP error with `.status`, `.code`, `.detail`
- `JataQiUnauthorized` — 401/403 (missing/expired token or RBAC denial)
- `TanyaStreamError` — the gateway streamed a `tanya.error` frame

## Tests

```bash
cd clients/python
python3 -m unittest discover -s tests -v   # boots a real gateway via the CLI
```

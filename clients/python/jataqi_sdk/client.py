# JATA Qi Python SDK — typed-ish HTTP client.
#
# Uses only the standard library (urllib.request). Every method returns the
# parsed JSON payload; errors surface as JataQiError (HTTP status + code) or
# JataQiUnauthorized (401/403).

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional


class JataQiError(Exception):
    """API error with HTTP status and optional server code/detail."""

    def __init__(self, message: str, status: int, code: Optional[str] = None, detail: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.detail = detail


class JataQiUnauthorized(JataQiError):
    """Raised on 401/403 — the token is missing, expired, or lacks RBAC."""


class JataQiClient:
    """HTTP client for the JATA Qi gateway (mirrors @jataqi/sdk)."""

    def __init__(self, base_url: str, token: Optional[str] = None, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self._token = token
        self.timeout = timeout

    # ---- auth ----------------------------------------------------------------

    @property
    def token(self) -> Optional[str]:
        return self._token

    def login(self, username: str, password: str) -> Dict[str, Any]:
        r = self.request("POST", "/auth/login", {"username": username, "password": password})
        self._token = r["token"]
        return r

    def register(self, username: str, password: str, roles: Optional[list] = None) -> Dict[str, Any]:
        return self.request("POST", "/auth/register", {"username": username, "password": password, "roles": roles or ["developer"]})

    def whoami(self) -> Dict[str, Any]:
        return self.request("GET", "/whoami")

    def logout(self) -> Dict[str, Any]:
        try:
            return self.request("POST", "/auth/logout")
        finally:
            self._token = None

    # ---- system ---------------------------------------------------------------

    def health(self) -> Dict[str, Any]:
        return self.request("GET", "/health")

    def readiness(self, category: Optional[str] = None) -> Dict[str, Any]:
        return self.request("GET", "/readiness", query={"category": category} if category else None)

    def stats(self) -> Dict[str, Any]:
        return self.request("GET", "/stats")

    # ---- QiL ------------------------------------------------------------------

    def qil_run(self, source: str) -> Dict[str, Any]:
        return self.request("POST", "/qil", {"program": source})

    def qil_objective(self, objective: str) -> Dict[str, Any]:
        return self.request("POST", "/objective", {"objective": objective})

    # ---- TANYA ---------------------------------------------------------------

    def tanya_chat(self, message: str, persona: Optional[str] = None,
                   conversation_id: Optional[str] = None, org_id: Optional[str] = None,
                   model_routing: bool = False) -> Dict[str, Any]:
        body = {"message": message}
        if persona:
            body["persona"] = persona
        if conversation_id:
            body["conversationId"] = conversation_id
        if org_id:
            body["orgId"] = org_id
        if model_routing:
            body["modelRouting"] = True
        return self.request("POST", "/tanya/chat", body)

    def tanya_personas(self) -> Dict[str, Any]:
        return self.request("GET", "/tanya/personas")

    def tanya_conversations(self, org_id: Optional[str] = None) -> Dict[str, Any]:
        return self.request("GET", "/tanya/conversations", query={"orgId": org_id} if org_id else None)

    def tanya_conversation(self, conversation_id: str) -> Dict[str, Any]:
        return self.request("GET", "/tanya/conversation", query={"id": conversation_id})

    def tanya_stats(self) -> Dict[str, Any]:
        return self.request("GET", "/tanya/stats")

    def tanya_share(self, conversation_id: str, recipient_user_id: Optional[str] = None,
                    email: Optional[str] = None) -> Dict[str, Any]:
        body = {"conversationId": conversation_id}
        if recipient_user_id:
            body["recipientUserId"] = recipient_user_id
        if email:
            body["email"] = email
        return self.request("POST", "/tanya/share", body)

    # ---- mobile native ----------------------------------------------------------

    def mobile_register_device(self, platform: str, push_token: Optional[str] = None,
                               name: Optional[str] = None, locale: Optional[str] = None) -> Dict[str, Any]:
        body = {"platform": platform}
        if push_token:
            body["pushToken"] = push_token
        if name:
            body["name"] = name
        if locale:
            body["locale"] = locale
        return self.request("POST", "/mobile/devices", body)

    def mobile_devices(self) -> Dict[str, Any]:
        return self.request("GET", "/mobile/devices")

    def mobile_snapshot(self) -> Dict[str, Any]:
        return self.request("GET", "/mobile/snapshot")

    def mobile_notify(self, title: str, body: str, event: Optional[str] = None) -> Dict[str, Any]:
        payload = {"title": title, "body": body}
        if event:
            payload["event"] = event
        return self.request("POST", "/mobile/notify", payload)

    def mobile_sync_outbox(self, messages: list) -> Dict[str, Any]:
        return self.request("POST", "/mobile/outbox", {"messages": messages})

    def mobile_emit_push(self, user_id: str, title: str, body: str, event: Optional[str] = None) -> Dict[str, Any]:
        payload = {"userId": user_id, "title": title, "body": body}
        if event:
            payload["event"] = event
        return self.request("POST", "/mobile/push", payload)

    # ---- marketplace (MAZA) ------------------------------------------------------

    def marketplace_stats(self) -> Dict[str, Any]:
        return self.request("GET", "/marketplace/stats")

    def marketplace_listings(self, category: Optional[str] = None) -> Dict[str, Any]:
        return self.request("GET", "/marketplace/listings", query={"category": category} if category else None)

    def marketplace_create_listing(self, storefront_id: str, title: str, category: str,
                                   price_minor: int, currency: Optional[str] = None,
                                   stock: Optional[int] = None) -> Dict[str, Any]:
        body = {"storefrontId": storefront_id, "title": title, "category": category, "priceMinor": price_minor}
        if currency:
            body["currency"] = currency
        if stock is not None:
            body["stock"] = stock
        return self.request("POST", "/marketplace/listings", body)

    def marketplace_register_storefront(self, vendor_id: str, name: str) -> Dict[str, Any]:
        return self.request("POST", "/marketplace/storefronts", {"vendorId": vendor_id, "name": name})

    def marketplace_cart(self, buyer_id: str) -> Dict[str, Any]:
        return self.request("POST", "/marketplace/cart", {"buyerId": buyer_id})

    def marketplace_add_to_cart(self, cart_id: str, listing_id: str, quantity: int = 1) -> Dict[str, Any]:
        return self.request("POST", "/marketplace/cart/items", {"cartId": cart_id, "listingId": listing_id, "quantity": quantity})

    def marketplace_checkout(self, cart_id: str) -> Dict[str, Any]:
        return self.request("POST", "/marketplace/checkout", {"cartId": cart_id})

    def marketplace_orders(self, buyer_id: Optional[str] = None) -> Dict[str, Any]:
        return self.request("GET", "/marketplace/orders", query={"buyerId": buyer_id} if buyer_id else None)

    def marketplace_order_refund(self, order_id: str) -> Dict[str, Any]:
        return self.request("POST", "/marketplace/order/refund", {"orderId": order_id})

    def marketplace_payouts(self, vendor_id: Optional[str] = None) -> Dict[str, Any]:
        return self.request("GET", "/marketplace/payouts", query={"vendorId": vendor_id} if vendor_id else None)

    # ---- commerce + payments -------------------------------------------------------

    def commerce_plans(self) -> Dict[str, Any]:
        return self.request("GET", "/commerce/plans")

    def commerce_analytics(self) -> Dict[str, Any]:
        return self.request("GET", "/commerce/analytics")

    def commerce_subscribe(self, customer_id: str, plan_slug: str, trial: bool = False) -> Dict[str, Any]:
        body = {"customerId": customer_id, "planSlug": plan_slug}
        if trial:
            body["trial"] = True
        return self.request("POST", "/commerce/subscribe", body)

    def commerce_invoice(self, customer_id: str, plan_slug: str, currency: Optional[str] = None) -> Dict[str, Any]:
        body = {"customerId": customer_id, "planSlug": plan_slug}
        if currency:
            body["currency"] = currency
        return self.request("POST", "/commerce/invoice", body)

    def commerce_invoice_pay(self, invoice_id: str, payment_ref: Optional[str] = None) -> Dict[str, Any]:
        body = {"id": invoice_id}
        if payment_ref:
            body["paymentRef"] = payment_ref
        return self.request("POST", "/commerce/invoice/pay", body)

    def commerce_invoices(self, customer_id: str) -> Dict[str, Any]:
        return self.request("GET", "/commerce/invoices", query={"customerId": customer_id})

    def commerce_billing_state(self, customer_id: str) -> Dict[str, Any]:
        return self.request("GET", "/commerce/billing-state", query={"customerId": customer_id})

    def payments_providers(self) -> Dict[str, Any]:
        return self.request("GET", "/payments/providers")

    def payments_mpesa_stk_push(self, customer_id: str, amount_minor: int, phone: str,
                                currency: str = "KES", reference: Optional[str] = None,
                                description: Optional[str] = None) -> Dict[str, Any]:
        body = {"customerId": customer_id, "amount": amount_minor, "phone": phone, "currency": currency}
        if reference:
            body["reference"] = reference
        if description:
            body["description"] = description
        return self.request("POST", "/payments/mpesa/stk-push", body)

    # ---- cloud ---------------------------------------------------------------------

    def cloud_stats(self) -> Dict[str, Any]:
        return self.request("GET", "/cloud/stats")

    def cloud_instances(self) -> Dict[str, Any]:
        return self.request("GET", "/cloud/instances")

    def cloud_register_region(self, name: str, code: str, country: str, zones: list) -> Dict[str, Any]:
        return self.request("POST", "/cloud/regions", {"name": name, "code": code, "country": country, "zones": zones})

    def cloud_register_flavor(self, name: str, tier: str, vcpu: int, ram_gb: int,
                              disk_gb: int, price_per_hour_minor: int) -> Dict[str, Any]:
        return self.request("POST", "/cloud/flavors", {
            "name": name, "tier": tier, "vcpu": vcpu, "ramGb": ram_gb,
            "diskGb": disk_gb, "pricePerHourMinor": price_per_hour_minor,
        })

    def cloud_register_image(self, name: str, os_name: str, version: str) -> Dict[str, Any]:
        return self.request("POST", "/cloud/images", {"name": name, "os": os_name, "version": version})

    def cloud_provision_instance(self, name: str, region_id: str, flavor_id: str, image_id: str) -> Dict[str, Any]:
        return self.request("POST", "/cloud/instances", {
            "name": name, "regionId": region_id, "flavorId": flavor_id, "imageId": image_id,
        })

    def cloud_autoscale_create(self, name: str, region_id: str, template_instance_id: str,
                               min_count: int, max_count: int, cooldown_ms: Optional[int] = None) -> Dict[str, Any]:
        body = {"name": name, "regionId": region_id, "templateInstanceId": template_instance_id,
                "min": min_count, "max": max_count}
        if cooldown_ms is not None:
            body["cooldownMs"] = cooldown_ms
        return self.request("POST", "/cloud/autoscaling", body)

    def cloud_autoscale_evaluate(self, group_id: str, cpu: Optional[float] = None,
                                 memory: Optional[float] = None, requests_per_minute: Optional[int] = None) -> Dict[str, Any]:
        body = {"groupId": group_id}
        if cpu is not None:
            body["cpu"] = cpu
        if memory is not None:
            body["memory"] = memory
        if requests_per_minute is not None:
            body["requestsPerMinute"] = requests_per_minute
        return self.request("POST", "/cloud/autoscaling/evaluate", body)

    def cloud_autoscale_history(self, group_id: Optional[str] = None) -> Dict[str, Any]:
        return self.request("GET", "/cloud/autoscaling/history", query={"groupId": group_id} if group_id else None)

    # ---- PKI / IdP -------------------------------------------------------------------

    def pki_idp_rotate(self, refresh_token: str, client_id: str, client_secret: str) -> Dict[str, Any]:
        return self.request("POST", "/pki/idp/rotate", {
            "refreshToken": refresh_token, "clientId": client_id, "clientSecret": client_secret,
        })

    def pki_idp_console_login(self, client_id: str, client_secret: str) -> Dict[str, Any]:
        r = self.request("POST", "/pki/idp/console-login", {"clientId": client_id, "clientSecret": client_secret})
        if r.get("session", {}).get("token"):
            self._token = r["session"]["token"]
        return r

    # ---- notifications / audit / org ------------------------------------------------

    def notifications_list(self) -> Dict[str, Any]:
        return self.request("GET", "/notifications")

    def notifications_send(self, type_: str, title: str, body: Optional[str] = None) -> Dict[str, Any]:
        payload = {"type": type_, "title": title}
        if body:
            payload["body"] = body
        return self.request("POST", "/notify", payload)

    def audit_list(self, limit: int = 50) -> Dict[str, Any]:
        return self.request("GET", "/audit", query={"limit": str(limit)})

    def orgs_mine(self) -> Dict[str, Any]:
        return self.request("GET", "/orgs")

    # ---- core request machinery -------------------------------------------------------

    def request(self, method: str, path: str, body: Any = None, query: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {"content-type": "application/json", "accept": "application/json"}
        if self._token:
            headers["authorization"] = f"Bearer {self._token}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            detail = None
            code = None
            try:
                payload = json.loads(e.read().decode("utf-8"))
                detail = payload
                if isinstance(payload, dict):
                    code = payload.get("code") or payload.get("error")
            except Exception:
                payload = None
            message = f"HTTP {e.code} on {method} {path}"
            if isinstance(payload, dict) and payload.get("error"):
                message = str(payload["error"])
            if e.code in (401, 403):
                raise JataQiUnauthorized(message, e.code, code, detail) from e
            raise JataQiError(message, e.code, code, detail) from e
        except urllib.error.URLError as e:
            raise JataQiError(f"network error: {e.reason}", 0) from e

# JATA Qi Python SDK — HTTP client tests against a live gateway.

import unittest

from jataqi_sdk import JataQiClient, JataQiError, JataQiUnauthorized

from server import GatewayServer


class JataQiClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = GatewayServer().start()
        cls.base = cls.server.base_url

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.stop()

    def setUp(self) -> None:
        self.admin = JataQiClient(self.base)
        self.admin.login("admin", "admin")

    # ---- auth + system -----------------------------------------------------

    def test_health_and_auth(self):
        c = JataQiClient(self.base)
        h = c.health()
        self.assertEqual(h["status"], "healthy")
        self.assertTrue(h["booted"])
        c.register("py-user", "pw123", ["developer"])
        login = c.login("py-user", "pw123")
        self.assertTrue(login["token"])
        me = c.whoami()
        self.assertEqual(me["principal"]["username"], "py-user")

    def test_unauthorized_raises(self):
        c = JataQiClient(self.base)
        with self.assertRaises(JataQiUnauthorized):
            c.whoami()

    def test_qil_run(self):
        r = self.admin.qil_run('MISSION "python sdk" { REASON REPORT }')
        self.assertEqual(r["result"]["status"], "completed")
        self.assertTrue(r["result"]["finalReport"])

    def test_qil_objective(self):
        r = self.admin.qil_objective("Summarize the mission")
        self.assertEqual(r["result"]["status"], "completed")

    # ---- TANYA -------------------------------------------------------------

    def test_tanya_chat_and_personas(self):
        r = self.admin.tanya_chat("hello from python")
        self.assertTrue(r["reply"])
        self.assertTrue(r["conversationId"])
        personas = self.admin.tanya_personas()
        self.assertTrue(len(personas["personas"]) >= 1)
        convs = self.admin.tanya_conversations()
        self.assertTrue(convs["total"] >= 1)

    def test_tanya_share(self):
        # Register a peer platform user, then share by userId.
        peer = JataQiClient(self.base)
        peer.register("py-peer", "pw123", ["developer"])
        peer.login("py-peer", "pw123")
        peer_id = peer.whoami()["principal"]["userId"]
        r = self.admin.tanya_chat("share me")
        share = self.admin.tanya_share(r["conversationId"], recipient_user_id=peer_id)
        self.assertEqual(share["share"]["conversationId"], r["conversationId"])
        self.assertEqual(share["share"]["recipientUserId"], peer_id)

    # ---- mobile native -----------------------------------------------------

    def test_mobile_device_and_snapshot(self):
        reg = self.admin.mobile_register_device("android", push_token="py-fcm-1", name="PyTest")
        self.assertEqual(reg["device"]["platform"], "android")
        devices = self.admin.mobile_devices()
        self.assertEqual(devices["count"], 1)
        snap = self.admin.mobile_snapshot()
        self.assertEqual(snap["userId"], self.admin.whoami()["principal"]["userId"])

    def test_mobile_notify_and_outbox(self):
        notify = self.admin.mobile_notify("Hello", "From python")
        self.assertGreaterEqual(notify["delivered"], 0)
        outbox = self.admin.mobile_sync_outbox([{"id": "py-om-1", "message": "Offline from python"}])
        self.assertEqual(outbox["results"][0]["status"], "sent")

    # ---- marketplace (MAZA purchase flow) ----------------------------------

    def test_marketplace_purchase_flow(self):
        sf = self.admin.marketplace_register_storefront("py-vendor", "Python Shop")
        listing = self.admin.marketplace_create_listing(sf["storefront"]["id"], "Py Basket", "crafts", 2000, stock=5)
        cart = self.admin.marketplace_cart("py-buyer")
        cart = self.admin.marketplace_add_to_cart(cart["cart"]["id"], listing["listing"]["id"], 2)
        self.assertEqual(cart["cart"]["totalMinor"], 4000)
        order = self.admin.marketplace_checkout(cart["cart"]["id"])
        self.assertEqual(order["order"]["status"], "paid")
        orders = self.admin.marketplace_orders(buyer_id="py-buyer")
        self.assertEqual(orders["count"], 1)
        payouts = self.admin.marketplace_payouts(vendor_id="py-vendor")
        self.assertEqual(payouts["count"], 1)
        refund = self.admin.marketplace_order_refund(order["order"]["id"])
        self.assertEqual(refund["order"]["status"], "refunded")

    # ---- cloud autoscaling -------------------------------------------------

    def test_cloud_autoscale_flow(self):
        region = self.admin.cloud_register_region("Nairobi", "NBO", "KE", ["nbo-1"])
        flavor = self.admin.cloud_register_flavor("vps-2", "vps", 2, 4, 80, 500)
        image = self.admin.cloud_register_image("Ubuntu 24.04", "ubuntu", "24.04")
        inst = self.admin.cloud_provision_instance(
            "py-template", region["region"]["id"], flavor["flavor"]["id"], image["image"]["id"])
        group = self.admin.cloud_autoscale_create(
            "py-web", region["region"]["id"], inst["instance"]["id"], 0, 3, cooldown_ms=60_000)
        out = self.admin.cloud_autoscale_evaluate(group["group"]["id"], cpu=0.95)
        self.assertEqual(out["result"]["action"], "scale_out")
        blocked = self.admin.cloud_autoscale_evaluate(group["group"]["id"], cpu=0.95)
        self.assertEqual(blocked["result"]["action"], "none")
        self.assertIn("cooldown", blocked["result"]["reason"])
        history = self.admin.cloud_autoscale_history(group["group"]["id"])
        self.assertGreaterEqual(history["count"], 2)

    # ---- PKI / notifications / audit / org ---------------------------------

    def test_notifications_and_audit(self):
        sent = self.admin.notifications_send("info", "Python hello")
        self.assertTrue(sent["notification"])
        inbox = self.admin.notifications_list()
        self.assertGreaterEqual(inbox["unread"], 1)
        audit = self.admin.audit_list(limit=10)
        self.assertGreaterEqual(audit["count"], 1)

    def test_orgs(self):
        orgs = self.admin.orgs_mine()
        self.assertIn("organizations", orgs)

    def test_error_handling(self):
        with self.assertRaises(JataQiError) as ctx:
            self.admin.tanya_chat("")  # empty message rejected
        self.assertGreaterEqual(ctx.exception.status, 400)

    # ---- commerce + payments -------------------------------------------------

    def test_commerce_plans_and_analytics(self):
        plans = self.admin.commerce_plans()
        self.assertGreaterEqual(len(plans["plans"]), 6)
        analytics = self.admin.commerce_analytics()
        self.assertIn("mrr", analytics)

    def test_commerce_invoice_flow_and_billing_state(self):
        me = self.admin.whoami()["principal"]["userId"]
        sub = self.admin.commerce_subscribe(me, "business")
        self.assertEqual(sub["subscription"]["status"], "ACTIVE")
        inv = self.admin.commerce_invoice(me, "business")
        self.assertIn("invoice", inv)
        invoices = self.admin.commerce_invoices(me)
        self.assertGreaterEqual(len(invoices["invoices"]), 1)
        state = self.admin.commerce_billing_state(me)
        self.assertEqual(state["state"]["customerId"], me)
        self.assertEqual(state["state"]["invoices"]["outstanding"], 1)

    def test_payments_providers_surface(self):
        providers = self.admin.payments_providers()
        ids = {p["id"]: p for p in providers["providers"]}
        self.assertIn("stripe", ids)
        self.assertIn("mpesa", ids)
        # Fresh server without payment keys: both not configured.
        self.assertFalse(ids["mpesa"]["configured"])

    def test_mpesa_stk_push_unconfigured_raises(self):
        with self.assertRaises(JataQiError) as ctx:
            self.admin.payments_mpesa_stk_push("u_x", 100, "254712345678")
        self.assertEqual(ctx.exception.status, 503)


if __name__ == "__main__":
    unittest.main()

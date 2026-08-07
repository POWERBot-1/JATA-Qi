# M-Pesa (Daraja) Payment Rail — Validation Report

- **Date:** 2026-08-07T14:34:02.318Z
- **Mode:** production (CLI serve, filesystem storage, admin bootstrap; Daraja emulated via MPESA_API_BASE mock; webhook HMAC enforced)
- **Checks:** 19/19 passed · 0 failed

## Results
- ✅ 1.1 production boot (v1.0.0 tree, filesystem storage) — fsRoot=/tmp/jataqi-mpesa-gvVW7O
- ✅ 1.2 exact version deployed — 1.0.0
- ✅ 1.3 mpesa provider registered on boot — modules=68
- ✅ 2.1 operator authenticated
- ✅ 2.2 subscription + invoice created — invoice=3b5ae404-3c87-4ee8-a95f-06a6d17f1c3d
- ✅ 3.1 STK Push initiated against Daraja (201) — intent=ws_CO_2026080712345678901234567890
- ✅ 3.2 intent status requires_action (customer approval pending)
- ✅ 3.3 Daraja OAuth bearer used for STK Push — auth=Bearer tok_s…
- ✅ 3.4 auth required for STK Push initiation
- ✅ 3.5 unauthenticated STK Push rejected — status=401
- ✅ 4.1 signed callback accepted (200)
- ✅ 4.2 callback → invoice PAID (commercial side effect) — paid=1
- ✅ 5.1 tampered HMAC rejected (400)
- ✅ 5.2 missing signature header rejected (400)
- ✅ 5.3 failed callback acked with payment_failed (no side effects)
- ✅ 5.4 unregistered intent acked but not attributed
- ✅ 6.1 no payment secrets in client responses
- ✅ 6.2 no payment secrets in server logs — log redaction check
- ✅ 6.3 billing state consistent at end (paid>=1) — paid=1

## Coverage
- STK Push initiation (OAuth bearer, CheckoutRequestID attribution, minor-unit conversion)
- Safaricom-style STK callback with operator HMAC (`x-mpesa-signature`, sha256 over exact raw body)
- Commercial side effects: callback → invoice PAID
- Negative paths: tampered HMAC 400, missing header 400, failed callback acked as payment_failed, unregistered intent not attributed
- Hygiene: no payment secrets in client responses or server logs

## Notes
- Real Daraja calls require production MPESA_CONSUMER_KEY/SECRET/SHORTCODE/PASSKEY + a public HTTPS callback URL (MPESA_CALLBACK_URL); the flow above is byte-identical except the API endpoint.
- The pending-intent registry (CheckoutRequestID → customer) is in-memory; callbacks for intents initiated before a restart fall back to AccountReference and are otherwise safely ignored.

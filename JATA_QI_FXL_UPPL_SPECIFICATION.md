# JATA Qi — FXL™ & UPPL v1.0 Specification

**Status:** Canonical Architecture Specification  
**Components:** Fingerprint Experience Layer (FXL™) & Universal Prompt-to-Payment Layer (UPPL v1.0)

---

## PART I: SUPREME FINGERPRINT EXPERIENCE LAYER (FXL™)

**Designation:** JATA Qi FXL™ — Fingerprint Experience Layer  
**Mantra:** *One Intelligence. One Platform. No Two Experiences Alike.*

### Core Principles
1. **Experience Fingerprint™:** Evolving machine-readable representation of how an individual user prefers to navigate, communicate, create, purchase, and interact with AI.
2. **Supreme Experience Loop:** `OBSERVE → UNDERSTAND → PREDICT → COMPOSE → PRESENT → LEARN → ADAPT`.
3. **Zero-Clutter Intelligence:** "Show me what I need. Hide what I don't."
4. **Living Command Surface™:** Dynamic dashboard rearranging cards, modules, tools, and workflows according to user objectives.
5. **Intent-First Interface:** Prioritizes natural-language intent over deep navigation menus.
6. **One-Touch Compression:** Intelligently compresses repeated workflows into single actions.
7. **Absolute Safety Boundary:** Personalization changes presentation and workflow composition, but NEVER overrides RBAC, ABAC, authorization, or security policies.

---

## PART II: UNIVERSAL PROMPT-TO-PAYMENT LAYER (UPPL v1.0)

**Designation:** UPPL v1.0 — Universal, Provider-Neutral, Promptable Commerce Infrastructure  
**Mission:** Enable any authorized JATA Qi application, agent, merchant, or user to initiate and execute payments through natural language or structured commands without being tightly coupled to any individual payment provider.

### Core Payment Pipeline
`HUMAN/AGENT INTENT → PAYMENT INTENT → PAYMENT POLICY → PROVIDER DISCOVERY → ROUTING → USER AUTHORIZATION → PAYMENT EXECUTION → SETTLEMENT → VERIFICATION → UNIVERSAL RECEIPT → LEDGER`

### Key Architecture Components
1. **Canonical PaymentIntent:** Provider-independent state machine object (`DRAFT → VALIDATED → REQUIRES_AUTHORIZATION → AUTHORIZED → ROUTING → PROCESSING → SUCCEEDED`).
2. **Provider-Neutral Payment Adapter:** Strict interface (`create_payment`, `authorize_payment`, `execute_payment`, `verify_payment`, etc.) abstracting M-Pesa, bank transfers, cards, and wallets.
3. **Universal Payment Method Registry:** Dynamic advertisement of payment method capabilities, limits, fees, and currencies.
4. **Intelligent Payment Router:** Policy-driven routing based on user preference, currency, geography, fees, speed, and reliability.
5. **Payment Policy & Agent Authority:** Spending limits, transaction categories, and mandatory user confirmation/biometric authentication.
6. **Currency & Wallet Abstraction:** Explicit `amount + currency` records, exchange rate verification, and multi-currency ledger support.
7. **Idempotency & Verification:** Mandatory idempotency keys and multi-source reconciliation (`PaymentVerificationService`) ensuring settled truth.
8. **Security Boundary:** AI model is *never* the trust authority. Payment credentials never enter the language model. Dry-run support (`DRY_RUN = true`) and strict production activation gates (`LIVE_PAYMENT_ENABLED=true`).

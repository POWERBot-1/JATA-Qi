# TANYA Mobile — React Native reference app

An Expo (React Native) scaffold that demonstrates the full **TANYA Mobile
Native** surface against a running JATA Qi gateway. It is deliberately small:
all platform logic lives in the framework-neutral
[`@jataqi/mobile-app`](../../packages/mobile-app) controller, and this app is
four screens of thin wiring over it.

```
┌─────────────────────────── @jataqi/mobile-app (controller) ───────────────────────────┐
│ auth persistence · device heartbeat · home snapshot · streaming chat · offline        │
│ outbox · push feed · silent IdP rotation                                              │
└───────────────────────────────────────────────────────────────────────────────────────┘
        ▲                                  ▲
        │ uses                             │ uses
┌───────┴──────────┐            ┌──────────┴───────────┐
│ @jataqi/sdk      │            │ this Expo app        │
│ JataQiClient     │            │ Login · Home · Chat  │
│ StreamingClient  │            │ · Settings           │
└──────────────────┘            └──────────────────────┘
```

## What each screen demonstrates

| Screen | Controller surface | Notes |
| ------ | ------------------ | ----- |
| **Login** | `login` / `register`, `registerDevice` | Gateway URL is editable and persisted in AsyncStorage; device registration is idempotent per push token. |
| **Home** | `loadHome(refresh)` (one-call snapshot) | Personas, organizations, recent conversations, shared/approval counts; pull-to-refresh; offline outbox badge. |
| **Chat** | `streamMessage` → `StreamingClient.tanyaChat` (`tanya.chunk` frames), `listConversations`, `getConversation` | Word-by-word streaming bubble; persona chips; conversation picker. When the socket/server is unreachable the message is **queued offline** and flushed with ✈️ Sync (`syncOutbox`). |
| **Settings** | `sessionStatus`, `rotateNow`, `listDevices`, `unregisterDevice`, IdP credentials | Live session countdown (15s poll); silent refresh-token rotation via the PKI IdP bridge (RFC 6819); device removal; logout. |

Push feed: `subscribePush` listens to `mobile.push.sent`,
`notification.created`, and `conversation.shared_to` over the gateway `/ws`
channel — the same events that drive the server-side event → push bridge.

## Run it

1. Build the workspace and start a gateway:

   ```bash
   cd ../..   # repo root
   npm install
   npm run build
   node packages/cli/dist/src/index.js serve 7400
   ```

2. Install this app's dependencies and start Expo:

   ```bash
   cd examples/react-native-app
   npm install          # pulls expo/react-native + file-links @jataqi/sdk, @jataqi/mobile-app
   npm start            # scan the QR code with Expo Go
   ```

3. Sign in with an existing platform user (or create one) — `admin`/`admin`
   works out of the box on a fresh server.

## Type-check without the Expo toolchain

The monorepo CI has no React Native toolchain, so this folder ships a
self-contained check that compiles the screens against the real
`@jataqi/sdk` / `@jataqi/mobile-app` sources using ambient shims
(`src/types/shims.d.ts`):

```bash
npm run typecheck      # tsc -p tsconfig.typecheck.json --noEmit
```

Use `tsconfig.json` (extends `expo/tsconfig.base`) when developing for real.

## Push notifications

The controller registers whatever push token you hand it. In a production app
you would obtain the token from `expo-notifications` (or FCM/APNs directly)
and pass it through `buildController({ pushToken })`. The server-side
`MobileModule` then emits deterministic APNs + FCM payloads for that device,
and the event → push bridge (`conversation.shared_to`, `notification.created`,
generic `mobile.push.requested`) turns platform events into pushes.

## Silent session rotation

Provision a per-user IdP client (PKI `consoleLogin` / OIDC), store the three
credentials in Settings → IdP credentials, and the app will rotate the
platform session before expiry without re-prompting for a password.

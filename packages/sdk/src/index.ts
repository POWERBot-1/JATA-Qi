// JATA Qi SDK — Public API.
//
// The SDK provides two modes:
//
// 1. **Remote (HTTP) mode** — connect to a running JATA Qi server:
//    ```ts
//    import { JataQiClient } from '@jataqi/sdk';
//    const client = new JataQiClient({ baseUrl: 'http://localhost:7400' });
//    await client.auth.login('alice', 'pw');
//    const r = await client.qil.run('MISSION "x" { REASON REPORT }');
//    ```
//
// 2. **Local (embedded) mode** — boot a full kernel in-process:
//    ```ts
//    import { createJataQi } from '@jataqi/sdk/local';
//    const qi = await createJataQi();
//    ```

export { JataQiClient } from './client.js';
export { StreamingClient } from './streaming.js';
export type { StreamingClientOptions, StreamHandlers, StreamMessage, StreamResult } from './streaming.js';
export type { JataQiClientOptions } from './client.js';
export { JataQiError } from './client.js';
export {
  AuthClient, HealthClient, IdentityClient, ReadinessClient,
  KnowledgeClient, AgentClient, QiLClient, WorkflowClient,
  ToolsClient, DevicesClient, TwinsClient, ModelsClient,
  SimulateClient, TeamClient, CommerceClient, CommerceStatsClient,
  OrgClient, NotificationsClient, FlagsClient, GovClient,
  MediaClient, MFAClient, PkiClient, AuditClient, TanyaClient, AlertsClient, MobileClient,
  MarketplaceClient, CloudClient, DefenseClient, SocClient, SupplyChainClient, InfraClient, ResilienceClient, PrivacyClient, ReviewClient, SecautoClient, DlpClient, PqcClient, ProductMarketplaceClient, OnboardingClient, OperationsClient,
} from './client.js';

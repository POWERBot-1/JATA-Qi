// Multi-user vertical slice (Phase 5 roadmap) — walks the full platform
// collaboration story end-to-end in one process:
//
//   1. IdP-first login — a user-bound console client's secret alone mints
//      a platform session (client-credentials grant, no password)
//   2. Organization — create an org, invite a colleague, colleague accepts
//   3. Org-scoped TANYA chat — both users chat inside the org
//   4. Sharing — owner shares the conversation with the colleague
//      (and via the IdP identity bridge by email)
//   5. Session rotation hardening — refresh-token rotation + revocation
//   6. Governance SLA alerts + audit export (CSV/JSON compliance handoff)
//
// Run: node examples/multi-user.mjs

import { createJataQi } from '../packages/cli/dist/src/bootstrap.js';
import { auditCsv } from '../packages/security/dist/src/index.js';

const qi = await createJataQi({ security: { bootstrapAdmin: { username: 'root', password: 'toor' } } });
const kernel = qi.kernel;
const sec = kernel.getModule('security');
const pki = kernel.getModule('pki');
const orgs = kernel.getModule('organizations');
const tanya = kernel.getModule('tanya');
const tools = kernel.getModule('tool-intelligence');
const audit = sec.getAuditLog();

// --- 1. Two platform users -------------------------------------------------
await sec.registerUser('alice', 'pw-alice', ['developer']);
await sec.registerUser('bob', 'pw-bob', ['analyst']);
console.log('1. users alice + bob registered');

// --- 2. IdP-first login (client-credentials grant) --------------------------
// Alice links an IdP identity and gets a user-bound console client.
pki.idp.upsertUser('alice-id', { preferred_username: 'alice', roles: ['developer'], email: 'alice@jataqi.local' });
const aliceClient = pki.registerIdpClient({ name: 'alice-console', redirectUris: ['https://console.jataqi.local/ui'], userId: 'alice-id' });

const login = await pki.consoleLogin({ clientId: aliceClient.clientId, clientSecret: aliceClient.clientSecret });
if (!login.ok) throw new Error(`IdP login failed: ${login.reason}`);
console.log(`2. IdP-first login OK — platform session for ${login.principal.username} (no password)`);

// --- 3. Organization + invite + accept --------------------------------------
const org = await orgs.createOrganization('Acme', 'alice-id', 'acme');
const invitation = await orgs.invite(org.id, 'bob@jataqi.local', 'member', 'alice-id');
// Bob accepts (his platform user id is the invite target — the console
// resolves IdP emails to platform users; here we accept directly).
const bobUser = await sec.getUser('bob');
await orgs.acceptInvitation(invitation.token, bobUser.id);
// Bob links his IdP identity (the console does this at login time) so the
// sharing bridge can resolve his email to his platform user id.
tanya.registerIdentity({ sub: bobUser.id, email: 'bob@jataqi.local', preferred_username: 'bob' });
console.log(`3. org ${org.name} created; bob invited + accepted`);

// --- 4. Org-scoped TANYA chat + sharing -------------------------------------
const chat = await tanya.chat({ userId: 'alice-id', message: 'Welcome to the Acme org!', orgId: org.id });
const share = await tanya.shareWithIdpIdentity(chat.conversationId, 'alice-id', { email: 'bob@jataqi.local' });
const bobInbox = await tanya.sharedWithMe(bobUser.id);
console.log(`4. org chat ${chat.conversationId.slice(0, 8)}… shared with bob via IdP email (${share.via}) — inbox: ${bobInbox.length}`);

// --- 5. Session rotation hardening ------------------------------------------
// Fresh code flow for alice → rotate → old refresh token dies.
const { code } = pki.idpAuthorize({ clientId: aliceClient.clientId, redirectUri: 'https://console.jataqi.local/ui', userId: 'alice-id' });
const tokens = pki.idpToken({ code, clientId: aliceClient.clientId, clientSecret: aliceClient.clientSecret, redirectUri: 'https://console.jataqi.local/ui' });
const rotated = await pki.rotateSession({ refreshToken: tokens.refresh_token, clientId: aliceClient.clientId, clientSecret: aliceClient.clientSecret });
const stale = await pki.rotateSession({ refreshToken: tokens.refresh_token, clientId: aliceClient.clientId, clientSecret: aliceClient.clientSecret });
const revoke = pki.idpRevoke(rotated.idpTokens.access_token);
console.log(`5. rotation OK (new refresh token issued, old revoked: stale=${!stale.ok}); revoke access token: ${revoke}`);

// --- 6. Governance SLA alerts + audit export ---------------------------------
const sla = await tools.evaluateSlaRules();
const auditRecs = await audit.query({ limit: 10 });
const csv = auditCsv(auditRecs);
console.log(`6. SLA rules: ${sla.alerts.map((a) => `${a.id}=${a.state}`).join(', ')}`);
console.log(`   audit export CSV (${csv.split('\r\n').length - 1} rows):`);
console.log(csv.split('\r\n').slice(0, 2).join('\n'));

await qi.shutdown();
console.log('\n✓ multi-user vertical slice complete');

// JATA Qi Admin Console — SPA (vanilla JS, no build step).
// Uses fetch() to the same-origin API gateway. Covers the platform surface:
// system health, readiness, agent tools governance, adaptive dashboards,
// TANYA conversational AI, digital memory, learning, search, FX, and the PRX
// engine views (cloud / CDN / email / IPAM).

const state = { token: null, principal: null, view: 'dashboard', data: {}, conv: null, personas: [], expiresAt: null, authNotice: '', feed: [], feedUnsub: null };
let feedToastTimer = null;
const $ = (s) => document.querySelector(s);
const app = $('#app');

// --- API helper ---
async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers['authorization'] = `Bearer ${state.token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // Expired / revoked session — drop auth and return to the login screen.
    if (res.status === 401 && state.token && !path.startsWith('/auth/')) {
      // Try one silent rotation before forcing a fresh login.
      if (!state._rotating) {
        state._rotating = true;
        rotateIdpSession().then((rotated) => {
          state._rotating = false;
          if (rotated) { render(); return; }
          stopLiveFeed();
          state.token = null; state.principal = null; state.expiresAt = null;
          localStorage.removeItem('jq_token'); localStorage.removeItem('jq_principal'); localStorage.removeItem('jq_expires');
          state.authNotice = 'Your session expired — please sign in again.';
          render();
        });
      }
    }
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  return json;
}
// Like api() but returns { status, body } instead of throwing (for flows that
// expect 202 / 403 etc.).
async function apiRaw(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers['authorization'] = `Bearer ${state.token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = text; } }
  return { status: res.status, body: json };
}

// --- Auth ---
async function login(username, password) {
  const r = await api('POST', '/auth/login', { username, password });
  state.token = r.token;
  state.principal = r.principal;
  state.expiresAt = r.expiresAt ?? Date.now() + 3600_000;
  localStorage.setItem('jq_token', r.token);
  localStorage.setItem('jq_principal', JSON.stringify(r.principal));
  localStorage.setItem('jq_expires', String(state.expiresAt));
  state.authNotice = '';
  localStorage.setItem('jq_last_username', username);
  render();
  linkIdpSession(r.principal, username); // best-effort, never blocks login
}
async function registerAndLogin(username, password) {
  await api('POST', '/auth/register', { username, password, roles: ['developer'] });
  await login(username, password);
}

// --- IdP session linking + rotation (deep PKI IdP integration) ---
// After password login, the console links an IdP session (registers a
// console client once, upserts the IdP profile with the user's roles,
// runs the authorization-code flow) and stores the refresh token so the
// platform session can be silently rotated when it expires.
async function linkIdpSession(principal, username) {
  try {
    const key = idpClientKey(username);
    if (localStorage.getItem(key)) return;
    // First-party client bound to this platform user — its secret is the
    // credential for IdP-first login (client-credentials grant).
    const client = await api('POST', '/pki/idp/clients', { name: 'jataqi-console', redirectUris: [location.origin + '/ui'], userId: principal.userId });
    localStorage.setItem(key, JSON.stringify(client));
    localStorage.setItem('jq_idp_client', JSON.stringify(client)); // legacy alias
    await api('POST', '/pki/idp/profile', { sub: principal.userId, preferred_username: username, roles: principal.roles });
    const authz = await api('POST', '/pki/idp/authorize', { clientId: client.clientId, redirectUri: location.origin + '/ui', scope: 'openid profile', userId: principal.userId });
    const tokens = await api('POST', '/pki/idp/token', { code: authz.code, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri: location.origin + '/ui' });
    if (tokens.refresh_token) {
      localStorage.setItem('jq_idp_tokens', JSON.stringify({ refresh_token: tokens.refresh_token, access_token: tokens.access_token, expires_in: tokens.expires_in }));
    }
  } catch { /* non-admin or IdP unavailable — rotation stays disabled */ }
}
function idpClientKey(username) { return `jq_idp_client_${(username || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}`; }
function idpClientStored(username) {
  try { return JSON.parse(localStorage.getItem(idpClientKey(username)) || localStorage.getItem('jq_idp_client')); } catch { return null; }
}
/** IdP-first login: exchange the stored bound client's secret for a platform session (no password). */
async function consoleLoginIdp(username) {
  const client = idpClientStored(username);
  if (!client?.clientId || !client?.clientSecret) return null;
  try {
    const r = await fetch('/pki/idp/console-login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret, scope: 'openid profile' }),
    });
    if (!r.ok) return null;
    const result = await r.json();
    if (!result.ok || !result.session) return null;
    state.token = result.session.token;
    state.principal = result.principal;
    state.expiresAt = result.session.expiresAt;
    localStorage.setItem('jq_token', result.session.token);
    localStorage.setItem('jq_principal', JSON.stringify(result.principal));
    localStorage.setItem('jq_expires', String(result.session.expiresAt));
    if (result.idpTokens?.access_token) {
      let refresh = result.idpTokens.refresh_token || null;
      if (!refresh) { try { refresh = JSON.parse(localStorage.getItem('jq_idp_tokens')).refresh_token; } catch { /* none */ } }
      localStorage.setItem('jq_idp_tokens', JSON.stringify({ refresh_token: refresh, access_token: result.idpTokens.access_token, expires_in: result.idpTokens.expires_in }));
    }
    return result.principal;
  } catch { return null; }
}
/** Silently rotate the platform session via the IdP refresh token. */
async function rotateIdpSession() {
  const client = idpClientStored(state.principal?.username);
  const tokens = (() => { try { return JSON.parse(localStorage.getItem('jq_idp_tokens')); } catch { return null; } })();
  if (!client || !tokens?.refresh_token) return false;
  try {
    const r = await fetch('/pki/idp/rotate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refresh_token, clientId: client.clientId, clientSecret: client.clientSecret }),
    });
    if (!r.ok) return false;
    const result = await r.json();
    if (!result.ok || !result.session) return false;
    state.token = result.session.token;
    state.principal = result.principal;
    state.expiresAt = result.session.expiresAt;
    localStorage.setItem('jq_token', result.session.token);
    localStorage.setItem('jq_principal', JSON.stringify(result.principal));
    localStorage.setItem('jq_expires', String(result.session.expiresAt));
    if (result.idpTokens?.access_token) {
      // Refresh-token rotation: persist the NEW refresh token (the old one
      // was revoked server-side on first use).
      localStorage.setItem('jq_idp_tokens', JSON.stringify({ refresh_token: result.idpTokens.refresh_token || tokens.refresh_token, access_token: result.idpTokens.access_token, expires_in: result.idpTokens.expires_in }));
    }
    return true;
  } catch { return false; }
}
function logout() {
  stopLiveFeed();
  // Revoke-on-logout parity: invalidate the stored IdP tokens so a stolen
  // refresh token cannot outlive the session.
  const tokens = (() => { try { return JSON.parse(localStorage.getItem('jq_idp_tokens')); } catch { return null; } })();
  if (tokens?.refresh_token || tokens?.access_token) {
    fetch('/pki/idp/revoke', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokens.refresh_token || tokens.access_token }),
    }).catch(() => {});
    localStorage.removeItem('jq_idp_tokens');
  }
  api('POST', '/auth/logout').catch(() => {});
  state.token = null; state.principal = null; state.expiresAt = null;
  localStorage.removeItem('jq_token'); localStorage.removeItem('jq_principal'); localStorage.removeItem('jq_expires');
  render();
}
/** Restore a stored session only when the token is still live (expiry-aware). */
async function checkStoredAuth() {
  const t = localStorage.getItem('jq_token');
  const p = localStorage.getItem('jq_principal');
  const exp = Number(localStorage.getItem('jq_expires') ?? 0);
  if (!t || !p) return false;
  if (exp && exp < Date.now()) {
    localStorage.removeItem('jq_token'); localStorage.removeItem('jq_principal'); localStorage.removeItem('jq_expires');
    state.authNotice = 'Your session expired — please sign in again.';
    return false;
  }
  try {
    const s = await api('GET', '/auth/session');
    if (!s?.ok) throw new Error('session invalid');
    state.token = t; state.principal = JSON.parse(p); state.expiresAt = s.expiresAt;
    localStorage.setItem('jq_expires', String(s.expiresAt));
    return true;
  } catch {
    localStorage.removeItem('jq_token'); localStorage.removeItem('jq_principal'); localStorage.removeItem('jq_expires');
    return false;
  }
}
/** Countdown + auto-logout when the session expires. */
function startSessionTimer() {
  if (state._sessionTimer) clearInterval(state._sessionTimer);
  state._sessionTimer = setInterval(() => {
    if (!state.token || !state.expiresAt) return;
    const el = $('#session-countdown');
    const remaining = state.expiresAt - Date.now();
    if (el) {
      if (remaining <= 0) el.textContent = 'expired';
      else {
        const s = Math.floor(remaining / 1000);
        el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }
    }
    if (remaining <= 0) {
      clearInterval(state._sessionTimer);
      // Silent rotation first: if an IdP refresh token is stored, re-mint the
      // platform session without bothering the user.
      rotateIdpSession().then((rotated) => {
        if (rotated) { render(); return; }
        stopLiveFeed();
        state.token = null; state.principal = null; state.expiresAt = null;
        localStorage.removeItem('jq_token'); localStorage.removeItem('jq_principal'); localStorage.removeItem('jq_expires');
        state.authNotice = 'Your session expired — please sign in again.';
        render();
      });
    }
  }, 1000);
}

// --- Navigation ---
const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'tanya', label: 'TANYA Chat', icon: '💬' },
  { id: 'qil', label: 'QiL Console', icon: '🧪' },
  { id: 'dashboards', label: 'Adaptive Dashboards', icon: '📐' },
  { id: 'search', label: 'Search', icon: '🔎' },
  { id: 'memory', label: 'Memory', icon: '🧠' },
  { id: 'learning', label: 'Learning', icon: '📈' },
  { id: 'fx', label: 'FX', icon: '💱' },
  { id: 'cloud', label: 'Cloud', icon: '☁️' },
  { id: 'cdn', label: 'CDN', icon: '🌐' },
  { id: 'email', label: 'Email', icon: '✉️' },
  { id: 'ipam', label: 'IPAM', icon: '🗂️' },
  { id: 'automations', label: 'Automations', icon: '⏰' },
  { id: 'tools', label: 'Tools', icon: '🔧' },
  { id: 'approvals', label: 'Approvals', icon: '✅' },
  { id: 'alerts', label: 'Governance Alerts', icon: '🚨' },
  { id: 'audit', label: 'Audit Trail', icon: '📜' },
  { id: 'health', label: 'System Health', icon: '💚' },
  { id: 'identity', label: 'Creator Identity', icon: '🔐' },
  { id: 'readiness', label: 'Readiness', icon: '✅' },
  { id: 'agents', label: 'Ask Agent', icon: '🤖' },
  { id: 'workflows', label: 'Workflows', icon: '⚡' },
  { id: 'models', label: 'Models', icon: '🧠' },
  { id: 'knowledge', label: 'Knowledge', icon: '📚' },
  { id: 'commerce', label: 'Commerce', icon: '💳' },
  { id: 'organizations', label: 'Organizations', icon: '🏢' },
  { id: 'orgs', label: 'My Orgs', icon: '👥' },
  { id: 'notifications', label: 'Notifications', icon: '🔔' },
  { id: 'governance', label: 'Governance', icon: '⚖️' },
  { id: 'devices', label: 'Devices', icon: '📡' },
  { id: 'twins', label: 'Digital Twins', icon: '🔄' },
  { id: 'flags', label: 'Feature Flags', icon: '🚩' },
];

// --- Views ---
async function loadView(view) {
  state.view = view;
  const content = $('.main-content') || app;
  content.innerHTML = `<div class="card"><div class="spinner"></div></div>`;
  try {
    const data = await VIEWS[view]?.();
    if (data) { state.data[view] = data; renderView(view, data); }
    else renderView(view, null);
  } catch (e) {
    content.innerHTML = `<div class="card"><p style="color:var(--red)">Error: ${e.message}</p></div>`;
  }
}

const VIEWS = {
  dashboard: async () => {
    const [health, readiness, tools, tanya] = await Promise.allSettled([
      api('GET', '/health'), api('GET', '/readiness/summary'), api('GET', '/tools'), api('GET', '/tanya/stats'),
    ]);
    return {
      health: health.status === 'fulfilled' ? health.value : null,
      readiness: readiness.status === 'fulfilled' ? readiness.value : null,
      tools: tools.status === 'fulfilled' ? tools.value : null,
      tanya: tanya.status === 'fulfilled' ? tanya.value : null,
    };
  },
  health: async () => api('GET', '/health'),
  identity: async () => { const [info, verify] = await Promise.all([api('GET', '/identity'), api('GET', '/identity/verify')]); return { info, verify }; },
  readiness: async () => api('GET', '/readiness'),
  agents: async () => api('POST', '/ask', { question: 'Give a one-line platform status summary.' }),
  workflows: async () => api('GET', '/workflows'),
  tools: async () => {
    const [tools, approvals, gstats] = await Promise.allSettled([
      api('GET', '/tools'), api('GET', '/approvals'), api('GET', '/tools/governance-stats'),
    ]);
    return {
      tools: tools.status === 'fulfilled' ? tools.value : null,
      approvals: approvals.status === 'fulfilled' ? approvals.value : null,
      gstats: gstats.status === 'fulfilled' ? gstats.value : null,
    };
  },
  models: async () => api('GET', '/models'),
  knowledge: async () => api('GET', '/stats'),
  commerce: async () => { const [plans, analytics] = await Promise.all([api('GET', '/commerce/plans'), api('GET', '/commerce/analytics')]); return { plans, analytics }; },
  organizations: async () => api('GET', '/orgs'),
  notifications: async () => api('GET', '/notifications'),
  governance: async () => api('GET', '/gov/policies'),
  devices: async () => api('GET', '/devices'),
  twins: async () => api('GET', '/twins'),
  flags: async () => api('GET', '/flags'),

  approvals: async () => {
    const [pending, history, gstats] = await Promise.allSettled([
      api('GET', '/approvals'), api('GET', '/approvals?status=all'), api('GET', '/tools/governance-stats'),
    ]);
    scheduleRefresh('approvals', 10_000);
    return {
      pending: pending.status === 'fulfilled' ? pending.value.approvals : [],
      history: history.status === 'fulfilled' ? history.value.approvals : [],
      gstats: gstats.status === 'fulfilled' ? gstats.value : null,
    };
  },

  audit: async () => {
    const [approval, denied, login, total] = await Promise.allSettled([
      api('GET', '/audit?action=tool.approval.decided'), api('GET', '/audit?action=tool.approval.required'),
      api('GET', '/audit?action=auth.login&limit=10'), api('GET', '/audit?limit=50'),
    ]);
    return {
      approval: approval.status === 'fulfilled' ? approval.value.records : [],
      denied: denied.status === 'fulfilled' ? denied.value.records : [],
      login: login.status === 'fulfilled' ? login.value.records : [],
      total: total.status === 'fulfilled' ? total.value.records : [],
    };
  },

  orgs: async () => {
    const [mine, members] = await Promise.allSettled([
      api('GET', '/orgs'), api('GET', '/org/members'),
    ]);
    return {
      organizations: mine.status === 'fulfilled' ? mine.value.organizations : [],
      members: members.status === 'fulfilled' ? members.value.members : [],
    };
  },

  alerts: async () => {
    const [alerts, gstats] = await Promise.allSettled([
      api('GET', '/governance/alerts'), api('GET', '/tools/governance-stats'),
    ]);
    scheduleRefresh('alerts', 15_000);
    return {
      alerts: alerts.status === 'fulfilled' ? alerts.value.alerts : [],
      checkedAt: alerts.status === 'fulfilled' ? alerts.value.checkedAt : null,
      gstats: gstats.status === 'fulfilled' ? gstats.value : null,
    };
  },

  // --- QiL console (interactive) ---
  qil: async () => null,

  // --- TANYA AI ---
  tanya: async () => {
    const [convs, personas, orgs] = await Promise.allSettled([
      api('GET', '/tanya/conversations'), api('GET', '/tanya/personas'), api('GET', '/orgs'),
    ]);
    state.conv = null;
    state.personas = personas.status === 'fulfilled' ? personas.value.personas : [];
    state.myOrgs = orgs.status === 'fulfilled' ? orgs.value.organizations : [];
    return {
      conversations: convs.status === 'fulfilled' ? convs.value.conversations : [],
      personas: state.personas,
      myOrgs: state.myOrgs,
    };
  },
  dashboards: async () => {
    const [layouts, widgets, analytics, gstats, rt] = await Promise.allSettled([
      api('GET', '/dashboard/layouts'), api('GET', '/dashboard/widgets'), api('GET', '/dashboard/analytics'),
      api('GET', '/tools/governance-stats'), api('GET', '/realtime/stats'),
    ]);
    return {
      layouts: layouts.status === 'fulfilled' ? layouts.value.layouts : [],
      widgets: widgets.status === 'fulfilled' ? widgets.value.widgets : [],
      analytics: analytics.status === 'fulfilled' ? analytics.value.analytics : null,
      gstats: gstats.status === 'fulfilled' ? gstats.value : null,
      rt: rt.status === 'fulfilled' ? rt.value : null,
    };
  },
  search: async (q) => {
    if (q) return api('GET', `/search?q=${encodeURIComponent(q)}`);
    return null;
  },
  memory: async () => {
    const [stats, recent] = await Promise.allSettled([
      api('GET', '/memory/stats'), api('GET', '/memory?limit=15'),
    ]);
    return {
      stats: stats.status === 'fulfilled' ? stats.value.stats : null,
      events: recent.status === 'fulfilled' ? recent.value.events : [],
    };
  },
  learning: async () => {
    const [insights, recommendations] = await Promise.allSettled([
      api('GET', '/learning/insights'), api('GET', '/learning/recommendations'),
    ]);
    return {
      insights: insights.status === 'fulfilled' ? insights.value.insights : [],
      recommendations: recommendations.status === 'fulfilled' ? recommendations.value.recommendations : [],
    };
  },
  fx: async () => {
    const [rates, stats, currencies] = await Promise.allSettled([
      api('GET', '/fx/rates'), api('GET', '/fx/stats'), api('GET', '/fx/currencies'),
    ]);
    return {
      rates: rates.status === 'fulfilled' ? rates.value.rates : [],
      stats: stats.status === 'fulfilled' ? stats.value.stats : null,
      currencies: currencies.status === 'fulfilled' ? currencies.value.currencies : [],
    };
  },
  cloud: async () => {
    const [stats, instances, regions] = await Promise.allSettled([
      api('GET', '/cloud/stats'), api('GET', '/cloud/instances'), api('GET', '/cloud/regions'),
    ]);
    return {
      stats: stats.status === 'fulfilled' ? stats.value.stats : null,
      instances: instances.status === 'fulfilled' ? instances.value.instances : [],
      regions: regions.status === 'fulfilled' ? regions.value.regions : [],
    };
  },
  cdn: async () => {
    const [stats, zones] = await Promise.allSettled([
      api('GET', '/cdn/stats'), api('GET', '/cdn/zones'),
    ]);
    return {
      stats: stats.status === 'fulfilled' ? stats.value.stats : null,
      zones: zones.status === 'fulfilled' ? zones.value.zones : [],
    };
  },
  email: async () => {
    const [stats, domains] = await Promise.allSettled([
      api('GET', '/email/stats'), api('GET', '/email/domains'),
    ]);
    return {
      stats: stats.status === 'fulfilled' ? stats.value.stats : null,
      domains: domains.status === 'fulfilled' ? domains.value.domains : [],
    };
  },
  ipam: async () => {
    const [stats, blocks, announcements] = await Promise.allSettled([
      api('GET', '/ipam/stats'), api('GET', '/ipam/blocks'), api('GET', '/ipam/announcements'),
    ]);
    return {
      stats: stats.status === 'fulfilled' ? stats.value.stats : null,
      blocks: blocks.status === 'fulfilled' ? blocks.value.blocks : [],
      announcements: announcements.status === 'fulfilled' ? announcements.value.announcements : [],
    };
  },
  automations: async () => {
    const [list, stats] = await Promise.allSettled([
      api('GET', '/automations'), api('GET', '/automations/stats'),
    ]);
    return {
      automations: list.status === 'fulfilled' ? list.value.automations : [],
      stats: stats.status === 'fulfilled' ? stats.value : null,
    };
  },
};

// --- View rendering ---
function statCard(label, value, color) {
  return `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value" ${color ? `style="color:var(--${color})"` : ''}>${value ?? '—'}</div></div>`;
}
function esc(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return esc(JSON.stringify(v, null, 0).slice(0, 80));
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function tableFrom(rows, cols) {
  if (!rows || rows.length === 0) return '<p style="color:var(--text-dim)">No data.</p>';
  const keys = cols || Object.keys(rows[0]).slice(0, 6);
  let html = `<table><thead><tr>${keys.map((k) => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>`;
  rows.forEach((r) => {
    html += `<tr>${keys.map((k) => `<td>${esc(r[k])}</td>`).join('')}</tr>`;
  });
  return html + '</tbody></table>';
}

// --- View auto-refresh ------------------------------------------------------
const refreshTimers = {};
function scheduleRefresh(view, intervalMs) {
  if (refreshTimers[view]) return; // one timer per view
  refreshTimers[view] = setTimeout(() => {
    delete refreshTimers[view];
    if (state.view === view && state.token) loadView(view);
  }, intervalMs);
}

function renderView(view, data) {
  const el = $('.main-content');
  if (!el) return;
  const title = NAV.find((n) => n.id === view)?.label || view;
  let html = `<div class="header"><h1>${title}</h1></div>`;

  if (!data) {
    if (view === 'search') {
      el.innerHTML = html + `<div class="card">
        <div class="form-group"><label>Search the platform (knowledge, memory, graph, conversations, tools)</label>
        <div style="display:flex;gap:8px"><input id="search-q" placeholder="e.g. certificate, mobility, cloud..." autofocus>
        <button class="btn-primary" onclick="doSearch()">Search</button></div></div>
        <div id="search-results"></div></div>`;
      return;
    }
    el.innerHTML = html + '<div class="card"><p>No data.</p></div>';
    return;
  }

  if (view === 'dashboard') {
    const h = data.health, r = data.readiness;
    html += `<div class="stat-grid">
      ${statCard('Status', h?.status, 'green')}
      ${statCard('Modules', h?.modules?.length ?? 0)}
      ${statCard('Uptime', h ? Math.round(h.uptimeMs / 1000) + 's' : null)}
      ${statCard('Capabilities', r?.total ?? null)}
      ${statCard('Production Ready', r?.productionReady ?? null, 'red')}
      ${statCard('Not Implemented', r?.notImplemented ?? null, 'yellow')}
      ${statCard('Governed Tools', data.tools?.count ?? null)}
      ${statCard('TANYA Conversations', data.tanya?.conversations ?? null)}
    </div>`;
    if (r?.overall) html += `<div class="card"><div class="card-title">Overall</div><p>${esc(r.overall)}</p></div>`;
  } else if (view === 'qil') {
    html += `<div class="card">
      <div class="card-title">QiL Live Execution</div>
      <p style="color:var(--text-dim);font-size:13px;margin-bottom:10px">Run a QiL program (source) or a natural-language objective. Steps stream live over /ws as they execute.</p>
      <div class="form-group"><label>Program or objective</label>
      <textarea id="qil-input" rows="6" placeholder='MISSION "Analyze my business"\nRETRIEVE "business"\nREASON "business"\nREPORT' style="font-family:monospace"></textarea></div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <button class="btn-primary" onclick="runQiL('objective')">Run Objective</button>
        <button class="btn-ghost" onclick="runQiL('source')">Run QiL Source</button>
      </div>
      <div id="qil-log" class="qil-log"><p style="color:var(--text-dim)">No runs yet.</p></div>
    </div>`;
  } else if (view === 'tanya') {
    html += `<div class="card">
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <select id="tanya-persona" style="max-width:200px"><option value="main">main</option></select>
        <select id="tanya-conv" style="flex:1;min-width:220px"><option value="">— new conversation —</option></select>
        <select id="tanya-org" style="max-width:220px"><option value="">— no org scope —</option></select>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-dim)"><input type="checkbox" id="tanya-model-routing"> model router</label>
        <button class="btn-ghost" onclick="loadTanyaConversation('')">New</button>
      </div>
      <div id="tanya-messages" class="chat-log">
        <p style="color:var(--text-dim)">Send a message to start chatting with TANYA.</p>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <input id="tanya-input" placeholder="Ask TANYA anything..." autofocus>
        <button class="btn-primary" onclick="sendTanya()">Send</button>
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">EXPORT CURRENT CONVERSATION</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn-ghost" onclick="exportTanyaConversation('json')">Export JSON</button>
          <button class="btn-ghost" onclick="exportTanyaConversation('markdown')">Export Markdown</button>
          <button class="btn-ghost" onclick="exportTanyaConversation('text')">Export Text</button>
        </div>
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">SHARE CURRENT CONVERSATION (multi-user)</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input id="tanya-share-email" placeholder="recipient email (IdP identity)" style="flex:1;min-width:200px">
          <input id="tanya-share-user" placeholder="or platform userId" style="flex:1;min-width:200px">
          <button class="btn-ghost" onclick="shareTanyaConversation()">Share</button>
          <button class="btn-ghost" onclick="createTanyaShareLink()">🔗 Public link</button>
        </div>
        <div id="tanya-sharelink" style="margin-top:8px;font-size:12px"></div>
        <div id="tanya-shared" style="margin-top:10px"></div>
      </div>
    </div>`;
    // populate personas + conversations after render
    setTimeout(() => {
      const pSel = $('#tanya-persona');
      (state.personas || []).forEach((p) => {
        if (p.id !== 'main') pSel.insertAdjacentHTML('beforeend', `<option value="${esc(p.id)}">${esc(p.name)}</option>`);
      });
      // Org-aware TANYA: populate the org selector from my orgs and default
      // to the first org (org-scoped conversations surface automatically).
      const oSel = $('#tanya-org');
      if (oSel) {
        (state.myOrgs || []).forEach((o, idx) => {
          oSel.insertAdjacentHTML('beforeend', `<option value="${esc(o.id)}">${esc(o.name)}</option>`);
        });
        if (state.myOrgs?.length) {
          oSel.value = state.myOrgs[0].id;
          // Reload the conversation list scoped to the default org.
          api('GET', `/tanya/conversations?orgId=${encodeURIComponent(state.myOrgs[0].id)}`).then((r) => {
            const cSel = $('#tanya-conv');
            if (!cSel) return;
            cSel.innerHTML = '<option value="">— new conversation —</option>';
            (r.conversations || []).forEach((c) => cSel.insertAdjacentHTML('beforeend', `<option value="${esc(c.id)}">${esc(c.title)} (${c.messageCount})</option>`));
          }).catch(() => {});
        }
      }
      const cSel = $('#tanya-conv');
      (data.conversations || []).forEach((c) => {
        cSel.insertAdjacentHTML('beforeend', `<option value="${esc(c.id)}">${esc(c.title)} (${c.messageCount})</option>`);
      });
      // Shared-with-me inbox.
      api('GET', '/tanya/shared').then((r) => {
        const box = $('#tanya-shared');
        if (!box) return;
        const convs = r.conversations || [];
        box.innerHTML = convs.length === 0
          ? '<p style="color:var(--text-dim);font-size:12px">No conversations shared with you yet.</p>'
          : '<div style="font-size:12px;color:var(--text-dim);margin-bottom:6px">SHARED WITH ME</div>' + convs.map((c) => `<div class="feed-item"><span>📥</span><div><div class="feed-type">${esc(c.title)}</div><div class="feed-dim">by ${esc(c.ownerId)}</div></div></div>`).join('');
      }).catch(() => {});
    }, 0);
  } else if (view === 'dashboards') {
    const g = data.gstats || {};
    html += `<div class="stat-grid">
      ${statCard('Layouts', data.layouts?.length ?? 0)}
      ${statCard('Widget Types', data.widgets?.length ?? 0)}
      ${statCard('Adaptations', data.analytics?.adaptations ?? null)}
      ${statCard('Users', data.analytics?.users ?? null)}
      ${statCard('WS Clients', data.rt?.clients ?? null, (data.rt?.clients ?? 0) > 0 ? 'green' : null)}
      ${statCard('WS Total', data.rt?.totalConnections ?? null)}
      ${statCard('WS Uptime', data.rt?.uptimeMs != null ? Math.round(data.rt.uptimeMs / 1000) + 's' : null)}
    </div>
    <div class="card"><div class="card-title">Create Layout</div>
      <div style="display:flex;gap:8px"><input id="layout-name" placeholder="Layout name">
      <button class="btn-primary" onclick="createLayout()">Create</button></div></div>
    <div class="card"><div class="card-title">Layouts</div><div id="layouts-body">${tableFrom(data.layouts, ['id', 'name', 'ownerId', 'columns', 'widgets'])}</div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <input id="layout-id" placeholder="layout id"><button class="btn-ghost" onclick="adaptLayout()">AI-Adapt</button>
        <button class="btn-ghost" onclick="autoArrange()">Auto-arrange</button>
      </div></div>
    <div class="card"><div class="card-title">Available Widgets</div>${tableFrom(data.widgets, ['id', 'name', 'category', 'roles'])}</div>
    <div class="card"><div class="card-title">Tool Governance Widgets</div>
      <p style="color:var(--text-dim);font-size:13px;margin-bottom:12px">Live widget data from the governed tool registry (add these widgets to a layout via the registry above).</p>
      <div class="stat-grid">
        ${statCard('Governed Tools', g.tools?.total ?? null)}
        ${statCard('Agent Tools', g.tools?.agentTools ?? null)}
        ${statCard('R4 Gated', g.tools?.approvalGated ?? null, 'yellow')}
        ${statCard('Invocations', g.invocations?.total ?? 0)}
        ${statCard('Avg Duration', g.avgDurationMs != null ? g.avgDurationMs + ' ms' : null)}
        ${statCard('ALLOW', g.decisions?.byDecision?.ALLOW ?? 0, 'green')}
        ${statCard('DENY', g.decisions?.byDecision?.DENY ?? 0, 'red')}
        ${statCard('Pending Approvals', g.approvals?.pending ?? 0, (g.approvals?.pending ?? 0) ? 'yellow' : 'green')}
      </div>
      <div id="gov-approvals" style="margin-top:12px">${(g.approvals?.pending ?? 0) === 0 ? '<p style="color:var(--text-dim)">No pending approvals.</p>' : `<p style="color:var(--yellow)">${g.approvals.pending} approval request(s) awaiting review — see the Tools view.</p>`}</div>
    </div>`;
  } else if (view === 'search') {
    html += `<div class="card">
      <div class="form-group"><label>Search the platform (knowledge, memory, graph, conversations, tools)</label>
      <div style="display:flex;gap:8px"><input id="search-q" placeholder="e.g. certificate, mobility, cloud..." autofocus>
      <button class="btn-primary" onclick="doSearch()">Search</button></div></div>
      <div id="search-results"></div></div>`;
  } else if (view === 'memory') {
    const s = data.stats || {};
    html += `<div class="stat-grid">
      ${statCard('Events', s.total ?? null)}
      ${statCard('Categories', s.categories ?? null)}
      ${statCard('Users', s.users ?? null)}
      ${statCard('Orgs', s.orgs ?? null)}
    </div>
    <div class="card"><div class="card-title">Recent Events</div>${tableFrom(data.events, ['ts', 'category', 'summary', 'userId'])}</div>`;
  } else if (view === 'learning') {
    html += `<div class="card"><div class="card-title">Insights (${data.insights?.length ?? 0})</div>${tableFrom(data.insights, ['type', 'title', 'confidence', 'status'])}</div>`;
    html += `<div class="card"><div class="card-title">Recommendations (${data.recommendations?.length ?? 0})</div>${tableFrom(data.recommendations, ['action', 'title', 'priority', 'status'])}</div>`;
  } else if (view === 'fx') {
    const s = data.stats || {};
    html += `<div class="stat-grid">
      ${statCard('Pairs', s.pairs ?? data.rates?.length ?? 0)}
      ${statCard('Quotes', s.quotes ?? null)}
      ${statCard('Currencies', data.currencies?.length ?? null)}
    </div>
    <div class="card"><div class="card-title">Live Rates</div>${tableFrom(data.rates, ['pair', 'bid', 'ask', 'mid', 'source'])}</div>`;
  } else if (view === 'cloud') {
    const s = data.stats || {};
    html += `<div class="stat-grid">
      ${statCard('Regions', s.regions ?? data.regions?.length ?? 0)}
      ${statCard('Instances', s.instances ?? null)}
      ${statCard('Volumes', s.volumes ?? null)}
      ${statCard('VPCs', s.vpcs ?? null)}
      ${statCard('Load Balancers', s.loadBalancers ?? null)}
      ${statCard('Hosting Plans', s.hostingPlans ?? null)}
    </div>
    <div class="card"><div class="card-title">Regions</div>${tableFrom(data.regions, ['id', 'name', 'code', 'country', 'status', 'capacitySlots', 'usedSlots'])}</div>
    <div class="card"><div class="card-title">Instances</div>${tableFrom(data.instances, ['id', 'name', 'status', 'regionId', 'flavorId', 'publicIp'])}</div>`;
  } else if (view === 'cdn') {
    const s = data.stats || {};
    html += `<div class="stat-grid">
      ${statCard('Zones', s.zones ?? data.zones?.length ?? 0)}
      ${statCard('Nodes Online', s.nodesOnline ?? null)}
      ${statCard('Hit Rate', s.hitRate != null ? (s.hitRate * 100).toFixed(1) + '%' : null, 'green')}
      ${statCard('Cached Assets', s.cachedAssets ?? null)}
      ${statCard('Purges', s.purges ?? null)}
    </div>
    <div class="card"><div class="card-title">Zones</div>${tableFrom(data.zones, ['id', 'domain', 'origin', 'status', 'originShield', 'tlsEnabled', 'defaultTtlSec'])}</div>`;
  } else if (view === 'email') {
    const s = data.stats || {};
    html += `<div class="stat-grid">
      ${statCard('Domains', s.domains ?? data.domains?.length ?? 0)}
      ${statCard('Verified', s.verifiedDomains ?? null, 'green')}
      ${statCard('Mailboxes', s.mailboxes ?? null)}
      ${statCard('Sent', s.sent ?? null)}
      ${statCard('Delivered Rate', s.deliveredRate != null ? (s.deliveredRate * 100).toFixed(1) + '%' : null, 'green')}
      ${statCard('Spam/Quarantine', (s.spam ?? 0) + (s.quarantined ?? 0))}
    </div>
    <div class="card"><div class="card-title">Domains</div>${tableFrom(data.domains, ['id', 'domain', 'verified', 'dmarcPolicy', 'dkimSelector'])}</div>`;
  } else if (view === 'ipam') {
    const s = data.stats || {};
    html += `<div class="stat-grid">
      ${statCard('Blocks', s.blocks ?? data.blocks?.length ?? 0)}
      ${statCard('Total Addresses', s.totalAddresses ?? null)}
      ${statCard('Utilization', s.utilizationPct != null ? s.utilizationPct + '%' : null)}
      ${statCard('ASNs', s.asns ?? null)}
      ${statCard('Active ASNs', s.activeAsns ?? null)}
      ${statCard('Announcements', data.announcements?.length ?? 0)}
    </div>
    <div class="card"><div class="card-title">Blocks</div>${tableFrom(data.blocks, ['id', 'cidr', 'family', 'rir', 'status', 'purpose'])}</div>
    <div class="card"><div class="card-title">Announcements</div>${tableFrom(data.announcements, ['blockId', 'asnId', 'since'])}</div>`;
  } else if (view === 'automations') {
    const s = data.stats || {};
    html += `<div class="stat-grid">
      ${statCard('Automations', data.automations?.length ?? 0)}
      ${statCard('Executions', s.total ?? null)}
      ${statCard('Running', s.running ?? null)}
      ${statCard('Failed', s.failed ?? null)}
    </div>
    <div class="card"><div class="card-title">Automations</div>${tableFrom(data.automations, ['id', 'name', 'trigger', 'enabled', 'status'])}</div>`;
  } else if (view === 'alerts') {
    const alerts = data.alerts || [];
    const firing = alerts.filter((a) => a.state === 'firing');
    const g = data.gstats || {};
    html += `<div class="stat-grid">
      ${statCard('Firing', firing.length, firing.length ? 'red' : 'green')}
      ${statCard('Rules', alerts.length)}
      ${statCard('Pending Approvals', g.approvals?.pending ?? 0, (g.approvals?.pending ?? 0) ? 'yellow' : 'green')}
      ${statCard('DENY (window)', g.decisions?.byDecision?.DENY ?? 0, (g.decisions?.byDecision?.DENY ?? 0) > 0 ? 'yellow' : 'green')}
    </div>
    <div class="card"><div class="card-title">SLA Rules (${alerts.length})</div>
      ${alerts.map((a) => `<div class="notif-item"><div class="notif-dot" style="background:${a.state === 'firing' ? 'var(--red)' : 'var(--green)'}"></div><div><div style="font-weight:600">${a.state === 'firing' ? '🚨 ' : '✅ '}${esc(a.id)} <span class="feed-dim">${esc(a.severity)}</span></div><div style="color:var(--text-dim);font-size:13px">${esc(a.message)}</div><div style="color:var(--text-dim);font-size:12px">value ${esc(a.value)} / threshold ${esc(a.threshold)}</div></div></div>`).join('')}
    </div>
    <div class="card"><div class="card-title">Prometheus</div>
      <p style="color:var(--text-dim);font-size:13px">Mirrored as Prometheus alert rules in deploy/monitoring/prometheus-rules.yaml: <code>JataQiToolApprovalQueueHigh</code> · <code>JataQiToolGovernanceDenySpike</code> · <code>JataQiToolR4InvocationRateHigh</code>.</p></div>`;
  } else if (view === 'audit') {
    const approval = data.approval || [];
    const denied = data.denied || [];
    const login = data.login || [];
    html += `<div class="stat-grid">
      ${statCard('Decisions', approval.length, 'green')}
      ${statCard('Denied Invokes', denied.length, 'red')}
      ${statCard('Logins (10)', login.length)}
    </div>
    <div class="card"><div class="card-title">Export (compliance handoff)</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-primary" onclick="exportAudit('csv')">Export CSV</button>
        <button class="btn-ghost" onclick="exportAudit('json')">Export JSON</button>
        <select id="audit-export-scope" style="max-width:220px">
          <option value="decided">approval decisions</option>
          <option value="denied">denied invocations</option>
          <option value="logins">logins</option>
          <option value="all">all records</option>
        </select>
      </div>
    </div>
    <div class="card"><div class="card-title">Approval Decisions (ledger)</div>${tableFrom(approval, ['ts', 'action', 'actor', 'result', 'detail'])}</div>
    <div class="card"><div class="card-title">Denied High-Risk Invocations</div>${tableFrom(denied, ['ts', 'action', 'actor', 'result', 'resource'])}</div>
    <div class="card"><div class="card-title">Recent Logins</div>${tableFrom(login, ['ts', 'actor', 'action', 'result'])}</div>`;
  } else if (view === 'approvals') {
    const pending = data.pending || [];
    const history = data.history || [];
    const g = data.gstats || {};
    html += `<div class="stat-grid">
      ${statCard('Pending', pending.length, pending.length ? 'yellow' : 'green')}
      ${statCard('Approved', history.filter((a) => a.status === 'approved').length, 'green')}
      ${statCard('Denied', history.filter((a) => a.status === 'denied').length, 'red')}
      ${statCard('Expired', history.filter((a) => a.status === 'expired').length)}
      ${statCard('Total Requests', g.approvals?.requested ?? history.length)}
    </div>
    <div class="card"><div class="card-title">Approval Queue (${pending.length})</div>
      ${pending.length === 0 ? '<p style="color:var(--text-dim)">Nothing awaiting review.</p>' : pending.map((a) => `<div class="notif-item"><div class="notif-dot"></div><div><div style="font-weight:600">${esc(a.toolId)}</div><div style="color:var(--text-dim);font-size:13px">${esc(a.reason || a.action)} — requested by ${esc(a.principalId)} · ${new Date(a.createdAt).toLocaleString()}</div><div style="margin-top:6px;display:flex;gap:8px"><button class="btn-primary" onclick="decideApproval('${esc(a.id)}','approved')">Approve</button><button class="btn-danger" onclick="decideApproval('${esc(a.id)}','denied')">Deny</button></div></div></div>`).join('')}
    </div>
    <div class="card"><div class="card-title">History (${history.length})</div>${tableFrom(history, ['toolId', 'action', 'status', 'principalId', 'decidedBy', 'createdAt'])}</div>`;
  } else if (view === 'tools') {
    const tools = data.tools?.tools || [];
    const approvals = data.approvals?.approvals || [];
    const g = data.gstats || {};
    const decisions = g.decisions?.byDecision || {};
    const invs = g.invocations || {};
    html += `<div class="stat-grid">
      ${statCard('Governed Tools', g.tools?.total ?? tools.length)}
      ${statCard('Agent Tools', g.tools?.agentTools ?? null)}
      ${statCard('R4 Gated', g.tools?.approvalGated ?? tools.filter((t) => t.riskClass === 'R4').length, 'yellow')}
      ${statCard('Invocations', invs.total ?? 0)}
      ${statCard('Avg Duration', g.avgDurationMs != null ? g.avgDurationMs + ' ms' : null)}
      ${statCard('Decisions ALLOW', decisions.ALLOW ?? 0, 'green')}
      ${statCard('Decisions DENY', decisions.DENY ?? 0, 'red')}
      ${statCard('Pending Approvals', g.approvals?.pending ?? approvals.length, (g.approvals?.pending ?? approvals.length) ? 'yellow' : 'green')}
    </div>
    <div class="card"><div class="card-title">Governance Sync</div>
      <p style="color:var(--text-dim);margin-bottom:10px">Register the agent runtime's live tool surface (37 tools) into the governed registry with risk classes.</p>
      <button class="btn-primary" onclick="syncTools()">Sync Agent Tools</button>
      <span id="tools-sync-msg" style="margin-left:10px"></span></div>
    <div class="card"><div class="card-title">Pending Approvals</div>
      ${approvals.length === 0 ? '<p style="color:var(--text-dim)">None.</p>' : approvals.map((a) => `<div class="notif-item"><div class="notif-dot"></div><div><div style="font-weight:600">${esc(a.toolId)}</div><div style="color:var(--text-dim);font-size:13px">${esc(a.reason || a.action)} — requested by ${esc(a.principalId)}</div><div style="margin-top:6px;display:flex;gap:8px"><button class="btn-primary" onclick="decideApproval('${esc(a.id)}','approved')">Approve</button><button class="btn-danger" onclick="decideApproval('${esc(a.id)}','denied')">Deny</button></div></div></div>`).join('')}
    </div>
    <div class="card"><div class="card-title">Registry (${tools.length})</div>${tableFrom(tools, ['canonicalName', 'riskClass', 'privacyClass', 'status', 'category'])}</div>`;
  } else if (view === 'health') {
    html += `<div class="card"><div class="card-title">Status</div><span class="badge badge-green">${esc(data.status)}</span></div>`;
    html += `<div class="card"><div class="card-title">Modules (${data.modules?.length})</div><table><tbody>`;
    (data.modules || []).forEach((m) => { html += `<tr><td>${esc(m)}</td></tr>`; });
    html += `</tbody></table></div>`;
  } else if (view === 'identity') {
    const i = data.info;
    html += `<div class="card"><div class="card-title">Creator</div><p style="font-size:18px">${esc(i.creator?.display_name)}</p><p style="color:var(--text-dim)">${esc(i.creator?.role)}</p></div>`;
    html += `<div class="card"><div class="card-title">Integrity</div><span class="badge badge-green">Signature: ${data.verify.valid ? 'VALID' : 'INVALID'}</span></div>`;
    html += `<div class="card"><div class="card-title">Canonical Identity</div><code>${esc(i.canonical_identity)}</code></div>`;
  } else if (view === 'readiness') {
    html += `<div class="card"><table><thead><tr><th>Capability</th><th>Status</th><th>Module</th></tr></thead><tbody>`;
    (data.capabilities || []).forEach((c) => {
      const cls = c.status === 'TESTED' || c.status === 'PRODUCTION_READY' ? 'badge-green' : c.status === 'NOT_IMPLEMENTED' ? 'badge-red' : 'badge-yellow';
      html += `<tr><td>${esc(c.name)}</td><td><span class="badge ${cls}">${esc(c.status)}</span></td><td>${esc(c.module || '—')}</td></tr>`;
    });
    html += `</tbody></table></div>`;
  } else if (view === 'agents') {
    html += `<div class="card"><div class="card-title">Agent Reply</div><p style="white-space:pre-wrap">${esc(data.answer || data.reply || '—')}</p></div>`;
  } else if (view === 'orgs') {
    const orgs = data.organizations || [];
    const members = data.members || [];
    html += `<div class="card"><div class="card-title">Create Organization</div>
      <div style="display:flex;gap:8px"><input id="org-name" placeholder="Organization name">
      <button class="btn-primary" onclick="createOrg()">Create</button></div></div>
    <div class="card"><div class="card-title">My Organizations (${orgs.length})</div>
      ${orgs.length === 0 ? '<p style="color:var(--text-dim)">You are not a member of any organization yet.</p>' : orgs.map((o) => `<div class="notif-item"><div class="notif-dot"></div><div><div style="font-weight:600">${esc(o.name)} <span class="feed-dim">${esc(o.id)}</span></div><div style="color:var(--text-dim);font-size:13px">owner ${esc(o.ownerId)} · ${esc(o.slug)}</div><div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap"><input id="invite-email-${esc(o.id)}" placeholder="colleague email" style="max-width:220px"><input id="invite-user-${esc(o.id)}" placeholder="or userId" style="max-width:180px"><button class="btn-ghost" onclick="inviteToOrg('${esc(o.id)}')">Invite</button><button class="btn-ghost" onclick="copyOrgId('${esc(o.id)}')">Copy org id</button></div></div></div>`).join('')}
    </div>
    <div class="card"><div class="card-title">Accept Invitation</div>
      <div style="display:flex;gap:8px"><input id="invite-token" placeholder="paste invitation token">
      <button class="btn-ghost" onclick="acceptInvite()">Accept</button></div></div>
    <div class="card"><div class="card-title">Members</div>${tableFrom(members, ['orgId', 'userId', 'role'])}</div>
    <div class="card"><div class="card-title">Org Conversations</div>
      <div style="display:flex;gap:8px;margin-bottom:8px"><input id="org-conv-org" placeholder="org id">
      <button class="btn-ghost" onclick="loadOrgConversations()">List</button></div>
      <div id="org-conv-results"></div></div>`;
  } else if (view === 'notifications') {
    html += `<div class="card"><div class="card-title">Inbox (${data.unread} unread)</div>`;
    (data.notifications || []).forEach((n) => {
      html += `<div class="notif-item ${!n.read ? 'unread' : ''}"><div class="notif-dot"></div><div><div style="font-weight:600">${esc(n.title)}</div><div style="color:var(--text-dim);font-size:13px">${esc(n.body || '')}</div><div style="color:var(--text-dim);font-size:12px">${new Date(n.createdAt).toLocaleString()}</div></div></div>`;
    });
    html += `</div>`;
  } else {
    // Generic table view for list data.
    const items = data.tools || data.models || data.organizations || data.devices || data.twins || data.flags || data.policies || data.plans || data.runs || [];
    if (Array.isArray(items) && items.length > 0) {
      const keys = Object.keys(items[0]).slice(0, 5);
      html += `<div class="card"><table><thead><tr>${keys.map((k) => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>`;
      items.forEach((item) => { html += `<tr>${keys.map((k) => `<td>${esc(item[k])}</td>`).join('')}</tr>`; });
      html += `</tbody></table></div>`;
    } else {
      html += `<div class="card"><pre>${esc(JSON.stringify(data, null, 2).slice(0, 2000))}</pre></div>`;
    }
  }
  el.innerHTML = html;
}

// --- TANYA chat actions ---
function appendChatMessage(role, content, toolCalls) {
  const log = $('#tanya-messages');
  if (!log) return;
  const bubble = document.createElement('div');
  bubble.className = `chat-msg chat-${role}`;
  let inner = `<div class="chat-bubble">${esc(content) || '<em>…</em>'}</div>`;
  if (toolCalls && toolCalls.length) {
    inner += `<div class="chat-tools">${toolCalls.map((t) => `🔧 ${esc(t.name)}`).join(' · ')}</div>`;
  }
  bubble.innerHTML = inner;
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble.querySelector('.chat-bubble');
}
function startStreamBubble() {
  const log = $('#tanya-messages');
  const bubble = document.createElement('div');
  bubble.className = 'chat-msg chat-assistant';
  bubble.innerHTML = '<div class="chat-bubble"></div>';
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble.querySelector('.chat-bubble');
}
function finalizeStreamBubble(el, toolCalls) {
  if (!el) return;
  if (!el.textContent.trim()) el.textContent = '…';
  if (toolCalls && toolCalls.length) {
    const chips = document.createElement('div');
    chips.className = 'chat-tools';
    chips.textContent = toolCalls.map((t) => `🔧 ${t.name}`).join(' · ');
    el.parentElement.appendChild(chips);
  }
  const log = $('#tanya-messages');
  if (log) log.scrollTop = log.scrollHeight;
}
function tanyaWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`;
}
// --- Live activity feed (platform bus events over /ws) ---
const FEED_ICONS = { security: '🔐', memory: '🧠', tool: '🔧', tanya: '💬', orchestrator: '⚡', governance: '🚨' };
function feedIcon(type) {
  for (const [prefix, icon] of Object.entries(FEED_ICONS)) if (type.startsWith(prefix)) return icon;
  return '📡';
}
function addFeedEvent(type, data) {
  const entry = { type, data, ts: Date.now() };
  state.feed.unshift(entry);
  if (state.feed.length > 50) state.feed.length = 50;
  renderFeed();
  showFeedToast(entry);
}
function renderFeed() {
  const el = $('#activity-feed');
  if (!el) return;
  el.innerHTML = state.feed.length === 0
    ? '<p style="color:var(--text-dim);font-size:13px">No live events yet — platform activity will appear here.</p>'
    : state.feed.map((e) => `<div class="feed-item"><span>${feedIcon(e.type)}</span><div><div class="feed-type">${esc(e.type)}</div><div class="feed-dim">${new Date(e.ts).toLocaleTimeString()}</div></div></div>`).join('');
}
function showFeedToast(entry) {
  const el = $('#feed-toast');
  if (!el) return;
  el.textContent = `${feedIcon(entry.type)} ${entry.type}`;
  el.classList.add('visible');
  clearTimeout(feedToastTimer);
  feedToastTimer = setTimeout(() => el.classList.remove('visible'), 2500);
}
function refreshRealtimeCount() {
  if (!state.token) return;
  api('GET', '/realtime/stats').then((s) => {
    const el = $('#realtime-count');
    if (el) el.textContent = `· ${s.clients} connected`;
  }).catch(() => {});
}
function startLiveFeed() {
  if (state.feedUnsub || !state.token) return;
  refreshRealtimeCount();
  if (state._rtTimer) clearInterval(state._rtTimer);
  state._rtTimer = setInterval(refreshRealtimeCount, 30_000);
  try {
    const ws = new WebSocket(tanyaWsUrl());
    ws.onopen = () => ws.send(JSON.stringify({ op: 'subscribe', topics: ['security', 'memory', 'tool', 'tanya', 'orchestrator', 'governance'] }));
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg.type || msg.type === 'realtime.connected') return;
      addFeedEvent(msg.type, msg.data);
    };
    ws.onclose = () => { if (state.feedUnsub === ws) state.feedUnsub = null; };
    state.feedUnsub = ws;
  } catch { /* non-fatal */ }
}
function stopLiveFeed() {
  if (state.feedUnsub) { try { state.feedUnsub.close(); } catch {} state.feedUnsub = null; }
  if (state._rtTimer) { clearInterval(state._rtTimer); state._rtTimer = null; }
}

// Stream a TANYA turn over the /ws realtime channel (tanya.chunk events),
// falling back to the HTTP /tanya/chat API when the socket cannot connect.
function sendTanya() {
  const input = $('#tanya-input');
  const message = input.value.trim();
  if (!message) return;
  appendChatMessage('user', message);
  input.value = '';
  const persona = $('#tanya-persona')?.value || 'main';
  const convId = $('#tanya-conv')?.value || undefined;
  const orgId = $('#tanya-org')?.value.trim() || undefined;
  const modelRouting = $('#tanya-model-routing')?.checked === true;
  let ws;
  try { ws = new WebSocket(tanyaWsUrl()); } catch { sendTanyaHttp(message, persona, convId, orgId, modelRouting); return; }
  let finished = false;
  const fallback = () => { if (!finished) sendTanyaHttp(message, persona, convId, orgId, modelRouting); };
  ws.onerror = fallback;
  ws.onclose = () => { if (!finished) fallback(); };
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'tanya.chat', message, persona, ...(convId ? { conversationId: convId } : {}), ...(orgId ? { orgId } : {}), ...(modelRouting ? { modelRouting: true } : {}) }));
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'tanya.chunk') {
      const el = state._streamEl || (state._streamEl = startStreamBubble());
      el.textContent += msg.content;
    } else if (msg.type === 'tanya.done') {
      finished = true;
      finalizeStreamBubble(state._streamEl, msg.toolCalls);
      state._streamEl = null;
      state.conv = msg.conversationId;
      const cSel = $('#tanya-conv');
      if (cSel && !convId) {
        cSel.insertAdjacentHTML('afterbegin', `<option value="${esc(msg.conversationId)}">${esc((msg.reply || '').slice(0, 40))}…</option>`);
        cSel.value = msg.conversationId;
      }
      ws.close();
    } else if (msg.type === 'tanya.error' || msg.type === 'chat.error') {
      finished = true;
      finalizeStreamBubble(state._streamEl, []);
      state._streamEl = null;
      appendChatMessage('system', `Error: ${msg.error}`);
      ws.close();
    }
  };
}
async function sendTanyaHttp(message, persona, convId, orgId, modelRouting) {
  try {
    const result = await api('POST', '/tanya/chat', { message, persona, ...(convId ? { conversationId: convId } : {}), ...(orgId ? { orgId } : {}), ...(modelRouting ? { modelRouting: true } : {}) });
    appendChatMessage('assistant', result.reply, result.toolCalls);
    state.conv = result.conversationId;
    const cSel = $('#tanya-conv');
    if (cSel && !convId) {
      cSel.insertAdjacentHTML('afterbegin', `<option value="${esc(result.conversationId)}">${esc(result.reply.slice(0, 40))}…</option>`);
      cSel.value = result.conversationId;
    }
  } catch (e) {
    appendChatMessage('system', `Error: ${e.message}`);
  }
}
async function createOrg() {
  const name = $('#org-name')?.value.trim();
  if (!name) return;
  try { await api('POST', '/orgs', { name }); await loadView('orgs'); } catch (e) { alert(e.message); }
}
async function inviteToOrg(orgId) {
  const email = $(`#invite-email-${orgId}`)?.value.trim();
  const userId = $(`#invite-user-${orgId}`)?.value.trim();
  const target = userId || email;
  if (!target) { alert('Enter a colleague email or userId.'); return; }
  try {
    await api('POST', '/org', { id: orgId, action: 'invite', target });
    alert(`Invitation created — share the token with ${target}`);
  } catch (e) { alert(e.message); }
}
function copyOrgId(orgId) {
  navigator.clipboard?.writeText(orgId).then(() => alert('Org id copied: ' + orgId)).catch(() => alert(orgId));
}
async function loadOrgConversations() {
  const orgId = $('#org-conv-org')?.value.trim();
  if (!orgId) return;
  const box = $('#org-conv-results');
  if (!box) return;
  box.innerHTML = '<div class="spinner"></div>';
  try {
    const r = await api('GET', `/tanya/org?orgId=${encodeURIComponent(orgId)}`);
    box.innerHTML = r.count === 0
      ? '<p style="color:var(--text-dim)">No conversations in this org.</p>'
      : r.conversations.map((c) => `<div class="feed-item"><span>💬</span><div><div class="feed-type">${esc(c.title)}</div><div class="feed-dim">by ${esc(c.userId)} · ${c.messageCount} msgs</div></div></div>`).join('');
  } catch (e) {
    box.innerHTML = `<p style="color:var(--red)">${esc(e.message)}</p>`;
  }
}
async function acceptInvite() {
  const token = $('#invite-token')?.value.trim();
  if (!token) return;
  try {
    await api('POST', '/org', { id: 'invite', action: 'accept', token });
    alert('Welcome! You are now a member.');
    await loadView('orgs');
  } catch (e) { alert(e.message); }
}
async function exportAudit(format) {
  const scope = $('#audit-export-scope')?.value || 'decided';
  const filters = scope === 'decided' ? '?action=tool.approval.decided'
    : scope === 'denied' ? '?action=tool.approval.required'
    : scope === 'logins' ? '?action=auth.login' : '';
  try {
    const res = await fetch(`/audit/export${filters}${filters ? '&' : '?'}format=${format}`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) throw new Error('export failed');
    const text = await res.text();
    const blob = new Blob([text], { type: format === 'csv' ? 'text/csv' : 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-${scope}-${Date.now()}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
}
async function exportTanyaConversation(format) {
  const convId = $('#tanya-conv')?.value;
  if (!convId) { alert('Select a conversation first.'); return; }
  try {
    const res = await fetch(`/chat/export?id=${encodeURIComponent(convId)}&format=${format}`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) throw new Error('export failed');
    const text = await res.text();
    const blob = new Blob([text], { type: format === 'json' ? 'application/json' : 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversation-${convId.slice(0, 8)}.${format === 'markdown' ? 'md' : format}`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
}
async function createTanyaShareLink() {
  const convId = $('#tanya-conv')?.value;
  if (!convId) { alert('Select a conversation first.'); return; }
  try {
    const r = await api('POST', '/chat/share', { id: convId });
    const box = $('#tanya-sharelink');
    if (box) {
      const url = `${location.origin}/chat/shared?id=${r.shareId}`;
      box.innerHTML = `Public share link: <code>${esc(url)}</code> <button class="btn-ghost" onclick="navigator.clipboard.writeText('${esc(url)}').then(()=>alert('copied'))">Copy</button>`;
    }
  } catch (e) { alert(e.message); }
}
async function shareTanyaConversation() {
  const convId = $('#tanya-conv')?.value;
  if (!convId) { alert('Select a conversation first.'); return; }
  const email = $('#tanya-share-email')?.value.trim();
  const userId = $('#tanya-share-user')?.value.trim();
  if (!email && !userId) { alert('Enter a recipient email or platform userId.'); return; }
  try {
    const body = { conversationId: convId, ...(email ? { email } : {}), ...(userId ? { recipientUserId: userId } : {}) };
    const r = await api('POST', '/tanya/share', body);
    alert(`Shared: ${r.share.recipientUserId}${r.share.via ? ` (via ${r.share.via})` : ''}`);
    $('#tanya-share-email').value = '';
    $('#tanya-share-user').value = '';
  } catch (e) { alert(e.message); }
}
async function loadTanyaConversation(id) {
  if (!id) {
    const log = $('#tanya-messages');
    if (log) log.innerHTML = '<p style="color:var(--text-dim)">Send a message to start chatting with TANYA.</p>';
    return;
  }
  try {
    const conv = await api('GET', `/tanya/conversation?id=${encodeURIComponent(id)}`);
    const log = $('#tanya-messages');
    log.innerHTML = '';
    (conv.messages || []).forEach((m) => appendChatMessage(m.role, m.content, m.toolCalls));
    state.conv = conv.id;
  } catch (e) {
    appendChatMessage('system', `Error: ${e.message}`);
  }
}

// --- Dashboard layout actions ---
async function createLayout() {
  const name = $('#layout-name')?.value.trim();
  if (!name) return;
  try {
    await api('POST', '/dashboard/layouts', { name, ownerId: state.principal?.userId || 'ui' });
    await loadView('dashboards');
  } catch (e) { alert(e.message); }
}
async function adaptLayout() {
  const id = $('#layout-id')?.value.trim();
  if (!id) return;
  try {
    await api('POST', '/dashboard/adapt', { layoutId: id, userId: state.principal?.userId || 'ui' });
    await loadView('dashboards');
  } catch (e) { alert(e.message); }
}
async function autoArrange() {
  const id = $('#layout-id')?.value.trim();
  if (!id) return;
  try {
    await api('POST', '/dashboard/auto-arrange', { layoutId: id });
    await loadView('dashboards');
  } catch (e) { alert(e.message); }
}

// --- Search action ---
async function doSearch() {
  const q = $('#search-q')?.value.trim();
  const box = $('#search-results');
  if (!q || !box) return;
  box.innerHTML = '<div class="spinner"></div>';
  try {
    const result = await api('GET', `/search?q=${encodeURIComponent(q)}`);
    if (!result.hits || result.hits.length === 0) {
      box.innerHTML = '<p style="color:var(--text-dim)">No results.</p>';
      return;
    }
    box.innerHTML = `<p style="color:var(--text-dim);margin-bottom:8px">${result.total} hit(s)</p>` + result.hits
      .map((h) => `<div class="notif-item"><div><div style="font-weight:600">[${esc(h.source)}] ${esc(h.title)}</div><div style="color:var(--text-dim);font-size:13px">${esc(h.snippet)}</div><div style="color:var(--text-dim);font-size:12px">score ${esc(h.score?.toFixed ? h.score.toFixed(2) : h.score)}</div></div></div>`)
      .join('');
  } catch (e) {
    box.innerHTML = `<p style="color:var(--red)">${esc(e.message)}</p>`;
  }
}

// --- Tool governance actions ---
async function syncTools() {
  const msg = $('#tools-sync-msg');
  if (msg) msg.textContent = 'syncing…';
  try {
    const r = await api('POST', '/tools/sync', {});
    if (msg) msg.textContent = `✓ ${r.synced} tools governed (created ${r.created}, updated ${r.updated})`;
    setTimeout(() => loadView('tools'), 400);
  } catch (e) {
    if (msg) msg.textContent = `✗ ${e.message}`;
  }
}
async function decideApproval(id, decision) {
  try {
    await api('POST', '/tool/approve', { id, decision });
    if (state.view === 'approvals') await loadView('approvals');
    else await loadView('tools');
  } catch (e) { alert(e.message); }
}

// --- QiL console actions ---
function qilAppendLine(html) {
  const log = $('#qil-log');
  if (!log) return;
  if (log.querySelector('p')) log.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'qil-line';
  div.innerHTML = html;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function runQiL(mode) {
  const input = $('#qil-input');
  const text = input.value.trim();
  if (!text) return;
  const log = $('#qil-log');
  if (log) log.innerHTML = '';
  qilAppendLine(`<span class="qil-badge">▶</span> ${esc(mode)}: <code>${esc(text.slice(0, 80))}${text.length > 80 ? '…' : ''}</code>`);
  const started = Date.now();
  let ws;
  try { ws = new WebSocket(tanyaWsUrl()); } catch { qilAppendLine('<span class="qil-badge qil-err">✗</span> WebSocket unavailable'); return; }
  ws.onerror = () => qilAppendLine('<span class="qil-badge qil-err">✗</span> connection failed');
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'qil.run', [mode]: text })); };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'qil.step') {
      const st = msg.step || {};
      const cls = st.status === 'success' ? 'qil-ok' : st.status === 'error' ? 'qil-err' : 'qil-warn';
      qilAppendLine(`<span class="qil-badge ${cls}">${st.status === 'success' ? '✓' : st.status === 'error' ? '✗' : '·'}</span> [${msg.index + 1}/${msg.total}] <b>${esc(st.kind || st.keyword)}</b> ${st.error ? `<span class="qil-err">— ${esc(st.error)}</span>` : ''} <span class="qil-dim">${st.durationMs}ms</span>`);
    } else if (msg.type === 'qil.done') {
      qilAppendLine(`<span class="qil-badge ${msg.status === 'completed' ? 'qil-ok' : 'qil-err'}">${msg.status === 'completed' ? '✔' : '✖'}</span> run ${esc(msg.status)} · ${msg.stepCount} step(s) · ${Date.now() - started}ms`);
      if (msg.finalReport) qilAppendLine(`<div class="qil-report">${esc(msg.finalReport)}</div>`);
      ws.close();
    } else if (msg.type === 'qil.error') {
      qilAppendLine(`<span class="qil-badge qil-err">✗</span> ${esc(msg.error)}`);
      ws.close();
    }
  };
}

// --- Render ---
function render() {
  if (!state.token) {
    const notice = state.authNotice ? `<div class="auth-notice">${esc(state.authNotice)}</div>` : '';
    app.innerHTML = `<div class="auth-overlay"><div class="auth-box">
      <h2>🧠 JATA Qi</h2>
      <div class="auth-tabs">
        <button id="tab-signin" class="auth-tab active" onclick="setAuthTab('signin')">Sign In</button>
        <button id="tab-register" class="auth-tab" onclick="setAuthTab('register')">Create Account</button>
      </div>
      ${notice}
      <div class="form-group"><label>Username</label><input id="login-user" placeholder="admin" value="${esc(localStorage.getItem('jq_last_username') || '')}" autofocus></div>
      <div class="form-group"><label>Password</label><input id="login-pass" type="password" placeholder="••••••••"></div>
      <div class="form-group" id="login-roles-group" style="display:none"><label>Roles</label>
        <select id="login-roles"><option value="developer" selected>developer</option><option value="analyst">analyst</option></select></div>
      <div class="auth-error" id="login-err">Invalid credentials</div>
      <button class="btn-primary" style="width:100%" id="login-submit" onclick="doLogin()">Sign In</button>
      <div style="margin:14px 0;text-align:center;color:var(--text-dim);font-size:12px">— or —</div>
      <button class="btn-ghost" style="width:100%" id="login-idp" onclick="doIdpLogin()">🔑 Sign in with saved IdP session</button>
    </div></div>`;
    $('#login-pass')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    return;
  }
  app.innerHTML = `<div class="app">
    <div class="sidebar">
      <div class="sidebar-brand">🧠 JATA<span>Qi</span></div>
      ${NAV.map((n) => `<div class="nav-item ${state.view === n.id ? 'active' : ''}" onclick="loadView('${n.id}')">${n.icon} <span>${n.label}</span></div>`).join('')}
      <div style="padding:12px 16px;border-top:1px solid var(--border)">
        <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Live Activity <span id="realtime-count" style="color:var(--green)"></span></div>
        <div id="activity-feed" style="max-height:180px;overflow-y:auto;font-size:12px">
          <p style="color:var(--text-dim)">Connecting…</p>
        </div>
      </div>
      <div style="padding:16px 20px;border-top:1px solid var(--border);margin-top:auto">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">${esc(state.principal?.username)}</div>
        <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px">session <span id="session-countdown">--:--</span></div>
        <button class="btn-ghost" style="width:100%" onclick="logout()">Sign Out</button>
      </div>
    </div>
    <div class="main main-content">
      <div id="feed-toast" class="feed-toast"></div>
    </div>
  </div>`;
  loadView(state.view);
  startSessionTimer();
  startLiveFeed();
}

let authMode = 'signin';
window.setAuthTab = (mode) => {
  authMode = mode;
  $('#tab-signin').classList.toggle('active', mode === 'signin');
  $('#tab-register').classList.toggle('active', mode === 'register');
  $('#login-roles-group').style.display = mode === 'register' ? '' : 'none';
  $('#login-submit').textContent = mode === 'register' ? 'Create Account' : 'Sign In';
};
window.doIdpLogin = () => {
  const u = $('#login-user').value.trim();
  consoleLoginIdp(u || localStorage.getItem('jq_last_username') || undefined).then((principal) => {
    if (principal) {
      localStorage.setItem('jq_last_username', principal.username);
      render(); startSessionTimer();
    } else {
      $('#login-err').textContent = 'No saved IdP session for this browser — sign in with your password first.';
      $('#login-err').style.display = 'block';
    }
  });
};
window.doLogin = () => {
  const u = $('#login-user').value, p = $('#login-pass').value;
  const submit = () => authMode === 'register' ? registerAndLogin(u, p) : login(u, p);
  submit().catch(() => {
    $('#login-err').textContent = authMode === 'register'
      ? 'Registration failed (username may already exist)'
      : 'Invalid credentials';
    $('#login-err').style.display = 'block';
  });
};
window.loadView = loadView;
window.logout = logout;
window.sendTanya = sendTanya;
window.loadTanyaConversation = loadTanyaConversation;
window.createLayout = createLayout;
window.adaptLayout = adaptLayout;
window.autoArrange = autoArrange;
window.doSearch = doSearch;
window.syncTools = syncTools;
window.decideApproval = decideApproval;
window.shareTanyaConversation = shareTanyaConversation;
window.exportAudit = exportAudit;
window.exportTanyaConversation = exportTanyaConversation;
window.loadOrgConversations = loadOrgConversations;
window.runQiL = runQiL;
$('#tanya-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTanya(); });
$('#search-q')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

// PWA shell: register the service worker (offline-first console).
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('/ui/sw.js').catch(() => { /* SW optional */ });
}

// Init.
(async () => {
  if (await checkStoredAuth()) { render(); startSessionTimer(); return; }
  // IdP-first: if a bound client is stored, try passwordless login before
  // showing the login screen.
  const last = localStorage.getItem('jq_last_username') || undefined;
  if (idpClientStored(last)) {
    const principal = await consoleLoginIdp(last);
    if (principal) { render(); startSessionTimer(); return; }
  }
  render();
})();

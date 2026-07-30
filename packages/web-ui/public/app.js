// JATA Qi Admin Console — SPA (vanilla JS, no build step).
// Uses fetch() to the same-origin API gateway.

const state = { token: null, principal: null, view: 'dashboard', data: {} };
const $ = (s) => document.querySelector(s);
const app = $('#app');

// --- API helper ---
async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers['authorization'] = `Bearer ${state.token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

// --- Auth ---
async function login(username, password) {
  const r = await api('POST', '/auth/login', { username, password });
  state.token = r.token;
  state.principal = r.principal;
  localStorage.setItem('jq_token', r.token);
  localStorage.setItem('jq_principal', JSON.stringify(r.principal));
  render();
}
function logout() {
  api('POST', '/auth/logout').catch(() => {});
  state.token = null; state.principal = null;
  localStorage.removeItem('jq_token'); localStorage.removeItem('jq_principal');
  render();
}
function checkStoredAuth() {
  const t = localStorage.getItem('jq_token');
  const p = localStorage.getItem('jq_principal');
  if (t && p) { state.token = t; state.principal = JSON.parse(p); return true; }
  return false;
}

// --- Navigation ---
const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'health', label: 'System Health', icon: '💚' },
  { id: 'identity', label: 'Creator Identity', icon: '🔐' },
  { id: 'readiness', label: 'Readiness', icon: '✅' },
  { id: 'agents', label: 'Agents', icon: '🤖' },
  { id: 'workflows', label: 'Workflows', icon: '⚡' },
  { id: 'tools', label: 'Tools', icon: '🔧' },
  { id: 'models', label: 'Models', icon: '🧠' },
  { id: 'knowledge', label: 'Knowledge', icon: '📚' },
  { id: 'commerce', label: 'Commerce', icon: '💳' },
  { id: 'organizations', label: 'Organizations', icon: '🏢' },
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
    const [health, readiness] = await Promise.all([api('GET', '/health'), api('GET', '/readiness/summary')]);
    return { health, readiness };
  },
  health: async () => api('GET', '/health'),
  identity: async () => { const [info, verify] = await Promise.all([api('GET', '/identity'), api('GET', '/identity/verify')]); return { info, verify }; },
  readiness: async () => api('GET', '/readiness'),
  agents: async () => api('GET', '/commerce/analytics'),
  workflows: async () => api('GET', '/workflows'),
  tools: async () => api('GET', '/tools'),
  models: async () => api('GET', '/models'),
  knowledge: async () => api('GET', '/stats'),
  commerce: async () => { const [plans, analytics] = await Promise.all([api('GET', '/commerce/plans'), api('GET', '/commerce/analytics')]); return { plans, analytics }; },
  organizations: async () => api('GET', '/orgs'),
  notifications: async () => api('GET', '/notifications'),
  governance: async () => api('GET', '/gov/policies'),
  devices: async () => api('GET', '/devices'),
  twins: async () => api('GET', '/twins'),
  flags: async () => api('GET', '/flags'),
};

function renderView(view, data) {
  const el = $('.main-content');
  if (!el) return;
  const title = NAV.find(n => n.id === view)?.label || view;
  let html = `<div class="header"><h1>${title}</h1></div>`;

  if (!data) { el.innerHTML = html + '<div class="card"><p>No data.</p></div>'; return; }

  if (view === 'dashboard') {
    const h = data.health, r = data.readiness;
    html += `<div class="stat-grid">
      <div class="stat"><div class="stat-label">Status</div><div class="stat-value" style="color:var(--green)">${h.status}</div></div>
      <div class="stat"><div class="stat-label">Modules</div><div class="stat-value">${h.modules?.length || 0}</div></div>
      <div class="stat"><div class="stat-label">Uptime</div><div class="stat-value">${Math.round((h.uptimeMs||0)/1000)}s</div></div>
      <div class="stat"><div class="stat-label">Capabilities</div><div class="stat-value">${r.total}</div></div>
      <div class="stat"><div class="stat-label">Production Ready</div><div class="stat-value" style="color:var(--red)">${r.productionReady}</div></div>
      <div class="stat"><div class="stat-label">Not Implemented</div><div class="stat-value" style="color:var(--yellow)">${r.notImplemented}</div></div>
    </div>`;
    html += `<div class="card"><div class="card-title">Overall</div><p>${r.overall}</p></div>`;
  } else if (view === 'health') {
    html += `<div class="card"><div class="card-title">Status</div><span class="badge badge-green">${data.status}</span></div>`;
    html += `<div class="card"><div class="card-title">Modules (${data.modules?.length})</div><table><tbody>`;
    (data.modules || []).forEach(m => { html += `<tr><td>${m}</td></tr>`; });
    html += `</tbody></table></div>`;
  } else if (view === 'identity') {
    const i = data.info;
    html += `<div class="card"><div class="card-title">Creator</div><p style="font-size:18px">${i.creator?.display_name}</p><p style="color:var(--text-dim)">${i.creator?.role}</p></div>`;
    html += `<div class="card"><div class="card-title">Integrity</div><span class="badge badge-green">Signature: ${data.verify.valid ? 'VALID' : 'INVALID'}</span></div>`;
    html += `<div class="card"><div class="card-title">Canonical Identity</div><code>${i.canonical_identity}</code></div>`;
  } else if (view === 'readiness') {
    html += `<div class="card"><table><thead><tr><th>Capability</th><th>Status</th><th>Module</th></tr></thead><tbody>`;
    (data.capabilities || []).forEach(c => {
      const cls = c.status === 'TESTED' || c.status === 'PRODUCTION_READY' ? 'badge-green' : c.status === 'NOT_IMPLEMENTED' ? 'badge-red' : 'badge-yellow';
      html += `<tr><td>${c.name}</td><td><span class="badge ${cls}">${c.status}</span></td><td>${c.module || '—'}</td></tr>`;
    });
    html += `</tbody></table></div>`;
  } else if (view === 'notifications') {
    html += `<div class="card"><div class="card-title">Inbox (${data.unread} unread)</div>`;
    (data.notifications || []).forEach(n => {
      html += `<div class="notif-item ${!n.read ? 'unread' : ''}"><div class="notif-dot"></div><div><div style="font-weight:600">${n.title}</div><div style="color:var(--text-dim);font-size:13px">${n.body || ''}</div><div style="color:var(--text-dim);font-size:12px">${new Date(n.createdAt).toLocaleString()}</div></div></div>`;
    });
    html += `</div>`;
  } else {
    // Generic table view for list data.
    const items = data.tools || data.models || data.organizations || data.devices || data.twins || data.flags || data.policies || data.plans || data.runs || [];
    if (Array.isArray(items) && items.length > 0) {
      const keys = Object.keys(items[0]).slice(0, 5);
      html += `<div class="card"><table><thead><tr>${keys.map(k => `<th>${k}</th>`).join('')}</tr></thead><tbody>`;
      items.forEach(item => { html += `<tr>${keys.map(k => `<td>${typeof item[k] === 'object' ? JSON.stringify(item[k]).slice(0,50) : item[k] ?? '—'}</td>`).join('')}</tr>`; });
      html += `</tbody></table></div>`;
    } else {
      html += `<div class="card"><pre>${JSON.stringify(data, null, 2).slice(0, 2000)}</pre></div>`;
    }
  }
  el.innerHTML = html;
}

// --- Render ---
function render() {
  if (!state.token) {
    app.innerHTML = `<div class="auth-overlay"><div class="auth-box">
      <h2>🧠 JATA Qi</h2>
      <div class="form-group"><label>Username</label><input id="login-user" placeholder="admin" autofocus></div>
      <div class="form-group"><label>Password</label><input id="login-pass" type="password" placeholder="admin"></div>
      <div class="auth-error" id="login-err">Invalid credentials</div>
      <button class="btn-primary" style="width:100%" onclick="doLogin()">Sign In</button>
    </div></div>`;
    $('#login-pass')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    return;
  }
  app.innerHTML = `<div class="app">
    <div class="sidebar">
      <div class="sidebar-brand">🧠 JATA<span>Qi</span></div>
      ${NAV.map(n => `<div class="nav-item ${state.view === n.id ? 'active' : ''}" onclick="loadView('${n.id}')">${n.icon} <span>${n.label}</span></div>`).join('')}
      <div style="padding:16px 20px;border-top:1px solid var(--border);margin-top:auto">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">${state.principal?.username}</div>
        <button class="btn-ghost" style="width:100%" onclick="logout()">Sign Out</button>
      </div>
    </div>
    <div class="main main-content"></div>
  </div>`;
  loadView('dashboard');
}

window.doLogin = () => {
  const u = $('#login-user').value, p = $('#login-pass').value;
  login(u, p).catch(() => { $('#login-err').style.display = 'block'; });
};
window.loadView = loadView;
window.logout = logout;

// Init.
if (checkStoredAuth()) render(); else render();

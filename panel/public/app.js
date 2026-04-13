let loggedInUser = null;
let servers = [];
let nodes = [];

function authHeaders() {
  return loggedInUser ? { 'x-panel-user': loggedInUser.username } : {};
}

function toggleId(id, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('hidden', !visible);
}

function updateNav() {
  const loggedIn = !!loggedInUser;
  const admin = loggedInUser && loggedInUser.role === 'admin';

  toggleId('navDashboard', loggedIn);
  toggleId('navCreate', loggedIn);
  toggleId('navStatus', loggedIn);
  toggleId('navLogout', loggedIn);
  toggleId('navNodes', admin);
  toggleId('navAdmin', admin);
}

async function login() {
  const usernameEl = document.getElementById('loginUsername');
  const passwordEl = document.getElementById('loginPassword');
  const msg = document.getElementById('loginMessage');
  if (!usernameEl || !passwordEl) return;

  const username = usernameEl.value.trim();
  const password = passwordEl.value.trim();

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    if (msg) {
      msg.classList.remove('hidden');
      msg.textContent = data.error || 'Login failed.';
    }
    return;
  }

  loggedInUser = data.user;
  window.loggedInUser = loggedInUser;
  localStorage.setItem('panelUser', JSON.stringify(loggedInUser));

  if (msg) msg.classList.add('hidden');
  updateNav();
  updateServerFields();
  await loadNodesForCreate();
  window.location = 'dashboard.html';

  if (loggedInUser.mustChangePassword) {
    const newPassword = prompt('You have a temporary password. Enter a new password now:');
    if (newPassword) {
      await fetch('/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ newPassword })
      });
      alert('Password changed.');
    }
  }
}

function logout() {
  loggedInUser = null;
  window.loggedInUser = null;
  localStorage.removeItem('panelUser');
  updateNav();
  window.location = 'index.html';
}

function updateServerFields() {
  const typeEl = document.getElementById('serverType');
  const box = document.getElementById('dynamicFields');
  if (!typeEl || !box) return;

  const type = typeEl.value;
  if (type === 'rust' || type === 'satisfactory') {
    box.innerHTML = `
      <div class="message">
        This server type does not use a Minecraft version string.
      </div>
    `;
    return;
  }

  let label = 'Version';
  if (type === 'paper') label = 'Paper Version';
  if (type === 'forge') label = 'Forge Version';
  if (type === 'fabric') label = 'Fabric Version';
  if (type === 'vanilla') label = 'Vanilla Version';

  box.innerHTML = `
    <label>${label}</label>
    <input id="serverVersion" class="input" placeholder="1.21.1" />
  `;
}

async function createServer() {
  const nameEl = document.getElementById('serverName');
  if (!nameEl) return;

  const name = nameEl.value.trim();
  const type = (document.getElementById('serverType') || {}).value || 'paper';
  const version = (document.getElementById('serverVersion') || {}).value || '';
  const nodeId = (document.getElementById('serverNode') || {}).value || '';
  const memory = (document.getElementById('serverMemory') || {}).value || '';
  const msg = document.getElementById('createMessage');

  if ((type === 'rust' || type === 'satisfactory') && !nodeId) {
    if (msg) {
      msg.classList.remove('hidden');
      msg.textContent = `${type} servers must be created on a node.`;
    }
    return;
  }

  if (type !== 'blockheads' && type !== 'rust' && type !== 'satisfactory' && !String(version).trim()) {
    if (msg) {
      msg.classList.remove('hidden');
      msg.textContent = 'Please enter a version.';
    }
    return;
  }

  const payload = { name, type, nodeId, memory };
  if (type !== 'blockheads' && type !== 'rust' && type !== 'satisfactory') {
    payload.version = version;
  }

  const res = await fetch('/api/server/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });

  const data = await res.json();

  if (!res.ok || !data.ok) {
    if (msg) {
      msg.classList.remove('hidden');
      msg.textContent = data.error || 'Server creation failed.';
    }
    return;
  }

  if (msg) {
    msg.classList.remove('hidden');
    msg.textContent = 'Server created successfully.';
  }

  window.location = 'dashboard.html';
}

async function loadServers() {
  try {
    if (loggedInUser && loggedInUser.role === 'admin') {
      try {
        const nodeRes = await fetch('/api/nodes', { headers: { ...authHeaders() } });
        const nodeData = await nodeRes.json();
        nodes = Array.isArray(nodeData) ? nodeData : [];
      } catch {
        nodes = [];
      }
    } else {
      nodes = [];
    }

    const res = await fetch('/api/servers', { headers: { ...authHeaders() } });
    const data = await res.json();
    servers = Array.isArray(data) ? data : [];
    renderServers();
  } catch {
    servers = [];
    renderServers();
  }
}

function getNodeName(nodeId) {
  if (!nodeId) return 'local';
  const node = nodes.find(n => n.id === nodeId);
  return node ? node.name : nodeId;
}

function renderServers() {
  const list = document.getElementById('serverList');
  if (!list) return;

  if (!servers || !servers.length) {
    list.innerHTML = '<div class="server-item">No servers yet.</div>';
    return;
  }

  list.innerHTML = servers.map(server => `
    <div class="server-item">
      <h3>${server.name}</h3>
      <p class="muted">Type: ${server.type} &middot; Version: ${server.version}</p>
      <p class="muted">Port: ${server.port} &middot; Owner: ${server.ownerUsername}</p>
      <p class="muted">Node: ${getNodeName(server.nodeId)}</p>
      <p class="muted">Status: ${server.status || 'unknown'} &middot; Memory: ${server.memory || '2G'}</p>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" onclick="manageServer('${server.id}')">Manage</button>
        <button class="btn" onclick="startServer('${server.id}')">Start</button>
        <button class="btn" onclick="stopServer('${server.id}')">Stop</button>
        <button class="btn" onclick="restartServer('${server.id}')">Restart</button>
        <button class="nav red" style="background:#ef4444;border:none;color:white;padding:10px;border-radius:8px;cursor:pointer" onclick="deleteServer('${server.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function manageServer(id) {
  window.location.href = 'server.html?id=' + encodeURIComponent(id);
}

async function loadNodes() {
  try {
    const res = await fetch('/api/nodes', { headers: { ...authHeaders() } });
    const data = await res.json();
    nodes = Array.isArray(data) ? data : [];
    renderNodes();
    updateNodeStatus();
  } catch {
    nodes = [];
    renderNodes();
  }
}

function renderNodes() {
  const list = document.getElementById('nodeList');
  if (!list) return;

  if (!nodes || !nodes.length) {
    list.innerHTML = '<div class="server-item">No nodes yet.</div>';
    return;
  }

  list.innerHTML = nodes.map(node => `
    <div class="server-item">
      <h3>${node.name}</h3>
      <p class="muted">IP: ${node.ip} &middot; Port: ${node.port || '4110'}</p>
      <p class="muted">API Key: ${node.apiKey ? node.apiKey.slice(0, 6) + '...' : '(none)'}</p>
      <p class="muted">Description: ${node.description || 'None'}</p>
      <div style="margin-top:8px;display:flex;gap:8px">
        <button class="btn" onclick="checkNode('${node.id}')">Check</button>
        <button class="nav red" style="background:#ef4444;border:none;color:white;padding:10px;border-radius:8px;cursor:pointer" onclick="deleteNode('${node.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

async function addNode() {
  const name = (document.getElementById('nodeName') || {}).value || '';
  const ip = (document.getElementById('nodeIp') || {}).value || '';
  const description = (document.getElementById('nodeDescription') || {}).value || '';
  const port = (document.getElementById('nodePort') || {}).value || '';
  const apiKey = (document.getElementById('nodeApiKey') || {}).value || '';
  const msg = document.getElementById('nodeMessage');

  const res = await fetch('/api/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name, ip, port, apiKey, description })
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    if (msg) {
      msg.classList.remove('hidden');
      msg.textContent = data.error || 'Failed to add node.';
    }
    return;
  }

  if (msg) {
    msg.classList.remove('hidden');
    msg.textContent = 'Node added.';
  }

  loadNodes();
  loadNodesForCreate();
}

async function loadNodesForCreate() {
  const select = document.getElementById('serverNode');
  if (!select) return;
  select.innerHTML = `<option value="">No node selected</option>`;
  if (!loggedInUser || loggedInUser.role !== 'admin') return;

  try {
    const res = await fetch('/api/nodes', { headers: { ...authHeaders() } });
    const data = await res.json();
    const items = Array.isArray(data) ? data : [];
    const seen = new Set();

    for (const node of items) {
      if (!node || !node.id) continue;
      if (seen.has(node.id)) continue;
      seen.add(node.id);

      const opt = document.createElement('option');
      opt.value = node.id;
      opt.textContent = `${node.name} (${node.ip})`;
      select.appendChild(opt);
    }
  } catch {}
}

async function startServer(serverId) {
  await fetch('/api/server/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ serverId })
  });
  await loadServers();
}

async function stopServer(serverId) {
  await fetch('/api/server/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ serverId })
  });
  await loadServers();
}

async function restartServer(serverId) {
  await fetch('/api/server/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ serverId })
  });
  await loadServers();
}

async function deleteServer(serverId) {
  if (!confirm('Are you sure you want to delete this server?')) return;

  const res = await fetch('/api/server/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ serverId })
  });

  const data = await res.json();
  if (!res.ok) return alert('Delete failed: ' + (data.error || res.statusText));
  await loadServers();
}

async function deleteAllServers() {
  if (!confirm('Delete ALL servers? This cannot be undone.')) return;

  const res = await fetch('/api/servers/delete-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() }
  });

  const data = await res.json();
  if (!res.ok) return alert('Delete all failed: ' + (data.error || res.statusText));
  await loadServers();
}

async function checkNode(nodeId) {
  try {
    const res = await fetch('/api/nodes/check/' + nodeId, { headers: { ...authHeaders() } });
    const data = await res.json();
    alert(JSON.stringify(data, null, 2));
  } catch (e) {
    alert('Node check failed: ' + String(e));
  }
}

async function deleteNode(nodeId) {
  if (!confirm('Delete node? This will not remove servers that were created on it.')) return;

  const res = await fetch('/api/nodes/' + encodeURIComponent(nodeId), {
    method: 'DELETE',
    headers: { ...authHeaders() }
  });

  const data = await res.json();
  if (!res.ok) return alert('Delete failed: ' + (data.error || res.statusText));

  await loadNodes();
  await loadNodesForCreate();
}

async function loadAdminSettings() {
  try {
    const res = await fetch('/api/admin/settings', { headers: { ...authHeaders() } });
    const data = await res.json();

    if (document.getElementById('panelApiKey')) document.getElementById('panelApiKey').value = data.panelApiKey || '';
    if (document.getElementById('websiteUrl')) document.getElementById('websiteUrl').value = data.websiteUrl || '';
    if (document.getElementById('smtpHost')) document.getElementById('smtpHost').value = data.smtp?.host || '';
    if (document.getElementById('smtpPort')) document.getElementById('smtpPort').value = data.smtp?.port || '587';
    if (document.getElementById('smtpSecure')) document.getElementById('smtpSecure').value = String(!!data.smtp?.secure);
    if (document.getElementById('smtpUser')) document.getElementById('smtpUser').value = data.smtp?.user || '';
    if (document.getElementById('smtpPass')) document.getElementById('smtpPass').value = data.smtp?.pass || '';
    if (document.getElementById('smtpFrom')) document.getElementById('smtpFrom').value = data.smtp?.from || '';
    if (document.getElementById('smtpTestTo')) document.getElementById('smtpTestTo').value = data.smtp?.from || '';
  } catch {}
}

async function saveAdminSettings() {
  const msg = document.getElementById('adminMessage');
  const body = {
    panelApiKey: (document.getElementById('panelApiKey') || {}).value?.trim() || '',
    websiteUrl: (document.getElementById('websiteUrl') || {}).value?.trim() || '',
    smtp: {
      host: (document.getElementById('smtpHost') || {}).value?.trim() || '',
      port: Number((document.getElementById('smtpPort') || {}).value || 587),
      secure: (document.getElementById('smtpSecure') || {}).value === 'true',
      user: (document.getElementById('smtpUser') || {}).value?.trim() || '',
      pass: (document.getElementById('smtpPass') || {}).value?.trim() || '',
      from: (document.getElementById('smtpFrom') || {}).value?.trim() || ''
    }
  };

  const res = await fetch('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    if (msg) {
      msg.classList.remove('hidden');
      msg.textContent = data.error || 'Failed to save settings.';
    }
    return;
  }

  if (msg) {
    msg.classList.remove('hidden');
    msg.textContent = 'Settings saved.';
  }
}

async function loadStatus() {
  if (!loggedInUser) return;

  try {
    const settingsRes = await fetch('/api/admin/settings', { headers: { ...authHeaders() } });
    const settings = await settingsRes.json();
    const ws = document.getElementById('websiteStatusText');
    if (ws) {
      ws.innerHTML = settings.websiteUrl
        ? `<span class="status-good">${settings.websiteUrl}</span>`
        : `<span class="status-bad">Not set</span>`;
    }
  } catch {
    const ws = document.getElementById('websiteStatusText');
    if (ws) ws.innerHTML = `<span class="status-bad">Error</span>`;
  }

  try {
    const nodesRes = await fetch('/api/nodes', { headers: { ...authHeaders() } });
    const n = await nodesRes.json();
    const ns = document.getElementById('nodeStatusText');
    if (ns) {
      ns.innerHTML =
        Array.isArray(n) && n.length
          ? `<span class="status-good">${n.length} node(s)</span>`
          : `<span class="status-bad">No nodes</span>`;
    }
  } catch {
    const ns = document.getElementById('nodeStatusText');
    if (ns) ns.innerHTML = `<span class="status-bad">Error</span>`;
  }
}

function updateNodeStatus() {
  const el = document.getElementById('nodeStatusText');
  if (!el) return;
  el.innerHTML = nodes.length
    ? `<span class="status-good">${nodes.length} node(s)</span>`
    : `<span class="status-bad">No nodes</span>`;
}

function loadSavedLogin() {
  const saved = localStorage.getItem('panelUser');
  if (!saved) {
    updateNav();
    updateServerFields();
    return;
  }

  try {
    loggedInUser = JSON.parse(saved);
    window.loggedInUser = loggedInUser;
  } catch {
    loggedInUser = null;
    window.loggedInUser = null;
  }

  updateNav();
  updateServerFields();
  if (loggedInUser) loadNodesForCreate();
}

async function sendTestSmtp() {
  const to = (document.getElementById('smtpTestTo') || {}).value || '';
  const out = document.getElementById('smtpTestResult');
  if (out) out.textContent = 'Sending test email...';

  try {
    const res = await fetch('/api/admin/test-smtp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ to })
    });

    const data = await res.json();
    if (!res.ok) {
      if (out) out.textContent = 'Error: ' + (data.error || res.statusText);
      return;
    }

    if (out) out.textContent = 'OK: ' + JSON.stringify(data);
  } catch (err) {
    if (out) out.textContent = 'Error: ' + String(err);
  }
}

// SERVER PAGE HELPERS
async function fetchServerOverview(serverId) {
  const res = await fetch('/api/server/' + encodeURIComponent(serverId) + '/overview', {
    headers: { ...authHeaders() }
  });
  return res.json();
}

async function fetchServerFiles(serverId, currentPath = '') {
  const url = '/api/server/' + encodeURIComponent(serverId) + '/files?path=' + encodeURIComponent(currentPath);
  const res = await fetch(url, { headers: { ...authHeaders() } });
  return res.json();
}

async function fetchServerFile(serverId, filePath) {
  const url = '/api/server/' + encodeURIComponent(serverId) + '/file?path=' + encodeURIComponent(filePath);
  const res = await fetch(url, { headers: { ...authHeaders() } });
  return res.json();
}

async function saveServerFile(serverId, filePath, content) {
  const res = await fetch('/api/server/' + encodeURIComponent(serverId) + '/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path: filePath, content })
  });
  return res.json();
}

async function saveServerConfig(serverId, config) {
  const res = await fetch('/api/server/' + encodeURIComponent(serverId) + '/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(config)
  });
  return res.json();
}

async function sendServerCommand(serverId, command) {
  const res = await fetch('/api/server/' + encodeURIComponent(serverId) + '/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ command })
  });
  return res.json();
}

async function uploadServerFile(serverId, filePath, contentBase64, overwrite = false) {
  const res = await fetch('/api/server/' + encodeURIComponent(serverId) + '/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path: filePath, contentBase64, overwrite })
  });
  return res.json();
}

async function mkdirServerPath(serverId, folderPath) {
  const res = await fetch('/api/server/' + encodeURIComponent(serverId) + '/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path: folderPath })
  });
  return res.json();
}

async function renameServerPath(serverId, oldPath, newPath) {
  const res = await fetch('/api/server/' + encodeURIComponent(serverId) + '/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ oldPath, newPath })
  });
  return res.json();
}

async function deleteServerPath(serverId, pathValue) {
  const res = await fetch('/api/server/' + encodeURIComponent(serverId) + '/delete-path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ path: pathValue })
  });
  return res.json();
}

function getServerDownloadUrl(serverId, filePath) {
  return '/api/server/' + encodeURIComponent(serverId) + '/download?path=' + encodeURIComponent(filePath);
}

window.login = login;
window.logout = logout;
window.updateServerFields = updateServerFields;
window.createServer = createServer;
window.loadServers = loadServers;
window.loadNodes = loadNodes;
window.addNode = addNode;
window.loadAdminSettings = loadAdminSettings;
window.saveAdminSettings = saveAdminSettings;
window.loadStatus = loadStatus;
window.loadSavedLogin = loadSavedLogin;
window.sendTestSmtp = sendTestSmtp;
window.manageServer = manageServer;
window.startServer = startServer;
window.stopServer = stopServer;
window.restartServer = restartServer;
window.deleteServer = deleteServer;
window.deleteAllServers = deleteAllServers;
window.checkNode = checkNode;
window.deleteNode = deleteNode;
window.fetchServerOverview = fetchServerOverview;
window.fetchServerFiles = fetchServerFiles;
window.fetchServerFile = fetchServerFile;
window.saveServerFile = saveServerFile;
window.saveServerConfig = saveServerConfig;
window.sendServerCommand = sendServerCommand;
window.uploadServerFile = uploadServerFile;
window.mkdirServerPath = mkdirServerPath;
window.renameServerPath = renameServerPath;
window.deleteServerPath = deleteServerPath;
window.getServerDownloadUrl = getServerDownloadUrl;

loadSavedLogin();
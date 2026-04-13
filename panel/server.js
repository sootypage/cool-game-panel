require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const multer = require('multer');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: path.join(__dirname, 'uploads') });

const DATA_DIR = path.join(__dirname, 'data');
const SERVERS_DIR = path.join(__dirname, 'servers');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const NODES_FILE = path.join(DATA_DIR, 'nodes.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

ensureDir(DATA_DIR);
ensureDir(SERVERS_DIR);
ensureDir(UPLOADS_DIR);

if (!fs.existsSync(USERS_FILE)) {
  writeJson(USERS_FILE, [
    {
      username: 'dylan',
      email: 'dylan@example.com',
      password: 'dylan',
      role: 'admin',
      mustChangePassword: false
    }
  ]);
}

if (!fs.existsSync(SERVERS_FILE)) writeJson(SERVERS_FILE, []);
if (!fs.existsSync(NODES_FILE)) writeJson(NODES_FILE, []);

if (!fs.existsSync(SETTINGS_FILE)) {
  writeJson(SETTINGS_FILE, {
    panelApiKey: 'change-this-panel-api-key',
    websiteUrl: '',
    smtp: {
      host: '',
      port: 587,
      secure: false,
      user: '',
      pass: '',
      from: ''
    }
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getUsers() { return readJson(USERS_FILE, []); }
function saveUsers(users) { writeJson(USERS_FILE, users); }
function getServers() { return readJson(SERVERS_FILE, []); }
function saveServers(servers) { writeJson(SERVERS_FILE, servers); }
function getNodes() { return readJson(NODES_FILE, []); }
function saveNodes(nodes) { writeJson(NODES_FILE, nodes); }
function getSettings() { return readJson(SETTINGS_FILE, {}); }
function saveSettings(settings) { writeJson(SETTINGS_FILE, settings); }

function sanitizeName(name) {
  return String(name || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, '-');
}

function sanitizeWorldId(id) {
  return String(id || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toLowerCase()
    .slice(0, 40);
}

function cleanRuntimeCommand(value, fallback = '') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.replace(/[\r\n]+/g, ' ').trim();
}

function normalizeStartup(type, startup = {}) {
  const cleanType = String(type || '').toLowerCase();

  if (cleanType === 'nodejs') {
    const startFile = String(startup.startFile || 'server.js').trim() || 'server.js';
    const startCommand = cleanRuntimeCommand(startup.startCommand, `node ${startFile}`);
    return { startFile, startCommand };
  }

  if (cleanType === 'python') {
    const startFile = String(startup.startFile || 'main.py').trim() || 'main.py';
    const startCommand = cleanRuntimeCommand(startup.startCommand, `python ${startFile}`);
    return { startFile, startCommand };
  }

  return {
    startFile: String(startup.startFile || '').trim(),
    startCommand: cleanRuntimeCommand(startup.startCommand, '')
  };
}

const MINECRAFT_TYPES = new Set(['paper', 'forge', 'fabric', 'vanilla']);
const RUNTIME_TYPES = new Set(['nodejs', 'python']);
const EXTRA_GAME_TYPES = new Set([
  'mindustry',
  'projectzomboid',
  '7daystodie',
  'ark',
  'astroneer',
  'farmingsim22',
  'farmingsim25',
  'dayz',
  'sonsoftheforest',
  'unturned'
]);

const TYPES_WITHOUT_VERSION = new Set([
  'blockheads',
  'rust',
  'satisfactory',
  'mindustry',
  'projectzomboid',
  '7daystodie',
  'ark',
  'astroneer',
  'farmingsim22',
  'farmingsim25',
  'dayz',
  'sonsoftheforest',
  'unturned'
]);

const NODE_REQUIRED_TYPES = new Set([
  'blockheads',
  'rust',
  'satisfactory',
  'nodejs',
  'python',
  'mindustry',
  'projectzomboid',
  '7daystodie',
  'ark',
  'astroneer',
  'farmingsim22',
  'farmingsim25',
  'dayz',
  'sonsoftheforest',
  'unturned'
]);

const SUPPORTED_SERVER_TYPES = new Set([
  ...MINECRAFT_TYPES,
  ...RUNTIME_TYPES,
  ...EXTRA_GAME_TYPES,
  'blockheads',
  'rust',
  'satisfactory'
]);

function randomPassword(length = 12) {
  return crypto.randomBytes(length).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, length);
}

function isAdmin(user) {
  return user && user.role === 'admin';
}

function getUserFromHeaders(req) {
  const username = req.headers['x-panel-user'];
  if (!username) return null;
  return getUsers().find(u => u.username === username || u.email === username) || null;
}

function requireUser(req, res, next) {
  const user = getUserFromHeaders(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = getUserFromHeaders(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  if (!isAdmin(user)) return res.status(403).json({ error: 'Admin only.' });
  req.user = user;
  next();
}

async function downloadPaper(version, dir) {
  const versionRes = await axios.get(`https://api.papermc.io/v2/projects/paper/versions/${version}`);
  const builds = versionRes.data.builds || [];
  if (!builds.length) throw new Error('No Paper builds found for this version.');

  const latest = builds[builds.length - 1];
  const url = `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${latest}/downloads/paper-${version}-${latest}.jar`;
  const file = path.join(dir, 'server.jar');

  const response = await axios({ url, method: 'GET', responseType: 'stream' });
  const writer = fs.createWriteStream(file);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

function nextPort(start = 25565) {
  const servers = getServers();
  const used = servers.map(s => Number(s.port) || 0).filter(Boolean);
  let port = start;
  while (used.includes(port)) port++;
  return port;
}

function nextPortForType(type) {
  const cleanType = String(type || 'paper').toLowerCase();
  if (cleanType === 'blockheads') return nextPort(15151);
  if (cleanType === 'rust') return nextPort(28015);
  if (cleanType === 'satisfactory') return nextPort(7777);
  if (cleanType === 'mindustry') return nextPort(6567);
  if (cleanType === 'projectzomboid') return nextPort(16261);
  if (cleanType === '7daystodie') return nextPort(26900);
  if (cleanType === 'ark') return nextPort(7777);
  if (cleanType === 'astroneer') return nextPort(8777);
  if (cleanType === 'farmingsim22') return nextPort(8080);
  if (cleanType === 'farmingsim25') return nextPort(8090);
  if (cleanType === 'dayz') return nextPort(2302);
  if (cleanType === 'sonsoftheforest') return nextPort(8766);
  if (cleanType === 'unturned') return nextPort(27015);
  if (cleanType === 'nodejs') return nextPort(3000);
  if (cleanType === 'python') return nextPort(8000);
  return nextPort(25565);
}

async function maybeSendEmail(to, subject, text) {
  const settings = getSettings();
  const smtp = settings.smtp || {};

  if (!smtp.host || !smtp.user || !smtp.pass || !smtp.from) {
    return { sent: false, skipped: true };
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port || 587),
    secure: !!smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass }
  });

  await transporter.sendMail({ from: smtp.from, to, subject, text });
  return { sent: true };
}

function getNodeById(nodeId) {
  return getNodes().find(n => n.id === nodeId) || null;
}

function buildNodeBaseUrl(node) {
  const ip = String(node.ip || '').trim();
  const port = String(node.port || '4110').trim();
  return `http://${ip}:${port}`;
}

async function callNode(node, endpoint, body = {}, method = 'POST') {
  const baseUrl = buildNodeBaseUrl(node);
  const config = {
    method,
    url: `${baseUrl}${endpoint}`,
    headers: {
      'Content-Type': 'application/json',
      'x-node-api-key': node.apiKey || ''
    },
    timeout: 30000
  };
  if (method !== 'GET') config.data = body;
  const res = await axios(config);
  return res.data;
}

function getServerById(serverId) {
  return getServers().find(server => server.id === serverId) || null;
}

function canAccessServer(user, server) {
  return !!server && (isAdmin(user) || server.ownerUsername === user.username);
}

function normalizeServerRecord(server) {
  const network = server.network && typeof server.network === 'object' ? server.network : {};
  const database = server.database && typeof server.database === 'object' ? server.database : {};
  const startup = server.startup && typeof server.startup === 'object' ? server.startup : {};

  return {
    ...server,
    startup: normalizeStartup(server.type, startup),
    network: {
      host: String(network.host || (server.nodeId ? '' : 'local')).trim(),
      requestedPort: String(network.requestedPort || server.requestedPort || server.port || '').trim(),
      notes: String(network.notes || '').trim()
    },
    database: {
      enabled: !!database.enabled,
      host: String(database.host || '').trim(),
      port: String(database.port || '').trim(),
      database: String(database.database || '').trim(),
      username: String(database.username || '').trim(),
      password: String(database.password || '')
    }
  };
}

function updateServerRecord(serverId, updater) {
  const servers = getServers();
  const index = servers.findIndex(server => server.id === serverId);
  if (index === -1) return null;

  const updated = updater({ ...servers[index] });
  servers[index] = normalizeServerRecord(updated);
  saveServers(servers);
  return servers[index];
}

function buildServerOverview(server) {
  const normalized = normalizeServerRecord(server);
  const node = normalized.nodeId ? getNodeById(normalized.nodeId) : null;

  return {
    server: normalized,
    settings: {
      memory: normalized.memory || '2G',
      type: normalized.type || 'paper',
      version: normalized.version || '',
      docker: !!normalized.docker,
      status: normalized.status || 'unknown'
    },
    network: {
      host: normalized.network.host || (node ? node.ip : 'local'),
      port: normalized.port,
      requestedPort: normalized.network.requestedPort || normalized.port,
      notes: normalized.network.notes || ''
    },
    database: normalized.database,
    startup: normalized.startup,
    node: node ? {
      id: node.id,
      name: node.name,
      ip: node.ip,
      port: node.port,
      description: node.description || ''
    } : null
  };
}

function serverFilesBaseDir(server) {
  return path.resolve(path.join(SERVERS_DIR, server.name));
}

function resolveServerPath(server, requestedPath = '') {
  const baseDir = serverFilesBaseDir(server);
  const target = path.resolve(path.join(baseDir, String(requestedPath || '')));
  if (!target.startsWith(baseDir)) {
    throw new Error('Invalid path.');
  }
  return target;
}

function listServerFiles(server, requestedPath = '') {
  const targetDir = resolveServerPath(server, requestedPath);
  return fs.readdirSync(targetDir, { withFileTypes: true }).map(item => ({
    name: item.name,
    isDir: item.isDirectory(),
    path: path.posix.join(String(requestedPath || '').replace(/\\/g, '/'), item.name).replace(/^\/+/, '')
  })).sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });
}

function readServerFile(server, requestedPath) {
  const targetFile = resolveServerPath(server, requestedPath);
  const stat = fs.statSync(targetFile);
  if (stat.isDirectory()) throw new Error('That path is a directory.');
  return fs.readFileSync(targetFile, 'utf8');
}

async function listServerFilesAny(server, requestedPath = '') {
  if (server.nodeId) {
    const node = getNodeById(server.nodeId);
    if (!node) throw new Error('Node not found.');

    const result = await callNode(
      node,
      `/server/files/${encodeURIComponent(server.id)}?path=${encodeURIComponent(String(requestedPath || ''))}`,
      {},
      'GET'
    );

    return {
      currentPath: String(result.currentPath || ''),
      files: Array.isArray(result.files) ? result.files : []
    };
  }

  return {
    currentPath: String(requestedPath || '').replace(/\\/g, '/'),
    files: listServerFiles(server, requestedPath)
  };
}

async function readServerFileAny(server, requestedPath) {
  if (server.nodeId) {
    const node = getNodeById(server.nodeId);
    if (!node) throw new Error('Node not found.');

    const result = await callNode(
      node,
      `/server/file/${encodeURIComponent(server.id)}?path=${encodeURIComponent(String(requestedPath || ''))}`,
      {},
      'GET'
    );

    return {
      path: String(result.path || requestedPath || '').replace(/\\/g, '/'),
      content: String(result.content || '')
    };
  }

  return {
    path: String(requestedPath || '').replace(/\\/g, '/'),
    content: readServerFile(server, requestedPath)
  };
}

async function writeServerFileAny(server, requestedPath, content) {
  if (server.nodeId) {
    const node = getNodeById(server.nodeId);
    if (!node) throw new Error('Node not found.');

    return callNode(node, `/server/file/${encodeURIComponent(server.id)}`, {
      path: String(requestedPath || ''),
      content: String(content ?? '')
    });
  }

  const targetFile = resolveServerPath(server, requestedPath);
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, String(content ?? ''), 'utf8');
  return { ok: true };
}

async function uploadServerFileAny(server, requestedPath, contentBase64, overwrite) {
  if (server.nodeId) {
    const node = getNodeById(server.nodeId);
    if (!node) throw new Error('Node not found.');

    return callNode(node, `/server/upload/${encodeURIComponent(server.id)}`, {
      path: String(requestedPath || ''),
      contentBase64: String(contentBase64 || ''),
      overwrite: !!overwrite
    });
  }

  const targetFile = resolveServerPath(server, requestedPath);
  if (fs.existsSync(targetFile) && !overwrite) throw new Error('File already exists.');

  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, Buffer.from(String(contentBase64 || ''), 'base64'));
  return { ok: true };
}

async function mkdirServerPathAny(server, requestedPath) {
  if (server.nodeId) {
    const node = getNodeById(server.nodeId);
    if (!node) throw new Error('Node not found.');
    return callNode(node, `/server/mkdir/${encodeURIComponent(server.id)}`, {
      path: String(requestedPath || '')
    });
  }

  const targetDir = resolveServerPath(server, requestedPath);
  fs.mkdirSync(targetDir, { recursive: true });
  return { ok: true };
}

async function renameServerPathAny(server, oldPath, newPath) {
  if (server.nodeId) {
    const node = getNodeById(server.nodeId);
    if (!node) throw new Error('Node not found.');
    return callNode(node, `/server/rename/${encodeURIComponent(server.id)}`, {
      oldPath: String(oldPath || ''),
      newPath: String(newPath || '')
    });
  }

  const from = resolveServerPath(server, oldPath);
  const to = resolveServerPath(server, newPath);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return { ok: true };
}

async function deleteServerPathAny(server, requestedPath) {
  if (server.nodeId) {
    const node = getNodeById(server.nodeId);
    if (!node) throw new Error('Node not found.');
    return callNode(node, `/server/delete-path/${encodeURIComponent(server.id)}`, {
      path: String(requestedPath || '')
    });
  }

  const target = resolveServerPath(server, requestedPath);
  if (!fs.existsSync(target)) throw new Error('Path not found.');
  const stat = fs.statSync(target);
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
  return { ok: true };
}

async function sendServerConsoleCommand(server, command) {
  const cleanCommand = String(command || '').trim();
  if (!cleanCommand) throw new Error('Command is required.');

  if (server.nodeId) {
    const node = getNodeById(server.nodeId);
    if (!node) throw new Error('Node not found.');

    return callNode(node, '/server/command', {
      serverId: server.id,
      command: cleanCommand
    });
  }

  throw new Error('Console commands are only available for node-backed servers.');
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  const user = getUsers().find(
    u => (u.username === username || u.email === username) && u.password === password
  );

  if (!user) return res.status(401).json({ error: 'Invalid login.' });

  res.json({
    ok: true,
    user: {
      username: user.username,
      email: user.email || '',
      role: user.role || 'user',
      mustChangePassword: !!user.mustChangePassword
    }
  });
});

app.post('/api/change-password', requireUser, (req, res) => {
  const { newPassword } = req.body;

  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  }

  const users = getUsers();
  const index = users.findIndex(u => u.username === req.user.username);
  if (index === -1) return res.status(404).json({ error: 'User not found.' });

  users[index].password = newPassword;
  users[index].mustChangePassword = false;
  saveUsers(users);

  res.json({ ok: true });
});

app.post('/api/admin/create-user', requireAdmin, (req, res) => {
  const { username, email, password, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  const users = getUsers();

  if (users.find(u => u.username === username || (email && u.email === email))) {
    return res.status(400).json({ error: 'User already exists.' });
  }

  const user = {
    username,
    email: email || '',
    password,
    role: role === 'admin' ? 'admin' : 'user',
    mustChangePassword: false
  };

  users.push(user);
  saveUsers(users);

  res.json({ ok: true, user });
});

app.get('/api/servers', requireUser, (req, res) => {
  const servers = getServers();
  if (isAdmin(req.user)) return res.json(servers);
  return res.json(servers.filter(s => s.ownerUsername === req.user.username));
});

app.get('/api/server/:id/overview', requireUser, (req, res) => {
  const server = getServerById(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  if (!canAccessServer(req.user, server)) return res.status(403).json({ error: 'Not allowed.' });

  res.json(buildServerOverview(server));
});

app.get('/api/server/:id/files', requireUser, (req, res) => {
  (async () => {
    try {
      const server = getServerById(req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found.' });
      if (!canAccessServer(req.user, server)) return res.status(403).json({ error: 'Not allowed.' });

      const requestedPath = String(req.query.path || '');
      const data = await listServerFilesAny(server, requestedPath);

      res.json({
        currentPath: String(data.currentPath || '').replace(/\\/g, '/'),
        files: Array.isArray(data.files) ? data.files : []
      });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to load files.' });
    }
  })();
});

app.get('/api/server/:id/file', requireUser, (req, res) => {
  (async () => {
    try {
      const server = getServerById(req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found.' });
      if (!canAccessServer(req.user, server)) return res.status(403).json({ error: 'Not allowed.' });

      const requestedPath = String(req.query.path || '');
      if (!requestedPath) return res.status(400).json({ error: 'Path required.' });

      const data = await readServerFileAny(server, requestedPath);
      res.json(data);
    } catch (err) {
      res.status(404).json({ error: err.message || 'File not found or cannot be read.' });
    }
  })();
});

app.post('/api/server/:id/file', requireUser, (req, res) => {
  (async () => {
    try {
      const server = getServerById(req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found.' });
      if (!canAccessServer(req.user, server)) return res.status(403).json({ error: 'Not allowed.' });

      const requestedPath = String(req.body.path || '');
      const content = String(req.body.content ?? '');

      if (!requestedPath) return res.status(400).json({ error: 'Path required.' });

      await writeServerFileAny(server, requestedPath, content);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to save file.' });
    }
  })();
});

app.post('/api/server/:id/upload', requireUser, (req, res) => {
  (async () => {
    try {
      const server = getServerById(req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found.' });
      if (!canAccessServer(req.user, server)) return res.status(403).json({ error: 'Not allowed.' });

      const requestedPath = String(req.body.path || '');
      const contentBase64 = String(req.body.contentBase64 || '');
      const overwrite = !!req.body.overwrite;

      if (!requestedPath) return res.status(400).json({ error: 'Path required.' });
      if (!contentBase64) return res.status(400).json({ error: 'contentBase64 required.' });

      await uploadServerFileAny(server, requestedPath, contentBase64, overwrite);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to upload file.' });
    }
  })();
});

app.post('/api/server/:id/mkdir', requireUser, (req, res) => {
  (async () => {
    try {
      const server = getServerById(req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found.' });
      if (!canAccessServer(req.user, server)) return res.status(403).json({ error: 'Not allowed.' });

      const requestedPath = String(req.body.path || '');
      if (!requestedPath) return res.status(400).json({ error: 'Path required.' });

      await mkdirServerPathAny(server, requestedPath);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to create folder.' });
    }
  })();
});

app.post('/api/server/:id/rename', requireUser, (req, res) => {
  (async () => {
    try {
      const server = getServerById(req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found.' });
      if (!canAccessServer(req.user, server)) return res.status(403).json({ error: 'Not allowed.' });

      const oldPath = String(req.body.oldPath || '');
      const newPath = String(req.body.newPath || '');
      if (!oldPath || !newPath) {
        return res.status(400).json({ error: 'oldPath and newPath are required.' });
      }

      await renameServerPathAny(server, oldPath, newPath);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to rename path.' });
    }
  })();
});

app.post('/api/server/:id/delete-path', requireUser, (req, res) => {
  (async () => {
    try {
      const server = getServerById(req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found.' });
      if (!canAccessServer(req.user, server)) return res.status(403).json({ error: 'Not allowed.' });

      const requestedPath = String(req.body.path || '');
      if (!requestedPath) return res.status(400).json({ error: 'Path required.' });

      await deleteServerPathAny(server, requestedPath);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to delete path.' });
    }
  })();
});

app.get('/api/server/:id/download', requireUser, (req, res) => {
  (async () => {
    try {
      const server = getServerById(req.params.id);
      if (!server) return res.status(404).json({ error: 'Server not found.' });
      if (!canAccessServer(req.user, server)) return res.status(403).json({ error: 'Not allowed.' });

      const requestedPath = String(req.query.path || '');
      if (!requestedPath) return res.status(400).json({ error: 'Path required.' });

      const file = await readServerFileAny(server, requestedPath);
      const filename = path.basename(file.path || requestedPath);
      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
      res.type('application/octet-stream').send(file.content);
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to download file.' });
    }
  })();
});

app.post('/api/server/:id/config', requireUser, (req, res) => {
  try {
    const server = getServerById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canAccessServer(req.user, server)) return res.status(403).json({ error: 'Not allowed.' });

    const requestedPort = String(req.body?.requestedPort || req.body?.network?.requestedPort || '').trim();
    const network = req.body?.network && typeof req.body.network === 'object' ? req.body.network : {};
    const database = req.body?.database && typeof req.body.database === 'object' ? req.body.database : {};
    const startup = req.body?.startup && typeof req.body.startup === 'object' ? req.body.startup : {};

    const updated = updateServerRecord(server.id, current => {
      current.network = {
        ...(current.network || {}),
        host: String(network.host || current.network?.host || '').trim(),
        requestedPort: requestedPort || String(current.network?.requestedPort || current.port || '').trim(),
        notes: String(network.notes || current.network?.notes || '').trim()
      };

      current.database = {
        ...(current.database || {}),
        enabled: !!database.enabled,
        host: String(database.host || current.database?.host || '').trim(),
        port: String(database.port || current.database?.port || '').trim(),
        database: String(database.database || current.database?.database || '').trim(),
        username: String(database.username || current.database?.username || '').trim(),
        password: String(database.password || current.database?.password || '')
      };

      if (RUNTIME_TYPES.has(String(current.type || '').toLowerCase())) {
        current.startup = normalizeStartup(current.type, {
          startFile: startup.startFile || current.startup?.startFile || '',
          startCommand: startup.startCommand || current.startup?.startCommand || ''
        });
      }

      if (requestedPort) {
        current.requestedPort = requestedPort;
      }

      return current;
    });

    const panelConfigPath = path.join(SERVERS_DIR, server.name, 'panel-config.json');
    fs.writeFileSync(panelConfigPath, JSON.stringify(updated, null, 2));

    res.json({ ok: true, server: updated });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save server configuration.' });
  }
});

app.post('/api/server/:id/command', requireUser, async (req, res) => {
  try {
    const server = getServerById(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canAccessServer(req.user, server)) return res.status(403).json({ error: 'Not allowed.' });

    const result = await sendServerConsoleCommand(server, req.body?.command);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to send command.' });
  }
});

app.post('/api/server/create', requireUser, async (req, res) => {
  try {
    const {
      name,
      type,
      version,
      nodeId,
      memory,
      extraPorts,
      database,
      network,
      worldId,
      worldWidth = '1',
      expertMode = false,
      startup = {}
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required.' });
    }

    const cleanName = sanitizeName(name);
    const serverType = String(type || 'paper').toLowerCase();
    const cleanWorldId = sanitizeWorldId(worldId);
    const allowedWidths = new Set(['1/16', '1/4', '1', '4', '16']);
    const selectedWorldWidth = allowedWidths.has(String(worldWidth)) ? String(worldWidth) : '1';
    const port = nextPortForType(serverType);
    const serverId = String(Date.now());
    const dir = path.join(SERVERS_DIR, cleanName);
    const normalizedStartup = normalizeStartup(serverType, startup);

    if (!SUPPORTED_SERVER_TYPES.has(serverType)) {
      return res.status(400).json({ error: `Unsupported server type: ${serverType}` });
    }

    if (!TYPES_WITHOUT_VERSION.has(serverType) && !RUNTIME_TYPES.has(serverType) && !version) {
      return res.status(400).json({ error: 'Version is required.' });
    }

    if (NODE_REQUIRED_TYPES.has(serverType) && !nodeId) {
      return res.status(400).json({ error: `${serverType} servers must be created on a node.` });
    }

    if (serverType === 'blockheads') {
      if (!cleanWorldId) {
        return res.status(400).json({ error: 'World ID is required for Blockheads.' });
      }
    }

    ensureDir(dir);

    if (!nodeId && serverType === 'paper') {
      await downloadPaper(version, dir);
    }

    if (MINECRAFT_TYPES.has(serverType)) {
      fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true');
    }

    let nodeResult = null;
    if (nodeId) {
      const node = getNodeById(nodeId);
      if (!node) {
        return res.status(400).json({ error: 'Selected node not found.' });
      }

      const payload = {
        serverId,
        name: cleanName,
        type: serverType,
        port,
        memory: memory || '2G',
        extraPorts: Array.isArray(extraPorts) ? extraPorts : [],
        database: database || '',
        network: network || {},
        startup: normalizedStartup
      };

      if (serverType === 'blockheads') {
        payload.worldId = cleanWorldId;
        payload.worldWidth = selectedWorldWidth;
        payload.expertMode = !!expertMode;
      } else if (!TYPES_WITHOUT_VERSION.has(serverType)) {
        payload.version = version || (serverType === 'nodejs' ? '20' : serverType === 'python' ? '3.11' : '');
      }

      nodeResult = await callNode(node, '/server/create', payload);
    }

    const server = normalizeServerRecord({
      id: serverId,
      name: cleanName,
      type: serverType,
      version: TYPES_WITHOUT_VERSION.has(serverType)
        ? ''
        : (version || (serverType === 'nodejs' ? '20' : serverType === 'python' ? '3.11' : '')),
      port,
      ownerUsername: req.user.username,
      nodeId: nodeId || '',
      memory: memory || '2G',
      status: nodeId ? 'running' : 'stopped',
      docker: !!nodeId,
      startup: normalizedStartup,
      extraPorts: Array.isArray(extraPorts) ? extraPorts : [],
      requestedPort: String(network?.requestedPort || '').trim(),
      network: {
        host: String(network?.host || (nodeId ? '' : 'local')).trim(),
        requestedPort: String(network?.requestedPort || '').trim(),
        notes: String(network?.notes || '').trim()
      },
      database: {
        enabled: !!database?.enabled,
        host: String(database?.host || '').trim(),
        port: String(database?.port || '').trim(),
        database: String(database?.database || '').trim(),
        username: String(database?.username || '').trim(),
        password: String(database?.password || '')
      }
    });

    if (serverType === 'blockheads') {
      server.worldId = cleanWorldId;
      server.worldWidth = selectedWorldWidth;
      server.expertMode = !!expertMode;
      server.maxPlayers = 16;
    }

    const servers = getServers();
    servers.push(server);
    saveServers(servers);

    fs.writeFileSync(path.join(dir, 'panel-config.json'), JSON.stringify(server, null, 2));

    res.json({ ok: true, server, nodeResult });
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).json({
      error: err?.response?.data?.error || 'Server creation failed.'
    });
  }
});

app.post('/api/server/start', requireUser, async (req, res) => {
  try {
    const { serverId } = req.body;
    const servers = getServers();
    const server = servers.find(s => s.id === serverId);

    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!isAdmin(req.user) && server.ownerUsername !== req.user.username) {
      return res.status(403).json({ error: 'Not allowed.' });
    }
    if (!server.nodeId) return res.status(400).json({ error: 'Server has no node.' });

    const node = getNodeById(server.nodeId);
    if (!node) return res.status(400).json({ error: 'Node not found.' });

    const result = await callNode(node, '/server/start', { serverId: server.id });
    server.status = 'running';
    saveServers(servers);

    res.json({ ok: true, result });
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).json({ error: err?.response?.data?.error || 'Failed to start server.' });
  }
});

app.post('/api/server/stop', requireUser, async (req, res) => {
  try {
    const { serverId } = req.body;
    const servers = getServers();
    const server = servers.find(s => s.id === serverId);

    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!isAdmin(req.user) && server.ownerUsername !== req.user.username) {
      return res.status(403).json({ error: 'Not allowed.' });
    }
    if (!server.nodeId) return res.status(400).json({ error: 'Server has no node.' });

    const node = getNodeById(server.nodeId);
    if (!node) return res.status(400).json({ error: 'Node not found.' });

    const result = await callNode(node, '/server/stop', { serverId: server.id });
    server.status = 'stopped';
    saveServers(servers);

    res.json({ ok: true, result });
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).json({ error: err?.response?.data?.error || 'Failed to stop server.' });
  }
});

app.post('/api/server/restart', requireUser, async (req, res) => {
  try {
    const { serverId } = req.body;
    const servers = getServers();
    const server = servers.find(s => s.id === serverId);

    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!isAdmin(req.user) && server.ownerUsername !== req.user.username) {
      return res.status(403).json({ error: 'Not allowed.' });
    }
    if (!server.nodeId) return res.status(400).json({ error: 'Server has no node.' });

    const node = getNodeById(server.nodeId);
    if (!node) return res.status(400).json({ error: 'Node not found.' });

    const result = await callNode(node, '/server/restart', { serverId: server.id });
    server.status = 'running';
    saveServers(servers);

    res.json({ ok: true, result });
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).json({ error: err?.response?.data?.error || 'Failed to restart server.' });
  }
});

app.get('/api/server/logs/:serverId', requireUser, async (req, res) => {
  try {
    const servers = getServers();
    const server = servers.find(s => s.id === req.params.serverId);

    if (!server) return res.status(404).send('Server not found.');
    if (!isAdmin(req.user) && server.ownerUsername !== req.user.username) {
      return res.status(403).send('Not allowed.');
    }
    if (!server.nodeId) return res.status(400).send('Server has no node.');

    const node = getNodeById(server.nodeId);
    if (!node) return res.status(400).send('Node not found.');

    const baseUrl = buildNodeBaseUrl(node);
    const nodeRes = await axios.get(`${baseUrl}/server/logs/${server.id}`, {
      headers: { 'x-node-api-key': node.apiKey || '' },
      timeout: 30000
    });

    res.type('text/plain').send(nodeRes.data);
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).send('Failed to load logs.');
  }
});

app.get('/api/files', requireUser, (req, res) => {
  const dir = req.query.dir || SERVERS_DIR;
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true }).map(f => ({
      name: f.name,
      isDir: f.isDirectory()
    }));
    res.json(files);
  } catch {
    res.json([]);
  }
});

app.post('/api/files/upload', requireUser, upload.single('file'), (req, res) => {
  try {
    const dest = req.body.path || SERVERS_DIR;
    ensureDir(dest);
    const newPath = path.join(dest, req.file.originalname);
    fs.renameSync(req.file.path, newPath);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed.' });
  }
});

app.get('/api/nodes', requireAdmin, (req, res) => {
  res.json(getNodes());
});

app.post('/api/nodes', requireAdmin, (req, res) => {
  const { name, ip, port, apiKey, description } = req.body;

  if (!name || !ip) {
    return res.status(400).json({ error: 'Node name and IP are required.' });
  }

  const nodes = getNodes();
  const node = {
    id: String(Date.now()),
    name,
    ip,
    port: port || '4110',
    apiKey: apiKey || '',
    description: description || '',
    status: 'unknown'
  };

  nodes.push(node);
  saveNodes(nodes);
  res.json({ ok: true, node });
});

app.get('/api/nodes/check/:id', requireAdmin, async (req, res) => {
  try {
    const node = getNodeById(req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found.' });

    const baseUrl = buildNodeBaseUrl(node);
    const nodeRes = await axios.get(`${baseUrl}/info`, {
      headers: { 'x-node-api-key': node.apiKey || '' },
      timeout: 15000
    });

    res.json({ ok: true, info: nodeRes.data });
  } catch {
    res.status(500).json({ ok: false, error: 'Node check failed.' });
  }
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({
    ...getSettings(),
    panelName: process.env.PANEL_NAME || 'Panel'
  });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const old = getSettings();
  const next = {
    ...old,
    ...req.body,
    smtp: {
      ...(old.smtp || {}),
      ...((req.body && req.body.smtp) || {})
    }
  };
  saveSettings(next);
  res.json({ ok: true, settings: next });
});

app.post('/api/integrations/website/provision', async (req, res) => {
  try {
    const providedKey = req.headers['x-panel-api-key'];
    const settings = getSettings();

    if (!providedKey || providedKey !== settings.panelApiKey) {
      return res.status(401).json({ error: 'Invalid API key.' });
    }

    const { email, serverName, serverType, serverVersion, nodeId } = req.body;

    if (!email || !serverName) {
      return res.status(400).json({ error: 'email and serverName are required.' });
    }

    const users = getUsers();
    let user = users.find(u => u.email === email || u.username === email);

    let tempPassword = null;
    let createdUser = false;

    if (!user) {
      tempPassword = randomPassword(10);
      user = {
        username: email,
        email,
        password: tempPassword,
        role: 'user',
        mustChangePassword: true
      };
      users.push(user);
      saveUsers(users);
      createdUser = true;
    }

    const cleanName = sanitizeName(serverName);
    const type = String(serverType || 'paper').toLowerCase();
    if (!SUPPORTED_SERVER_TYPES.has(type)) {
      return res.status(400).json({ error: `Unsupported server type: ${type}` });
    }

    if (!TYPES_WITHOUT_VERSION.has(type) && !RUNTIME_TYPES.has(type) && !serverVersion) {
      return res.status(400).json({ error: 'serverVersion is required for this server type.' });
    }

    if (NODE_REQUIRED_TYPES.has(type) && !nodeId) {
      return res.status(400).json({ error: `${type} servers must be created on a node.` });
    }

    const port = nextPortForType(type);
    const serverId = String(Date.now());
    const dir = path.join(SERVERS_DIR, cleanName);
    ensureDir(dir);

    if (type === 'paper') {
      await downloadPaper(serverVersion, dir);
    }

    if (MINECRAFT_TYPES.has(type)) {
      fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true');
    }

    let nodeResult = null;
    if (nodeId) {
      const node = getNodeById(nodeId);
      if (!node) {
        return res.status(400).json({ error: 'Selected node not found.' });
      }

      const nodePayload = {
        serverId,
        name: cleanName,
        type,
        port,
        memory: '2G',
        extraPorts: [],
        database: '',
        startup: normalizeStartup(type, {})
      };

      if (!TYPES_WITHOUT_VERSION.has(type)) {
        nodePayload.version = serverVersion || (type === 'nodejs' ? '20' : type === 'python' ? '3.11' : '');
      }

      nodeResult = await callNode(node, '/server/create', nodePayload);
    }

    const server = normalizeServerRecord({
      id: serverId,
      name: cleanName,
      type,
      version: TYPES_WITHOUT_VERSION.has(type)
        ? ''
        : (serverVersion || (type === 'nodejs' ? '20' : type === 'python' ? '3.11' : '')),
      port,
      ownerUsername: user.username,
      nodeId: nodeId || '',
      status: nodeId ? 'running' : 'stopped',
      docker: !!nodeId,
      memory: '2G',
      startup: normalizeStartup(type, {}),
      extraPorts: [],
      database: ''
    });

    const servers = getServers();
    servers.push(server);
    saveServers(servers);

    if (createdUser && tempPassword) {
      await maybeSendEmail(
        email,
        'Your panel account has been created',
        `Your panel account is ready.

Login email: ${email}
Temporary password: ${tempPassword}

Please log in and change your password in the panel.`
      );
    }

    res.json({
      ok: true,
      createdUser,
      emailedTempPassword: !!(createdUser && tempPassword),
      username: user.username,
      server,
      nodeResult
    });
  } catch (err) {
    console.error(err?.response?.data || err);
    res.status(500).json({
      error: err?.response?.data?.error || 'Provisioning failed.'
    });
  }
});

const PANEL_NAME = process.env.PANEL_NAME || 'Panel';
const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`${PANEL_NAME} running on http://localhost:${PORT}`);
});

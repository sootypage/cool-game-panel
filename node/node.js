const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
app.use(express.json({ limit: '25mb' }));

const CONFIG_FILE = path.join(__dirname, 'config.json');

if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(
      {
        nodeName: 'Node 1',
        nodeIp: '127.0.0.1',
        nodePort: 4110,
        panelUrl: 'http://localhost:3000',
        apiKey: 'change-me-node-key',
        dockerServersPath: './servers'
      },
      null,
      2
    )
  );
}

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

const MINECRAFT_TYPES = new Set(['paper', 'forge', 'fabric', 'vanilla']);
const SUPPORTED_TYPES = new Set([
  ...MINECRAFT_TYPES,
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

const CONSOLE_UNSUPPORTED_TYPES = new Set([
  'blockheads',
  'rust',
  'satisfactory',
  'mindustry',
  'nodejs',
  'python',
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

const SERVERS_DIR = path.resolve(__dirname, config.dockerServersPath || './servers');
if (!fs.existsSync(SERVERS_DIR)) {
  fs.mkdirSync(SERVERS_DIR, { recursive: true });
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
      if (error) {
        reject({
          error: error.message,
          stdout,
          stderr
        });
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function authOk(req) {
  const key = req.headers['x-node-api-key'];
  return key && key === config.apiKey;
}

function requireApiKey(req, res, next) {
  if (!authOk(req)) {
    return res.status(401).json({ error: 'Invalid node API key.' });
  }
  next();
}

function sanitizeName(name) {
  return String(name || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase();
}

function sanitizeWorldId(id) {
  return String(id || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toLowerCase()
    .slice(0, 40);
}

function sanitizeMemory(memory) {
  const value = String(memory || '2G').trim().toUpperCase();
  return /^[0-9]+[MG]$/.test(value) ? value : '2G';
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

function getTypeEnv(type) {
  const t = String(type || 'paper').toLowerCase();
  if (t === 'paper') return 'PAPER';
  if (t === 'forge') return 'FORGE';
  if (t === 'fabric') return 'FABRIC';
  if (t === 'vanilla') return 'VANILLA';
  return null;
}

async function dockerCheck() {
  try {
    const result = await runCommand('docker --version');
    return { ok: true, output: result.stdout || result.stderr };
  } catch (err) {
    return { ok: false, error: err.error || 'Docker not found.' };
  }
}

function serverFolder(serverId) {
  return path.join(SERVERS_DIR, serverId);
}

function containerName(serverId) {
  return `panel-${serverId}`;
}

function shellQuote(value) {
  return JSON.stringify(String(value));
}

function resolveServerPath(serverId, requestedPath = '') {
  const baseDir = path.resolve(serverFolder(sanitizeName(serverId)));
  const target = path.resolve(path.join(baseDir, String(requestedPath || '')));
  if (!target.startsWith(baseDir)) {
    throw new Error('Invalid path.');
  }
  return { baseDir, target };
}

function listFiles(serverId, requestedPath = '') {
  const { target } = resolveServerPath(serverId, requestedPath);
  const files = fs.readdirSync(target, { withFileTypes: true }).map(item => ({
    name: item.name,
    isDir: item.isDirectory(),
    path: path.posix.join(String(requestedPath || '').replace(/\\/g, '/'), item.name).replace(/^\/+/, '')
  }));

  files.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  return files;
}

function copyRecursiveSync(src, dest) {
  const stat = fs.statSync(src);

  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function listServerMetas() {
  if (!fs.existsSync(SERVERS_DIR)) return [];

  const entries = fs.readdirSync(SERVERS_DIR, { withFileTypes: true });
  const metas = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaFile = path.join(SERVERS_DIR, entry.name, 'server.json');
    if (!fs.existsSync(metaFile)) continue;

    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      metas.push(meta);
    } catch {}
  }

  return metas;
}

function findFreePort(start = 25565, end = 65535) {
  const used = new Set(
    listServerMetas()
      .map(meta => Number(meta.port))
      .filter(port => Number.isInteger(port))
  );

  for (let port = start; port <= end; port++) {
    if (!used.has(port)) return port;
  }

  throw new Error('No free ports available.');
}

function runConsoleCommand(dockerName, command) {
  const commandText = String(command || '').trim();

  return runCommand(`docker exec ${shellQuote(dockerName)} rcon-cli ${shellQuote(commandText)}`).catch(async rconErr => {
    const stdinCommand = `printf '%s\n' ${shellQuote(commandText)} | docker exec -i ${shellQuote(dockerName)} sh -lc 'cat > /proc/1/fd/0'`;

    try {
      return await runCommand(stdinCommand);
    } catch (stdinErr) {
      throw {
        error: rconErr.error || stdinErr.error || 'Failed to send console command.',
        stdout: stdinErr.stdout || rconErr.stdout || '',
        stderr: stdinErr.stderr || rconErr.stderr || ''
      };
    }
  });
}

function makeMeta(cleanId, cleanName, type, port, memory, extra = {}) {
  return {
    serverId: cleanId,
    name: cleanName,
    type,
    port,
    memory,
    ...extra
  };
}

function writeMeta(folder, meta) {
  fs.writeFileSync(path.join(folder, 'server.json'), JSON.stringify(meta, null, 2), 'utf8');
}

function unsupportedNow(type, reason) {
  return {
    placeholder: true,
    type,
    reason
  };
}

app.get('/status', async (req, res) => {
  const docker = await dockerCheck();

  res.json({
    ok: true,
    nodeName: config.nodeName,
    nodeIp: config.nodeIp,
    nodePort: config.nodePort,
    panelUrl: config.panelUrl,
    docker
  });
});

app.get('/info', requireApiKey, async (req, res) => {
  const docker = await dockerCheck();

  res.json({
    ok: true,
    nodeName: config.nodeName,
    nodeIp: config.nodeIp,
    nodePort: config.nodePort,
    panelUrl: config.panelUrl,
    docker
  });
});

app.post('/server/create', requireApiKey, async (req, res) => {
  try {
    const {
      serverId,
      name,
      type,
      version,
      port,
      memory = '2G',
      worldId,
      worldWidth = '1',
      expertMode = false,
      startup = {}
    } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'name and type are required.' });
    }

    const cleanType = String(type).toLowerCase();
    const cleanName = sanitizeName(name);
    const cleanId = sanitizeName(serverId || `${cleanName}-${Date.now()}`);
    const folder = serverFolder(cleanId);
    const selectedMemory = sanitizeMemory(memory);
    const normalizedStartup = normalizeStartup(cleanType, startup);

    if (!SUPPORTED_TYPES.has(cleanType)) {
      return res.status(400).json({ error: `Unsupported server type: ${cleanType}` });
    }

    if (fs.existsSync(folder)) {
      return res.status(400).json({ error: 'A server with that ID already exists.' });
    }

    fs.mkdirSync(folder, { recursive: true });

    const dockerAvailable = await dockerCheck();
    if (!dockerAvailable.ok) {
      return res.status(500).json({
        error: 'Docker is not available on this node.',
        details: dockerAvailable.error
      });
    }

    if (cleanType === 'blockheads') {
      const cleanWorldId = sanitizeWorldId(worldId);
      const allowedWidths = new Set(['1/16', '1/4', '1', '4', '16']);
      const selectedWidth = allowedWidths.has(String(worldWidth)) ? String(worldWidth) : '1';
      const assignedPort = Number(port) || findFreePort(15151, 15250);

      if (!cleanWorldId) {
        return res.status(400).json({ error: 'worldId is required for Blockheads.' });
      }

      const templateDir = path.join(__dirname, 'templates', 'blockheads');
      if (!fs.existsSync(templateDir)) {
        return res.status(500).json({ error: 'Blockheads template folder is missing on the node.' });
      }

      copyRecursiveSync(templateDir, folder);

      const envText = [
        `WORLD_NAME=${cleanName}`,
        `WORLD_ID=${cleanWorldId}`,
        `PORT=${assignedPort}`,
        `MAX_PLAYERS=16`,
        `SAVE_DELAY=1`,
        `WORLD_WIDTH=${selectedWidth}`,
        `EXPERT_MODE=${expertMode ? 'true' : 'false'}`
      ].join('\n');

      fs.writeFileSync(path.join(folder, '.env'), envText, 'utf8');

      writeMeta(folder, makeMeta(cleanId, cleanName, 'blockheads', assignedPort, selectedMemory, {
        maxPlayers: 16,
        worldId: cleanWorldId,
        worldWidth: selectedWidth,
        expertMode: !!expertMode
      }));

      const dockerName = containerName(cleanId);
      const imageName = `panel-blockheads-${cleanId}`;
      const buildResult = await runCommand(`docker build -t ${shellQuote(imageName)} ${shellQuote(templateDir)}`);

      const dockerCmd = [
        `docker run -d`,
        `--name ${dockerName}`,
        `-p ${assignedPort}:${assignedPort}/tcp`,
        `-p ${assignedPort}:${assignedPort}/udp`,
        `--restart unless-stopped`,
        `-m ${selectedMemory}`,
        `-v "${folder}:/server"`,
        `-e WORLD_NAME=${shellQuote(cleanName)}`,
        `-e WORLD_ID=${shellQuote(cleanWorldId)}`,
        `-e PORT=${assignedPort}`,
        `-e MAX_PLAYERS=16`,
        `-e SAVE_DELAY=1`,
        `-e WORLD_WIDTH=${shellQuote(selectedWidth)}`,
        `-e EXPERT_MODE=${expertMode ? 'true' : 'false'}`,
        imageName
      ].join(' ');

      const result = await runCommand(dockerCmd);

      return res.json({
        ok: true,
        message: 'Blockheads server container created.',
        serverId: cleanId,
        containerName: dockerName,
        port: assignedPort,
        output: (buildResult.stdout || buildResult.stderr || '') + (result.stdout || result.stderr || '')
      });
    }

    if (cleanType === 'rust') {
      const assignedPort = Number(port);
      if (!Number.isInteger(assignedPort) || assignedPort < 1 || assignedPort > 65535) {
        return res.status(400).json({ error: 'port must be a valid integer between 1 and 65535.' });
      }

      const rconPort = assignedPort + 1;
      const dockerName = containerName(cleanId);

      writeMeta(folder, makeMeta(cleanId, cleanName, 'rust', assignedPort, selectedMemory, { rconPort }));

      const dockerCmd = [
        `docker run -d`,
        `--name ${dockerName}`,
        `-p ${assignedPort}:${assignedPort}/udp`,
        `-p ${assignedPort}:${assignedPort}/tcp`,
        `-p ${rconPort}:${rconPort}/tcp`,
        `--restart unless-stopped`,
        `-m ${selectedMemory}`,
        `-e RUST_SERVER_NAME=${shellQuote(cleanName)}`,
        `-e RUST_SERVER_DESCRIPTION=${shellQuote(`Managed by panel: ${cleanName}`)}`,
        `-e RUST_SERVER_PORT=${assignedPort}`,
        `-e RUST_RCON_PORT=${rconPort}`,
        `-e RUST_SERVER_MAXPLAYERS=50`,
        `-v "${folder}:/steamcmd/rust"`,
        `didstopia/rust-server:latest`
      ].join(' ');

      const result = await runCommand(dockerCmd);

      return res.json({
        ok: true,
        message: 'Rust server container created.',
        serverId: cleanId,
        containerName: dockerName,
        port: assignedPort,
        output: result.stdout || result.stderr
      });
    }

    if (cleanType === 'satisfactory') {
      const gamePort = Number(port);
      if (!Number.isInteger(gamePort) || gamePort < 1 || gamePort > 65533) {
        return res.status(400).json({ error: 'port must be a valid integer between 1 and 65533.' });
      }

      const beaconPort = gamePort + 1;
      const queryPort = gamePort + 2;
      const dockerName = containerName(cleanId);

      writeMeta(folder, makeMeta(cleanId, cleanName, 'satisfactory', gamePort, selectedMemory, {
        beaconPort,
        queryPort
      }));

      const dockerCmd = [
        `docker run -d`,
        `--name ${dockerName}`,
        `-p ${gamePort}:${gamePort}/udp`,
        `-p ${beaconPort}:${beaconPort}/udp`,
        `-p ${queryPort}:${queryPort}/udp`,
        `--restart unless-stopped`,
        `-m ${selectedMemory}`,
        `-e MAXPLAYERS=16`,
        `-e SERVERGAMEPORT=${gamePort}`,
        `-e BEACONPORT=${beaconPort}`,
        `-e QUERYPORT=${queryPort}`,
        `-e SKIPUPDATE=false`,
        `-v "${folder}:/config"`,
        `ghcr.io/wolveix/satisfactory-server:latest`
      ].join(' ');

      const result = await runCommand(dockerCmd);

      return res.json({
        ok: true,
        message: 'Satisfactory server container created.',
        serverId: cleanId,
        containerName: dockerName,
        port: gamePort,
        output: result.stdout || result.stderr
      });
    }

    if (cleanType === 'nodejs') {
      const appPort = Number(port) || findFreePort(3000, 3999);
      const nodeVersion = String(version || '20').trim();
      const dockerName = containerName(cleanId);

      writeMeta(folder, makeMeta(cleanId, cleanName, 'nodejs', appPort, selectedMemory, {
        version: nodeVersion,
        startup: normalizedStartup
      }));

      const dockerCmd = [
        `docker run -d`,
        `--name ${dockerName}`,
        `-p ${appPort}:3000`,
        `--restart unless-stopped`,
        `-m ${selectedMemory}`,
        `-v "${folder}:/workspace"`,
        `-w /workspace`,
        `node:${nodeVersion}-alpine`,
        `sh -lc ${shellQuote(normalizedStartup.startCommand || `node ${normalizedStartup.startFile || 'server.js'}`)}`
      ].join(' ');

      const result = await runCommand(dockerCmd);

      return res.json({
        ok: true,
        message: 'Node.js container created.',
        serverId: cleanId,
        containerName: dockerName,
        port: appPort,
        output: result.stdout || result.stderr
      });
    }

    if (cleanType === 'python') {
      const appPort = Number(port) || findFreePort(8000, 8999);
      const pyVersion = String(version || '3.11').trim();
      const dockerName = containerName(cleanId);

      writeMeta(folder, makeMeta(cleanId, cleanName, 'python', appPort, selectedMemory, {
        version: pyVersion,
        startup: normalizedStartup
      }));

      const dockerCmd = [
        `docker run -d`,
        `--name ${dockerName}`,
        `-p ${appPort}:8000`,
        `--restart unless-stopped`,
        `-m ${selectedMemory}`,
        `-v "${folder}:/app"`,
        `-w /app`,
        `python:${pyVersion}-slim`,
        `sh -lc ${shellQuote(normalizedStartup.startCommand || `python ${normalizedStartup.startFile || 'main.py'}`)}`
      ].join(' ');

      const result = await runCommand(dockerCmd);

      return res.json({
        ok: true,
        message: 'Python container created.',
        serverId: cleanId,
        containerName: dockerName,
        port: appPort,
        output: result.stdout || result.stderr
      });
    }

    if (cleanType === 'mindustry') {
      const gamePort = Number(port) || findFreePort(6567, 6667);
      const dockerName = containerName(cleanId);

      writeMeta(folder, makeMeta(cleanId, cleanName, 'mindustry', gamePort, selectedMemory));

      const dockerCmd = [
        `docker run -d`,
        `--name ${dockerName}`,
        `-p ${gamePort}:6567/tcp`,
        `-p ${gamePort}:6567/udp`,
        `--restart unless-stopped`,
        `-m ${selectedMemory}`,
        `-v "${folder}:/mindustry"`,
        `ich777/mindustry-server`
      ].join(' ');

      const result = await runCommand(dockerCmd);

      return res.json({
        ok: true,
        message: 'Mindustry server container created.',
        serverId: cleanId,
        containerName: dockerName,
        port: gamePort,
        output: result.stdout || result.stderr
      });
    }

    if (cleanType === 'projectzomboid') {
      const gamePort = Number(port) || findFreePort(16261, 16361);
      const dockerName = containerName(cleanId);

      writeMeta(folder, makeMeta(cleanId, cleanName, 'projectzomboid', gamePort, selectedMemory));

      const dockerCmd = [
        `docker run -d`,
        `--name ${dockerName}`,
        `-p ${gamePort}:16261/udp`,
        `-p ${gamePort + 1}:16262/udp`,
        `--restart unless-stopped`,
        `-m ${selectedMemory}`,
        `-v "${folder}:/pzserver"`,
        `renegademaster/zomboid-dedicated-server`
      ].join(' ');

      const result = await runCommand(dockerCmd);

      return res.json({
        ok: true,
        message: 'Project Zomboid server container created.',
        serverId: cleanId,
        containerName: dockerName,
        port: gamePort,
        output: result.stdout || result.stderr
      });
    }

    if (cleanType === '7daystodie') {
      const gamePort = Number(port) || findFreePort(26900, 27000);
      const dockerName = containerName(cleanId);

      writeMeta(folder, makeMeta(cleanId, cleanName, '7daystodie', gamePort, selectedMemory));

      const dockerCmd = [
        `docker run -d`,
        `--name ${dockerName}`,
        `-p ${gamePort}:${gamePort}/udp`,
        `-p ${gamePort + 1}:${gamePort + 1}/udp`,
        `-p ${gamePort + 2}:${gamePort + 2}/tcp`,
        `--restart unless-stopped`,
        `-m ${selectedMemory}`,
        `-v "${folder}:/data"`,
        `vinanrra/7dtd-server`
      ].join(' ');

      const result = await runCommand(dockerCmd);

      return res.json({
        ok: true,
        message: '7 Days to Die server container created.',
        serverId: cleanId,
        containerName: dockerName,
        port: gamePort,
        output: result.stdout || result.stderr
      });
    }

    if (cleanType === 'ark') {
      const gamePort = Number(port) || findFreePort(7777, 7877);
      const dockerName = containerName(cleanId);

      writeMeta(folder, makeMeta(cleanId, cleanName, 'ark', gamePort, selectedMemory));

      const dockerCmd = [
        `docker run -d`,
        `--name ${dockerName}`,
        `-p ${gamePort}:7777/udp`,
        `-p ${gamePort + 1}:7778/udp`,
        `-p ${gamePort + 19308}:27015/udp`,
        `--restart unless-stopped`,
        `-m ${selectedMemory}`,
        `-e SESSION_NAME=${shellQuote(cleanName)}`,
        `-v "${folder}:/ark"`,
        `hermsi/ark-server`
      ].join(' ');

      const result = await runCommand(dockerCmd);

      return res.json({
        ok: true,
        message: 'ARK server container created.',
        serverId: cleanId,
        containerName: dockerName,
        port: gamePort,
        output: result.stdout || result.stderr
      });
    }

    if (cleanType === 'astroneer') {
      const gamePort = Number(port) || findFreePort(7777, 7877);
      const dockerName = containerName(cleanId);

      writeMeta(folder, makeMeta(cleanId, cleanName, 'astroneer', gamePort, selectedMemory));

      const dockerCmd = [
        `docker run -d`,
        `--name ${dockerName}`,
        `-p ${gamePort}:7777/udp`,
        `-p 5000:5000/tcp`,
        `--restart unless-stopped`,
        `-m ${selectedMemory}`,
        `-v "${folder}:/data"`,
        `whalybird/astroneer-server:latest`
      ].join(' ');

      const result = await runCommand(dockerCmd);

      return res.json({
        ok: true,
        message: 'Astroneer server container created.',
        serverId: cleanId,
        containerName: dockerName,
        port: gamePort,
        output: result.stdout || result.stderr
      });
    }

    if (cleanType === 'farmingsim22') {
      const webPort = Number(port) || findFreePort(8080, 8180);
      const dockerName = containerName(cleanId);

      writeMeta(folder, makeMeta(cleanId, cleanName, 'farmingsim22', webPort, selectedMemory));

      const dockerCmd = [
        `docker run -d`,
        `--name ${dockerName}`,
        `-p ${webPort}:8080/tcp`,
        `--restart unless-stopped`,
        `-m ${selectedMemory}`,
        `-v "${folder}:/config"`,
        `toetje585/arch-wine-fs22`
      ].join(' ');

      const result = await runCommand(dockerCmd);

      return res.json({
        ok: true,
        message: 'Farming Simulator 22 container created.',
        serverId: cleanId,
        containerName: dockerName,
        port: webPort,
        output: result.stdout || result.stderr
      });
    }

    if (cleanType === 'farmingsim25' || cleanType === 'dayz' || cleanType === 'sonsoftheforest' || cleanType === 'unturned') {
      writeMeta(folder, makeMeta(cleanId, cleanName, cleanType, Number(port) || 0, selectedMemory, unsupportedNow(
        cleanType,
        'This type is registered in the node file, but still needs a tested container recipe or extra credentials/licensing setup.'
      )));
      return res.status(501).json({
        error: `${cleanType} is added to the node file, but its container recipe still needs testing before it can be launched safely.`
      });
    }

    if (!version || !port) {
      return res.status(400).json({ error: 'version and port are required for this server type.' });
    }

    const envType = getTypeEnv(cleanType);
    if (!envType || !MINECRAFT_TYPES.has(cleanType)) {
      return res.status(400).json({ error: `Unsupported Minecraft server type: ${cleanType}` });
    }

    const dockerName = containerName(cleanId);

    writeMeta(folder, makeMeta(cleanId, cleanName, cleanType, Number(port), selectedMemory, { version }));

    const dockerCmd = [
      `docker run -d`,
      `--name ${dockerName}`,
      `-p ${port}:25565`,
      `--restart unless-stopped`,
      `-e EULA=TRUE`,
      `-e TYPE=${envType}`,
      `-e VERSION=${version}`,
      `-e MEMORY=${selectedMemory}`,
      `-e MOTD="${cleanName}"`,
      `-v "${folder}:/data"`,
      `itzg/minecraft-server`
    ].join(' ');

    const result = await runCommand(dockerCmd);

    res.json({
      ok: true,
      message: 'Server container created.',
      serverId: cleanId,
      containerName: dockerName,
      output: result.stdout || result.stderr
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: 'Failed to create server container.',
      details: err.message || err
    });
  }
});

app.post('/server/start', requireApiKey, async (req, res) => {
  try {
    const { serverId } = req.body;
    if (!serverId) return res.status(400).json({ error: 'serverId is required.' });

    const dockerName = containerName(sanitizeName(serverId));
    const result = await runCommand(`docker start ${dockerName}`);

    res.json({
      ok: true,
      message: 'Server started.',
      output: result.stdout || result.stderr
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start server.', details: err });
  }
});

app.post('/server/stop', requireApiKey, async (req, res) => {
  try {
    const { serverId } = req.body;
    if (!serverId) return res.status(400).json({ error: 'serverId is required.' });

    const dockerName = containerName(sanitizeName(serverId));
    const result = await runCommand(`docker stop ${dockerName}`);

    res.json({
      ok: true,
      message: 'Server stopped.',
      output: result.stdout || result.stderr
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop server.', details: err });
  }
});

app.post('/server/restart', requireApiKey, async (req, res) => {
  try {
    const { serverId } = req.body;
    if (!serverId) return res.status(400).json({ error: 'serverId is required.' });

    const dockerName = containerName(sanitizeName(serverId));
    const result = await runCommand(`docker restart ${dockerName}`);

    res.json({
      ok: true,
      message: 'Server restarted.',
      output: result.stdout || result.stderr
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to restart server.', details: err });
  }
});

app.post('/server/delete', requireApiKey, async (req, res) => {
  try {
    const { serverId, deleteFiles } = req.body;
    if (!serverId) return res.status(400).json({ error: 'serverId is required.' });

    const cleanId = sanitizeName(serverId);
    const dockerName = containerName(cleanId);

    try {
      await runCommand(`docker rm -f ${dockerName}`);
    } catch {}

    if (deleteFiles) {
      const folder = serverFolder(cleanId);
      if (fs.existsSync(folder)) {
        fs.rmSync(folder, { recursive: true, force: true });
      }
    }

    res.json({
      ok: true,
      message: 'Server deleted.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete server.', details: err });
  }
});

app.get('/server/logs/:serverId', requireApiKey, async (req, res) => {
  try {
    const dockerName = containerName(sanitizeName(req.params.serverId));
    const result = await runCommand(`docker logs --tail 200 ${dockerName}`);
    res.type('text/plain').send((result.stdout || '') + (result.stderr || ''));
  } catch {
    res.status(500).send('Failed to get logs.');
  }
});

app.post('/server/command', requireApiKey, async (req, res) => {
  try {
    const { serverId, command } = req.body;
    if (!serverId) return res.status(400).json({ error: 'serverId is required.' });

    const cleanId = sanitizeName(serverId);
    const cleanCommand = String(command || '').trim();
    if (!cleanCommand) return res.status(400).json({ error: 'command is required.' });

    const metaFile = path.join(serverFolder(cleanId), 'server.json');
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (CONSOLE_UNSUPPORTED_TYPES.has(String(meta.type || '').toLowerCase())) {
        return res.status(400).json({ error: `Console commands are not supported for ${meta.type} servers.` });
      }
    }

    const dockerName = containerName(cleanId);
    const result = await runConsoleCommand(dockerName, cleanCommand);

    res.json({
      ok: true,
      message: 'Command sent.',
      output: result.stdout || result.stderr || ''
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send command.', details: err });
  }
});

app.get('/server/status/:serverId', requireApiKey, async (req, res) => {
  try {
    const dockerName = containerName(sanitizeName(req.params.serverId));
    const result = await runCommand(`docker inspect -f "{{.State.Status}}" ${dockerName}`);
    res.json({ ok: true, status: String(result.stdout || '').trim() });
  } catch {
    res.json({ ok: false, status: 'not-found' });
  }
});

app.get('/server/files/:serverId', requireApiKey, (req, res) => {
  try {
    const requestedPath = String(req.query.path || '');
    const files = listFiles(req.params.serverId, requestedPath);
    res.json({
      ok: true,
      currentPath: requestedPath.replace(/\\/g, '/'),
      files
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to list files.' });
  }
});

app.get('/server/file/:serverId', requireApiKey, (req, res) => {
  try {
    const requestedPath = String(req.query.path || '');
    if (!requestedPath) return res.status(400).json({ error: 'Path required.' });

    const { target } = resolveServerPath(req.params.serverId, requestedPath);
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return res.status(400).json({ error: 'That path is a directory.' });

    const content = fs.readFileSync(target, 'utf8');
    res.json({ ok: true, path: requestedPath.replace(/\\/g, '/'), content });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to read file.' });
  }
});

app.post('/server/file/:serverId', requireApiKey, (req, res) => {
  try {
    const requestedPath = String(req.body.path || '');
    const content = String(req.body.content ?? '');
    if (!requestedPath) return res.status(400).json({ error: 'Path required.' });

    const { target } = resolveServerPath(req.params.serverId, requestedPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to save file.' });
  }
});

app.post('/server/upload/:serverId', requireApiKey, (req, res) => {
  try {
    const requestedPath = String(req.body.path || '');
    const contentBase64 = String(req.body.contentBase64 || '');
    const overwrite = !!req.body.overwrite;

    if (!requestedPath) return res.status(400).json({ error: 'Path required.' });
    if (!contentBase64) return res.status(400).json({ error: 'contentBase64 required.' });

    const { target } = resolveServerPath(req.params.serverId, requestedPath);
    if (fs.existsSync(target) && !overwrite) {
      return res.status(400).json({ error: 'File already exists.' });
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(contentBase64, 'base64'));

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to upload file.' });
  }
});

app.post('/server/mkdir/:serverId', requireApiKey, (req, res) => {
  try {
    const requestedPath = String(req.body.path || '');
    if (!requestedPath) return res.status(400).json({ error: 'Path required.' });

    const { target } = resolveServerPath(req.params.serverId, requestedPath);
    fs.mkdirSync(target, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to create folder.' });
  }
});

app.post('/server/rename/:serverId', requireApiKey, (req, res) => {
  try {
    const oldPath = String(req.body.oldPath || '');
    const newPath = String(req.body.newPath || '');
    if (!oldPath || !newPath) {
      return res.status(400).json({ error: 'oldPath and newPath are required.' });
    }

    const from = resolveServerPath(req.params.serverId, oldPath).target;
    const to = resolveServerPath(req.params.serverId, newPath).target;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to rename path.' });
  }
});

app.post('/server/delete-path/:serverId', requireApiKey, (req, res) => {
  try {
    const requestedPath = String(req.body.path || '');
    if (!requestedPath) return res.status(400).json({ error: 'Path required.' });

    const { target } = resolveServerPath(req.params.serverId, requestedPath);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Path not found.' });

    const stat = fs.statSync(target);
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.unlinkSync(target);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to delete path.' });
  }
});

app.get('/server/download/:serverId', requireApiKey, (req, res) => {
  try {
    const requestedPath = String(req.query.path || '');
    if (!requestedPath) return res.status(400).json({ error: 'Path required.' });

    const { target } = resolveServerPath(req.params.serverId, requestedPath);
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Path is a directory.' });

    const content = fs.readFileSync(target, 'utf8');
    res.json({ ok: true, path: requestedPath.replace(/\\/g, '/'), content });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to download file.' });
  }
});

app.listen(config.nodePort || 4110, () => {
  console.log(`Node running on port ${config.nodePort || 4110}`);
  console.log(`Node name: ${config.nodeName}`);
  console.log(`Panel URL: ${config.panelUrl}`);
});

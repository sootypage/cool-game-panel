require('dotenv').config();
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, execFile } = require('child_process');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = Number(process.env.AGENT_PORT || 4100);
const TOKEN = process.env.AGENT_TOKEN || 'change-this-agent-token';
const ROOT = path.resolve(process.env.SERVICES_DIR || '/opt/outback-node/services');
const TMP = path.resolve(process.env.TMP_DIR || '/opt/outback-node/tmp');
const DB_FILE = path.join(ROOT, 'agent-db.json');

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ services: [] }, null, 2));
const upload = multer({ dest: TMP, limits: { fileSize: 1024 * 1024 * 1024 } });
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

function auth(req, res, next) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-agent-token'];
  if (raw !== TOKEN) return res.status(401).json({ error: 'Unauthorized agent token.' });
  next();
}
function readDb(){ return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDb(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function sh(cmd, args, opts={}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 20, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}
function safeName(s){ return String(s || 'service').toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').slice(0,40) || 'service'; }
function safePath(base, rel='') {
  const target = path.resolve(base, rel || '.');
  if (!target.startsWith(path.resolve(base))) throw new Error('Unsafe path.');
  return target;
}
function serviceFolder(id){ return path.join(ROOT, id); }
function getService(id){ return readDb().services.find(s => s.id === id); }
async function dockerInspect(name){
  try { const { stdout } = await sh('docker', ['inspect', name]); return JSON.parse(stdout)[0]; } catch { return null; }
}
async function dockerStats(name){
  try {
    const { stdout } = await sh('docker', ['stats', '--no-stream', '--format', '{{json .}}', name]);
    return stdout.trim() ? JSON.parse(stdout.trim()) : null;
  } catch { return null; }
}

const GAME_TYPES = {
  PAPER: { label:'Minecraft Paper', image:'itzg/minecraft-server:java21', port:25565, env:{ EULA:'TRUE', TYPE:'PAPER' }, dataMount:'/data', commandMode:'rcon' },
  PURPUR: { label:'Minecraft Purpur', image:'itzg/minecraft-server:java21', port:25565, env:{ EULA:'TRUE', TYPE:'PURPUR' }, dataMount:'/data', commandMode:'rcon' },
  SPIGOT: { label:'Minecraft Spigot', image:'itzg/minecraft-server:java21', port:25565, env:{ EULA:'TRUE', TYPE:'SPIGOT' }, dataMount:'/data', commandMode:'rcon' },
  VANILLA: { label:'Minecraft Vanilla', image:'itzg/minecraft-server:java21', port:25565, env:{ EULA:'TRUE', TYPE:'VANILLA' }, dataMount:'/data', commandMode:'rcon' },
  FORGE: { label:'Minecraft Forge', image:'itzg/minecraft-server:java21', port:25565, env:{ EULA:'TRUE', TYPE:'FORGE' }, dataMount:'/data', commandMode:'rcon' },
  FABRIC: { label:'Minecraft Fabric', image:'itzg/minecraft-server:java21', port:25565, env:{ EULA:'TRUE', TYPE:'FABRIC' }, dataMount:'/data', commandMode:'rcon' },
  NEOFORGE: { label:'Minecraft NeoForge', image:'itzg/minecraft-server:java21', port:25565, env:{ EULA:'TRUE', TYPE:'NEOFORGE' }, dataMount:'/data', commandMode:'rcon' },
  VELOCITY: { label:'Velocity Proxy', image:'itzg/mc-proxy', port:25577, env:{ TYPE:'VELOCITY' }, dataMount:'/server', commandMode:'shell' },
  WATERFALL: { label:'Waterfall Proxy', image:'itzg/mc-proxy', port:25577, env:{ TYPE:'WATERFALL' }, dataMount:'/server', commandMode:'shell' },
  RUST: { label:'Rust', image:'didstopia/rust-server:latest', port:28015, env:{}, dataMount:'/steamcmd/rust', commandMode:'shell' },
  VALHEIM: { label:'Valheim', image:'lloesche/valheim-server', port:2456, env:{ SERVER_PASS:'ChangeMe123' }, dataMount:'/config', commandMode:'shell' },
  TERRARIA: { label:'Terraria', image:'ryshe/terraria:latest', port:7777, env:{}, dataMount:'/root/.local/share/Terraria/Worlds', commandMode:'shell' },
  FACTORIO: { label:'Factorio', image:'factoriotools/factorio:stable', port:34197, env:{}, dataMount:'/factorio', commandMode:'shell' },
  PALWORLD: { label:'Palworld', image:'thijsvanloef/palworld-server-docker:latest', port:8211, env:{ ACCEPT_EULA:'true' }, dataMount:'/palworld', commandMode:'shell' }
};

app.get('/health', auth, async (req,res)=>res.json({ ok:true, root:ROOT, games:Object.keys(GAME_TYPES), time:new Date().toISOString() }));
app.get('/catalog/games', auth, (req,res)=>res.json({ games: GAME_TYPES }));

app.post('/services/game', auth, async (req,res)=>{
  const type = String(req.body.serverType || req.body.type || 'PAPER').toUpperCase();
  const cfg = GAME_TYPES[type] || GAME_TYPES.PAPER;
  const id = uuidv4();
  const name = safeName(req.body.name || `${type}-${id.slice(0,6)}`);
  const folder = serviceFolder(id);
  const dataDir = path.join(folder, 'data');
  const backupsDir = path.join(folder, 'backups');
  await fsp.mkdir(dataDir, { recursive:true });
  await fsp.mkdir(backupsDir, { recursive:true });
  const container = `ob-${name}-${id.slice(0,8)}`;
  const publicPort = Number(req.body.port || cfg.port);
  const memoryMb = Number(req.body.memoryMb || 2048);
  const env = { ...cfg.env, ...(req.body.env || {}) };
  if (req.body.version) env.VERSION = req.body.version;
  if (type.startsWith('MINECRAFT') || ['PAPER','PURPUR','SPIGOT','VANILLA','FORGE','FABRIC','NEOFORGE'].includes(type)) {
    env.ENABLE_RCON = 'true'; env.RCON_PASSWORD = req.body.rconPassword || 'minecraft'; env.MEMORY = `${Math.floor(memoryMb*0.85)}M`; env.MOTD = req.body.motd || name;
  }
  const args = ['run','-d','--name',container,'--restart','unless-stopped','-m',`${memoryMb}m`,'-p',`${publicPort}:${cfg.port}`,'-v',`${dataDir}:${cfg.dataMount}`];
  for (const [k,v] of Object.entries(env)) if (v !== undefined && v !== '') args.push('-e', `${k}=${v}`);
  args.push(req.body.image || cfg.image);
  const created = await sh('docker', args);
  const svc = { id, kind:'game', name, serverType:type, version:req.body.version || 'LATEST', image:req.body.image || cfg.image, container, port:publicPort, internalPort:cfg.port, memoryMb, storageMb:Number(req.body.storageMb||10240), dataDir, backupsDir, commandMode:cfg.commandMode, createdAt:new Date().toISOString() };
  const db = readDb(); db.services.push(svc); writeDb(db);
  res.json({ ok:true, service:svc, docker:created.stdout.trim() });
});

app.post('/services/vps', auth, async (req,res)=>{
  const id = uuidv4();
  const name = safeName(req.body.name || `vps-${id.slice(0,6)}`);
  const folder = serviceFolder(id); const dataDir = path.join(folder, 'rootfs'); const backupsDir = path.join(folder, 'backups');
  await fsp.mkdir(dataDir, { recursive:true }); await fsp.mkdir(backupsDir, { recursive:true });
  const container = `ob-vps-${name}-${id.slice(0,8)}`;
  const sshPort = Number(req.body.sshPort || req.body.port || (22000 + Math.floor(Math.random()*20000)));
  const memoryMb = Number(req.body.memoryMb || 1024);
  const storageMb = Number(req.body.storageMb || 10240);
  // Container VPS: lightweight Linux container with SSH. Not a full KVM VM.
  const image = req.body.image || 'lscr.io/linuxserver/openssh-server:latest';
  const password = req.body.password || Math.random().toString(36).slice(2,12);
  const args = ['run','-d','--name',container,'--restart','unless-stopped','-m',`${memoryMb}m`,'-p',`${sshPort}:2222`,'-v',`${dataDir}:/config`,'-e','PUID=1000','-e','PGID=1000','-e','PASSWORD_ACCESS=true','-e',`USER_PASSWORD=${password}`,'-e',`USER_NAME=${req.body.username||'rootuser'}`, image];
  await sh('docker', args);
  const svc = { id, kind:'vps', name, image, container, port:sshPort, memoryMb, storageMb, dataDir, backupsDir, username:req.body.username||'rootuser', password, createdAt:new Date().toISOString() };
  const db = readDb(); db.services.push(svc); writeDb(db);
  res.json({ ok:true, service:svc });
});

app.get('/services', auth, async (req,res)=>{
  const db = readDb();
  const services = [];
  for (const s of db.services) services.push({ ...s, inspect: await dockerInspect(s.container), stats: await dockerStats(s.container) });
  res.json({ services });
});
app.get('/services/:id', auth, async (req,res)=>{ const s=getService(req.params.id); if(!s)return res.status(404).json({error:'Not found'}); res.json({service:s, inspect:await dockerInspect(s.container), stats:await dockerStats(s.container)}); });
app.post('/services/:id/start', auth, async (req,res)=>{ const s=getService(req.params.id); await sh('docker',['start',s.container]); res.json({ok:true}); });
app.post('/services/:id/stop', auth, async (req,res)=>{ const s=getService(req.params.id); await sh('docker',['stop',s.container]); res.json({ok:true}); });
app.post('/services/:id/restart', auth, async (req,res)=>{ const s=getService(req.params.id); await sh('docker',['restart',s.container]); res.json({ok:true}); });
app.post('/services/:id/delete', auth, async (req,res)=>{ const db=readDb(); const s=db.services.find(x=>x.id===req.params.id); if(!s)return res.status(404).json({error:'Not found'}); await sh('docker',['rm','-f',s.container]).catch(()=>{}); if(req.body.deleteFiles) await fsp.rm(path.dirname(s.dataDir),{recursive:true,force:true}); db.services=db.services.filter(x=>x.id!==s.id); writeDb(db); res.json({ok:true}); });
app.post('/services/:id/factory-reset', auth, async (req,res)=>{ const s=getService(req.params.id); if(!s)return res.status(404).json({error:'Not found'}); await sh('docker',['rm','-f',s.container]).catch(()=>{}); await fsp.rm(s.dataDir,{recursive:true,force:true}); await fsp.mkdir(s.dataDir,{recursive:true}); res.json({ok:true,message:'Data wiped. Recreate this VPS/service from panel plan to start again.'}); });
app.get('/services/:id/logs', auth, async (req,res)=>{ const s=getService(req.params.id); const lines=String(req.query.lines||'300'); const out=await sh('docker',['logs','--tail',lines,s.container]).catch(e=>({stdout:e.stdout||'',stderr:e.stderr||e.message})); res.json({logs:(out.stdout||'')+(out.stderr||'')}); });
app.post('/services/:id/command', auth, async (req,res)=>{ const s=getService(req.params.id); if(!s)return res.status(404).json({error:'Not found'}); const command=String(req.body.command||''); if(!command)return res.status(400).json({error:'Command required'}); let out; if(s.commandMode==='rcon') out=await sh('docker',['exec',s.container,'rcon-cli',command]); else out=await sh('docker',['exec',s.container,'sh','-lc',command]); res.json({ok:true,output:(out.stdout||'')+(out.stderr||'')}); });
app.get('/services/:id/stats', auth, async (req,res)=>{ const s=getService(req.params.id); res.json({stats: await dockerStats(s.container), inspect: await dockerInspect(s.container)}); });

app.get('/services/:id/files', auth, async (req,res)=>{ const s=getService(req.params.id); const p=safePath(s.dataDir, req.query.path||''); const items=[]; for(const e of await fsp.readdir(p,{withFileTypes:true})){ const st=await fsp.stat(path.join(p,e.name)); items.push({name:e.name,path:path.relative(s.dataDir,path.join(p,e.name)).replaceAll('\\','/'),dir:e.isDirectory(),size:st.size,mtime:st.mtime}); } res.json({path:path.relative(s.dataDir,p).replaceAll('\\','/'),items}); });
app.get('/services/:id/files/download', auth, (req,res)=>{ const s=getService(req.params.id); const p=safePath(s.dataDir,req.query.path||''); res.download(p); });
app.post('/services/:id/files/upload', auth, upload.array('files',50), async (req,res)=>{ const s=getService(req.params.id); const dest=safePath(s.dataDir,req.body.path||''); await fsp.mkdir(dest,{recursive:true}); for(const file of req.files||[]) { await fsp.rename(file.path, path.join(dest, file.originalname)); } res.json({ok:true,count:(req.files||[]).length}); });
app.post('/services/:id/files/delete', auth, async (req,res)=>{ const s=getService(req.params.id); const paths=Array.isArray(req.body.paths)?req.body.paths:[req.body.path]; for(const rel of paths.filter(Boolean)) await fsp.rm(safePath(s.dataDir,rel),{recursive:true,force:true}); res.json({ok:true}); });
app.post('/services/:id/files/mkdir', auth, async (req,res)=>{ const s=getService(req.params.id); await fsp.mkdir(safePath(s.dataDir,path.join(req.body.path||'',req.body.name||'new-folder')),{recursive:true}); res.json({ok:true}); });
app.post('/services/:id/files/write', auth, async (req,res)=>{ const s=getService(req.params.id); const target=safePath(s.dataDir,req.body.path||''); await fsp.mkdir(path.dirname(target),{recursive:true}); await fsp.writeFile(target,req.body.content||''); res.json({ok:true}); });

app.get('/services/:id/backups', auth, async (req,res)=>{ const s=getService(req.params.id); await fsp.mkdir(s.backupsDir,{recursive:true}); const files=(await fsp.readdir(s.backupsDir)).filter(f=>f.endsWith('.tar.gz')); res.json({backups:files}); });
app.post('/services/:id/backups', auth, async (req,res)=>{ const s=getService(req.params.id); await fsp.mkdir(s.backupsDir,{recursive:true}); const name=`backup-${new Date().toISOString().replace(/[:.]/g,'-')}.tar.gz`; await sh('tar',['-czf',path.join(s.backupsDir,name),'-C',s.dataDir,'.']); res.json({ok:true,name}); });
app.get('/services/:id/backups/:name', auth, (req,res)=>{ const s=getService(req.params.id); res.download(safePath(s.backupsDir,req.params.name)); });
app.post('/services/:id/backups/:name/restore', auth, async (req,res)=>{ const s=getService(req.params.id); const backup=safePath(s.backupsDir,req.params.name); await sh('docker',['stop',s.container]).catch(()=>{}); await fsp.rm(s.dataDir,{recursive:true,force:true}); await fsp.mkdir(s.dataDir,{recursive:true}); await sh('tar',['-xzf',backup,'-C',s.dataDir]); await sh('docker',['start',s.container]).catch(()=>{}); res.json({ok:true}); });
app.post('/services/:id/backups/:name/delete', auth, async (req,res)=>{ const s=getService(req.params.id); await fsp.rm(safePath(s.backupsDir,req.params.name),{force:true}); res.json({ok:true}); });

app.get('/services/:id/saves/world/download', auth, (req,res)=>{ const s=getService(req.params.id); const world=req.query.world||'world'; res.download(safePath(s.dataDir,world)); });
app.post('/services/:id/saves/world/upload', auth, upload.single('world'), async (req,res)=>{ const s=getService(req.params.id); const name=safeName(req.body.worldName||'world'); const target=safePath(s.dataDir,name); await fsp.rm(target,{recursive:true,force:true}); await fsp.mkdir(target,{recursive:true}); await sh('tar',['-xzf',req.file.path,'-C',target]).catch(async()=>{ await fsp.rename(req.file.path,path.join(s.dataDir,req.file.originalname)); }); res.json({ok:true}); });

app.listen(PORT,()=>console.log(`Outback node agent on ${PORT}, services root ${ROOT}`));

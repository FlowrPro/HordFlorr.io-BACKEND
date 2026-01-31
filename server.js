// Minimal authoritative game server for Moborr.io (guest-only join, mobs and world simulation).
// Run: node server.js
// Environment:
//  - PORT (optional)
//
// NOTE: This server intentionally contains no registration/signup/auth code — it accepts guest joins only.

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// --- World / tick ---
const MAP_HALF = 6000;
const MAP_SIZE = MAP_HALF * 2;
const MAP_TYPE = 'square';
const TICK_RATE = 20;
const TICK_DT = 1 / TICK_RATE;

const CHAT_MAX_PER_WINDOW = 2;
const CHAT_WINDOW_MS = 1000;

const WALL_THICKNESS = 448;
const SPAWN_MARGIN = 300;

let nextPlayerId = 1;
const players = new Map();
let nextMobId = 1;
const mobs = new Map();

// --- Map walls (12x12 grid scaled) ---
// Keep the box/row helpers so it's easy to author map pieces in cell coordinates.
const CELL = MAP_SIZE / 12;
const GAP = 40;
function h(col, row, lenCells, id) { return { id: id || `h_${col}_${row}_${lenCells}`, x: -MAP_HALF + (col - 1) * CELL + GAP, y: -MAP_HALF + (row - 1) * CELL + GAP, w: Math.max(1, lenCells) * CELL - GAP * 2, h: WALL_THICKNESS }; }
function v(col, row, lenCells, id) { return { id: id || `v_${col}_${row}_${lenCells}`, x: -MAP_HALF + (col - 1) * CELL + GAP, y: -MAP_HALF + (row - 1) * CELL + GAP, w: WALL_THICKNESS, h: Math.max(1, lenCells) * CELL - GAP * 2 }; }
function box(col, row, wCells, hCells, id) { return { id: id || `box_${col}_${row}_${wCells}x${hCells}`, x: -MAP_HALF + (col - 1) * CELL + GAP, y: -MAP_HALF + (row - 1) * CELL + GAP, w: Math.max(1, wCells) * CELL - GAP * 2, h: Math.max(1, hCells) * CELL - GAP * 2 }; }

// --- Open Plains with Scattered Cover ---
// Replaced the previous complex walls with a light-scatter cover layout (map idea #10).
// This creates mostly open area with small cover obstacles spread around the map.
const walls = [
  // small isolated rocks / cover
  box(2, 3, 1, 1, 'rock_1'),
  box(4, 6, 1, 1, 'rock_2'),
  box(6, 9, 1, 1, 'rock_3'),
  box(9, 4, 1, 1, 'rock_4'),
  box(11, 8, 1, 1, 'rock_5'),

  // slightly larger cover patches
  box(3, 10, 2, 1, 'cover_6'),
  box(7, 2, 1, 2, 'cover_7'),
  box(5, 5, 2, 2, 'cover_center_small'),
  box(10, 10, 1, 1, 'rock_8'),
  box(8, 7, 1, 1, 'rock_9'),

  // some long low cover strips (small buildings / hedges)
  box(2, 8, 1, 2, 'cover_10'),
  box(6, 4, 2, 1, 'cover_11')
];

// --- Mob definitions and spawn points ---
const mobDefs = {
  goblin: { name: 'Goblin', maxHp: 120, atk: 14, speed: 140, xp: 12, goldMin: 6, goldMax: 14, respawn: 12, radius: 22 },
  wolf:   { name: 'Wolf',   maxHp: 180, atk: 20, speed: 170, xp: 20, goldMin: 12, goldMax: 20, respawn: 18, radius: 26 },
  slime:  { name: 'Slime',  maxHp: 80,  atk: 8,  speed: 100, xp: 6,  goldMin: 2,  goldMax: 6,  respawn: 10, radius: 18 }
};

const mobSpawnPoints = [
  { x: -MAP_HALF + CELL * 2 + CELL/2, y: -MAP_HALF + CELL*2 + CELL/2, types: ['goblin','slime'] },
  { x: -MAP_HALF + CELL * 6 + CELL/2, y: -MAP_HALF + CELL*6 + CELL/2, types: ['wolf','goblin'] },
  { x: -MAP_HALF + CELL * 10 + CELL/2, y: -MAP_HALF + CELL*3 + CELL/2, types: ['goblin','slime'] },
  { x: -MAP_HALF + CELL * 3 + CELL/2, y: -MAP_HALF + CELL*9 + CELL/2, types: ['slime','goblin'] },
  { x: -MAP_HALF + CELL * 9 + CELL/2, y: -MAP_HALF + CELL*8 + CELL/2, types: ['wolf','goblin'] },
];

function spawnMobAt(sp, typeName) {
  const def = mobDefs[typeName]; if (!def) return null;
  const jitter = 80;
  const x = sp.x + (Math.random() * jitter * 2 - jitter);
  const y = sp.y + (Math.random() * jitter * 2 - jitter);
  const id = 'mob_' + (nextMobId++);
  const m = { id, type: typeName, x, y, vx:0, vy:0, hp:def.maxHp, maxHp:def.maxHp, radius:def.radius, aggroRadius:650, damageContrib: {}, spawnPoint: sp, def, respawnAt: null };
  mobs.set(id, m); return m;
}
for (const sp of mobSpawnPoints) for (let i=0;i<3;i++) spawnMobAt(sp, sp.types[Math.floor(Math.random()*sp.types.length)]);

// --- Utilities ---
function nowMs(){ return Date.now(); }
function randRange(min,max){ return Math.random()*(max-min)+min; }

// Spawn position
function spawnPosition() { return { x: -MAP_HALF + SPAWN_MARGIN, y: MAP_HALF - SPAWN_MARGIN }; }

// Create runtime player. If fixedId is provided, use that as player's id.
function createPlayerRuntime(ws, opts = {}) {
  const fixedId = opts.id || null;
  const id = fixedId ? String(fixedId) : String(nextPlayerId++);
  const pos = spawnPosition();
  const color = `hsl(${Math.floor(Math.random()*360)},70%,60%)`;
  const p = {
    id, name: opts.name || ('Player' + id),
    x: pos.x, y: pos.y, vx:0, vy:0, radius:28, color,
    ws, lastInput: { x:0, y:0 }, lastSeen: nowMs(), chatTimestamps: [],
    maxHp: 200, hp: 200, xp: 0, gold: 0,
    lastAttackTime: 0, attackCooldown: 0.6, baseDamage: 18, invulnerableUntil: 0
  };
  players.set(String(p.id), p);
  return p;
}

// --- HTTP server (status + nothing else) ---
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Moborr.io server running\n'); return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocket.Server({ server });

// Broadcast helper
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      try { p.ws.send(msg); } catch (e) {}
    }
  }
}

// Damage mob helper
function damageMob(mob, amount, playerId) {
  if (!mob || mob.hp <= 0) return;
  mob.hp -= amount;
  if (playerId) { mob.damageContrib[playerId] = (mob.damageContrib[playerId] || 0) + amount; }
  if (mob.hp <= 0) handleMobDeath(mob);
}
function handleMobDeath(mob) {
  let topId = null, topDmg = 0;
  for (const pid in mob.damageContrib) {
    const d = mob.damageContrib[pid];
    if (d > topDmg) { topDmg = d; topId = pid; }
  }
  const def = mob.def;
  const gold = Math.round(randRange(def.goldMin, def.goldMax));
  const xp = def.xp;
  if (topId && players.has(String(topId))) {
    const killer = players.get(String(topId));
    killer.gold = Number(killer.gold||0) + gold;
    killer.xp = Number(killer.xp||0) + xp;
    broadcast({ t:'mob_died', mobId: mob.id, mobType: mob.type, killerId: killer.id, gold, xp });
  } else {
    broadcast({ t:'mob_died', mobId: mob.id, mobType: mob.type, killerId: null, gold:0, xp:0 });
  }
  mob.respawnAt = nowMs() + mob.def.respawn * 1000;
  mob.hp = 0; mob.damageContrib = {};
}

// Collision push (server)
function resolveCircleAABB(p, rect) {
  const rx1 = rect.x, ry1 = rect.y, rx2 = rect.x + rect.w, ry2 = rect.y + rect.h;
  const closestX = Math.max(rx1, Math.min(p.x, rx2)); const closestY = Math.max(ry1, Math.min(p.y, ry2));
  let dx = p.x - closestX, dy = p.y - closestY; const distSq = dx*dx + dy*dy;
  if (distSq === 0) {
    const leftDist = Math.abs(p.x - rx1), rightDist = Math.abs(rx2 - p.x), topDist = Math.abs(p.y - ry1), bottomDist = Math.abs(ry2 - p.y);
    const minHoriz = Math.min(leftDist, rightDist), minVert = Math.min(topDist, bottomDist);
    if (minHoriz < minVert) { if (leftDist < rightDist) p.x = rx1 - p.radius - 0.1; else p.x = rx2 + p.radius + 0.1; } else { if (topDist < bottomDist) p.y = ry1 - p.radius - 0.1; else p.y = ry2 + p.radius + 0.1; }
    p.vx = 0; p.vy = 0; return;
  }
  const dist = Math.sqrt(distSq); const overlap = p.radius - dist;
  if (overlap > 0) { dx /= dist; dy /= dist; p.x += dx * overlap; p.y += dy * overlap; const vn = p.vx * dx + p.vy * dy; if (vn > 0) { p.vx -= vn * dx; p.vy -= vn * dy; } }
}

function handlePlayerDeath(player, killer) {
  const killerIsPlayer = killer && killer.id && players.has(String(killer.id));
  if (killerIsPlayer) {
    const victim = player; const killerP = players.get(String(killer.id));
    const stolen = Math.floor((victim.gold || 0) * 0.05);
    if (stolen > 0) {
      victim.gold = Math.max(0, (victim.gold||0) - stolen);
      killerP.gold = Number(killerP.gold||0) + stolen;
    }
  }
  player.hp = 0;
}

// Server tick: mobs/player updates & snapshots
function serverTick() {
  const now = nowMs();
  // respawn mobs
  for (const [id,m] of mobs.entries()) {
    if (m.hp <= 0 && m.respawnAt && now >= m.respawnAt) {
      mobs.delete(id); const sp = m.spawnPoint; spawnMobAt(sp, m.type);
    }
  }

  // update mobs
  for (const m of mobs.values()) {
    let target = null, bestD = Infinity;
    for (const p of players.values()) { if (p.hp <= 0) continue; const d = Math.hypot(m.x - p.x, m.y - p.y); if (d < m.aggroRadius && d < bestD) { bestD = d; target = p; } }
    if (target) {
      const dx = target.x - m.x, dy = target.y - m.y, len = Math.hypot(dx,dy)||1;
      const spd = m.def.speed; m.vx = (dx/len)*spd; m.vy = (dy/len)*spd; m.x += m.vx * TICK_DT; m.y += m.vy * TICK_DT;
      const minDist = m.radius + target.radius + 6;
      if (Math.hypot(m.x - target.x, m.y - target.y) <= minDist) {
        const dmg = m.def.atk * TICK_DT * 0.8;
        if (now >= (target.invulnerableUntil || 0)) { target.hp -= dmg; if (target.hp <= 0) handlePlayerDeath(target, m); }
      }
    } else { m.vx *= 0.9; m.vy *= 0.9; m.x += m.vx * TICK_DT; m.y += m.vy * TICK_DT; }
  }

  // update players
  for (const p of players.values()) {
    const inVec = p.lastInput || { x:0, y:0 }; const speed = 380; const vx = inVec.x * speed, vy = inVec.y * speed;
    p.x += vx * TICK_DT; p.y += vy * TICK_DT; p.vx = vx; p.vy = vy;
    const limit = MAP_HALF - p.radius - 1;
    if (p.x > limit) p.x = limit; if (p.x < -limit) p.x = -limit; if (p.y > limit) p.y = limit; if (p.y < -limit) p.y = -limit;
    for (const w of walls) resolveCircleAABB(p, w);
    const nowSec = Date.now()/1000;
    if (p.hp > 0) {
      for (const m of mobs.values()) {
        if (m.hp <= 0) continue;
        const d = Math.hypot(m.x - p.x, m.y - p.y); const range = p.radius + m.radius + 8;
        if (d <= range) {
          if (nowSec - (p.lastAttackTime || 0) >= p.attackCooldown) { p.lastAttackTime = nowSec; const dmg = p.baseDamage; damageMob(m, dmg, p.id); }
        }
      }
    } else {
      const pos = spawnPosition(); p.x = pos.x; p.y = pos.y; p.hp = p.maxHp; p.invulnerableUntil = now + 3000;
    }
    p.lastSeen = now;
  }

  // broadcast snapshot
  const playerList = Array.from(players.values()).map(p => ({ id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), radius: p.radius, color: p.color, hp: Math.round(p.hp), maxHp: Math.round(p.maxHp) }));
  const mobList = Array.from(mobs.values()).map(m => ({ id: m.id, type: m.type, x: Math.round(m.x), y: Math.round(m.y), hp: Math.round(m.hp), maxHp: Math.round(m.maxHp), radius: m.radius }));
  broadcast({ t:'snapshot', tick: nowMs(), players: playerList, mobs: mobList });
}

setInterval(serverTick, Math.round(1000 / TICK_RATE));

// --- WebSocket handling (guest join only) ---
wss.on('connection', (ws, req) => {
  console.log('connection from', req.socket.remoteAddress);
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.authenticated = false;
  ws.playerId = null;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (!msg || !msg.t) return;

      if (!ws.authenticated) {
        // Only accept guest join flow - create runtime player with numeric id
        if (msg.t === 'join') {
          const name = (msg.name && String(msg.name).slice(0,24)) || ('Player' + (nextPlayerId++));
          const p = createPlayerRuntime(ws, { name });
          ws.authenticated = true; ws.playerId = p.id;
          ws.send(JSON.stringify({ t:'welcome', id: p.id, mapHalf: MAP_HALF, mapSize: MAP_SIZE, mapType: MAP_TYPE, mapRadius: MAP_HALF, tickRate: TICK_RATE, spawnX: p.x, spawnY: p.y, walls }));
          return;
        } else {
          try { ws.send(JSON.stringify({ t: 'need_join' })); } catch (e) {}
          return;
        }
      }

      // Authenticated: handle gameplay messages
      const player = players.get(String(ws.playerId));
      if (!player) return;

      if (msg.t === 'input') {
        const input = msg.input;
        if (input && typeof input.x === 'number' && typeof input.y === 'number') {
          let x = Number(input.x), y = Number(input.y);
          if (!isFinite(x) || !isFinite(y)) { player.lastInput = { x:0, y:0 }; return; }
          x = Math.max(-1, Math.min(1, x)); y = Math.max(-1, Math.min(1, y));
          const len = Math.hypot(x,y);
          if (len > 1e-6) { const inv = 1 / Math.max(len,1); player.lastInput = { x: x*inv, y: y*inv }; } else { player.lastInput = { x:0, y:0 }; }
        }
      } else if (msg.t === 'chat') {
        const now = Date.now();
        player.chatTimestamps = (player.chatTimestamps || []).filter(ts => now - ts < CHAT_WINDOW_MS);
        if (player.chatTimestamps.length >= CHAT_MAX_PER_WINDOW) { try { ws.send(JSON.stringify({ t:'chat_blocked', reason:'rate_limit', ts: now })); } catch(e){} return; }
        player.chatTimestamps.push(now);
        let text = String(msg.text||''); text = text.replace(/[\r\n]+/g,' ').slice(0,240);
        broadcast({ t: 'chat', name: player.name, text, ts: now, chatId: msg.chatId || null });
      } else if (msg.t === 'ping') {
        try { ws.send(JSON.stringify({ t: 'pong', ts: msg.ts || Date.now() })); } catch(e){}
      }
    } catch (err) {
      // ignore malformed
    }
  });

  ws.on('close', () => {
    if (ws.playerId) {
      console.log('disconnect', ws.playerId);
      players.delete(String(ws.playerId));
    }
  });

  ws.on('error', (err) => {
    if (ws.playerId) players.delete(String(ws.playerId));
  });
});

// Start listening
server.listen(PORT, () => { console.log(`Moborr server listening on port ${PORT}`); });

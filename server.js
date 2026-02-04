// Moborr.io — authoritative WebSocket server with polygon-based maze walls,
// bottom-left fixed spawn, and full ability/projectile handling.
//
// Run: node server.js
// Environment:
//  - PORT (optional)

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// --- World / tick ---
const MAP_HALF = 9000; // half-size map
const MAP_SIZE = MAP_HALF * 2;
const MAP_TYPE = 'square';
const TICK_RATE = 20;
const TICK_DT = 1 / TICK_RATE;

const CHAT_MAX_PER_WINDOW = 2;
const CHAT_WINDOW_MS = 1000;

const WALL_THICKNESS = 672;
const SPAWN_MARGIN = 450;

let nextPlayerId = 1;
const players = new Map();
let nextMobId = 1;
const mobs = new Map();

// --- Projectiles ---
const projectiles = new Map();
let nextProjId = 1;

// --- Map helpers (grid & polygon generation) ---
const CELL = MAP_SIZE / 12;
const GAP = Math.floor(Math.max(24, CELL * 0.05));

// Helper to get center of grid cell
function gridToWorldCenter(col, row) {
  const x = -MAP_HALF + (col - 0.5) * CELL;
  const y = -MAP_HALF + (row - 0.5) * CELL;
  return { x, y };
}

// Normalize vector
function normalize(vx, vy) {
  const len = Math.hypot(vx, vy) || 1;
  return { x: vx / len, y: vy / len };
}

// A centerline path that roughly follows the reference maze (12x12 cells).
// You can edit this path to tweak the exact maze winding.
const centerlineGrid = [
  [2,1],[2,3],[4,3],[4,1],[6,1],[6,3],[8,3],[8,1],[10,1],
  [10,3],[10,5],[8,5],[8,7],[6,7],[6,5],[4,5],[4,7],[2,7],
  [2,9],[4,9],[4,11],[6,11],[6,9],[8,9],[8,11],[10,11]
];
const centerline = centerlineGrid.map(([c,r]) => gridToWorldCenter(c, r));

// Convert polyline -> thick polygon by offsetting normals
function polylineToThickPolygon(points, thickness) {
  if (!points || points.length < 2) return [];
  const half = thickness / 2;
  const left = [];
  const right = [];
  const normals = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i+1];
    const dir = normalize(b.x - a.x, b.y - a.y);
    normals.push({ x: -dir.y, y: dir.x });
  }
  for (let i = 0; i < points.length; i++) {
    let n = { x: 0, y: 0 };
    if (i === 0) n = normals[0] || { x: 0, y: 1 };
    else if (i === points.length - 1) n = normals[normals.length - 1] || { x: 0, y: 1 };
    else {
      n.x = (normals[i-1] ? normals[i-1].x : 0) + (normals[i] ? normals[i].x : 0);
      n.y = (normals[i-1] ? normals[i-1].y : 0) + (normals[i] ? normals[i].y : 0);
      const nl = Math.hypot(n.x, n.y);
      if (nl < 1e-4) n = normals[i] || { x: 0, y: 1 };
      else { n.x /= nl; n.y /= nl; }
    }
    left.push({ x: points[i].x + n.x * half, y: points[i].y + n.y * half });
    right.push({ x: points[i].x - n.x * half, y: points[i].y - n.y * half });
  }
  const polygon = [];
  for (const p of left) polygon.push({ x: Math.round(p.x), y: Math.round(p.y) });
  for (let i = right.length - 1; i >= 0; i--) polygon.push({ x: Math.round(right[i].x), y: Math.round(right[i].y) });
  return polygon.length >= 3 ? polygon : [];
}

// Build polygon wall from centerline; fallback to rectangular boxes if polygon invalid
let walls = [];
try {
  const WALL_THICKNESS_WORLD = Math.max(Math.floor(CELL * 0.9), WALL_THICKNESS * 0.8);
  const polyPts = polylineToThickPolygon(centerline, WALL_THICKNESS_WORLD);
  if (Array.isArray(polyPts) && polyPts.length >= 3) {
    walls = [{ id: 'maze_wall_poly_1', points: polyPts }];
  } else {
    // fallback rectangular walls (keeps shape if poly generation fails)
    throw new Error('poly generation produced insufficient points');
  }
} catch (err) {
  // Fallback rectangular layout (keeps the map playable)
  const h = (col, row, lenCells, id) => ({ id: id || `h_${col}_${row}_${lenCells}`, x: -MAP_HALF + (col - 1) * CELL + GAP, y: -MAP_HALF + (row - 1) * CELL + GAP, w: Math.max(1, lenCells) * CELL - GAP * 2, h: WALL_THICKNESS });
  const v = (col, row, lenCells, id) => ({ id: id || `v_${col}_${row}_${lenCells}`, x: -MAP_HALF + (col - 1) * CELL + GAP, y: -MAP_HALF + (row - 1) * CELL + GAP, w: WALL_THICKNESS, h: Math.max(1, lenCells) * CELL - GAP * 2 });
  const box = (col, row, wCells, hCells, id) => ({ id: id || `box_${col}_${row}_${wCells}x${hCells}`, x: -MAP_HALF + (col - 1) * CELL + GAP, y: -MAP_HALF + (row - 1) * CELL + GAP, w: Math.max(1, wCells) * CELL - GAP * 2, h: Math.max(1, hCells) * CELL - GAP * 2 });
  walls = [
    box(1, 1, 12, 1, 'outer_top'),
    box(1, 12, 12, 1, 'outer_bottom'),
    box(1, 1, 1, 12, 'outer_left'),
    box(12, 1, 1, 12, 'outer_right'),
    box(2, 2, 1, 3, 'v_left_1'),
    box(2, 6, 1, 3, 'v_left_2'),
    box(2, 10, 1, 2, 'v_left_3'),
    box(3, 2, 4, 1, 'h_top_spiral'),
    box(6, 3, 1, 3, 'v_spiral_center'),
    box(4, 5, 4, 1, 'h_mid_spiral'),
    box(6, 1, 1, 12, 'center_bar_full'),
    box(8, 2, 1, 2, 'v_right_1'),
    box(10, 2, 1, 2, 'v_right_2'),
    box(9, 4, 3, 1, 'h_right_mid_1'),
    box(8, 6, 1, 3, 'v_right_mid_2'),
    box(10, 9, 1, 2, 'v_right_bottom'),
    box(3, 8, 2, 1, 'box_lower_left_1'),
    box(2, 9, 1, 2, 'v_lower_left'),
    box(4, 10, 3, 1, 'h_lower_left'),
    box(7, 9, 2, 1, 'box_lower_center'),
    box(9, 10, 2, 1, 'box_lower_right'),
    box(11, 8, 1, 2, 'v_lower_right'),
    box(4, 3, 1, 1, 'island_a'),
    box(5, 6, 1, 1, 'island_b'),
    box(8, 4, 1, 1, 'island_c'),
    box(7, 7, 1, 1, 'island_d'),
    box(3, 7, 4, 1, 'h_middle_left'),
    box(5, 4, 1, 2, 'v_inner_left_connector'),
    box(9, 5, 1, 2, 'v_inner_right_connector'),
    box(5, 11, 2, 1, 'h_near_bottom_center'),
    box(10, 11, 1, 1, 'h_near_bottom_right'),
    box(6, 4, 1, 1, 'block_center_1'),
    box(8, 8, 1, 1, 'block_center_2'),
    box(3, 10, 1, 1, 'block_ll'),
    box(11, 3, 1, 1, 'block_ur'),
    box(7, 3, 1, 1, 'block_mid_top')
  ];
}

// --- Mob defs & spawn points ---
const mobDefs = {
  goblin: { name: 'Goblin', maxHp: 120, atk: 14, speed: 140, xp: 12, goldMin: 6, goldMax: 14, respawn: 12, radius: 22 },
  wolf:   { name: 'Wolf',   maxHp: 180, atk: 20, speed: 170, xp: 20, goldMin: 12, goldMax: 20, respawn: 18, radius: 26 },
  slime:  { name: 'Slime',  maxHp: 80,  atk: 8,  speed: 100, xp: 6,  goldMin: 2,  goldMax: 6,  respawn: 10, radius: 18 },
  boar:   { name: 'Boar',   maxHp: 150, atk: 18, speed: 150, xp: 16, goldMin: 8, goldMax: 16, respawn: 14, radius: 24 }
};

const mobSpawnPoints = [
  { x: -MAP_HALF + CELL * 2 + CELL/2, y: -MAP_HALF + CELL*2 + CELL/2, types: ['goblin','slime','boar'] },
  { x: -MAP_HALF + CELL * 6 + CELL/2, y: -MAP_HALF + CELL*6 + CELL/2, types: ['wolf','goblin','boar'] },
  { x: -MAP_HALF + CELL * 10 + CELL/2, y: -MAP_HALF + CELL*3 + CELL/2, types: ['goblin','slime','boar'] },
  { x: -MAP_HALF + CELL * 3 + CELL/2, y: -MAP_HALF + CELL*9 + CELL/2, types: ['slime','goblin','boar'] },
  { x: -MAP_HALF + CELL * 9 + CELL/2, y: -MAP_HALF + CELL*8 + CELL/2, types: ['wolf','goblin','boar'] },
  { x: -MAP_HALF + CELL * 5 + CELL/2, y: -MAP_HALF + CELL*2 + CELL/2, types: ['slime','goblin'] },
  { x: -MAP_HALF + CELL * 2 + CELL/2, y: -MAP_HALF + CELL*8 + CELL/2, types: ['goblin','wolf'] }
];

function pointInsideWall(x, y, margin = 6) {
  for (const w of walls) {
    if (w.points && Array.isArray(w.points)) {
      // point-in-polygon (ray casting)
      let inside = false;
      const poly = w.points;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 0.0) + xi);
        if (intersect) inside = !inside;
      }
      if (inside) return true;
    } else if (typeof w.x === 'number' && typeof w.w === 'number') {
      if (x >= w.x - margin && x <= w.x + w.w + margin && y >= w.y - margin && y <= w.y + w.h + margin) return true;
    }
  }
  return false;
}

function spawnMobAt(sp, typeName) {
  const def = mobDefs[typeName]; if (!def) return null;
  const jitter = 120 * 3;
  const maxAttempts = 12;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = sp.x + (Math.random() * jitter * 2 - jitter);
    const y = sp.y + (Math.random() * jitter * 2 - jitter);
    const limit = MAP_HALF - (def.radius || 18) - 12;
    if (x < -limit || x > limit || y < -limit || y > limit) continue;
    if (pointInsideWall(x, y, 8)) continue;
    const id = 'mob_' + (nextMobId++);
    const m = { id, type: typeName, x, y, vx:0, vy:0, hp:def.maxHp, maxHp:def.maxHp, radius:def.radius, aggroRadius:650, damageContrib: {}, spawnPoint: sp, def, respawnAt: null, dead: false, stunnedUntil: 0 };
    mobs.set(id, m); return m;
  }
  // fallback
  let fallbackX = sp.x, fallbackY = sp.y;
  let step = 0;
  while (pointInsideWall(fallbackX, fallbackY, 8) && step < 8) {
    fallbackX += (step % 2 === 0 ? 1 : -1) * (def.radius + 20) * (step + 1);
    fallbackY += (step % 3 === 0 ? -1 : 1) * (def.radius + 20) * (step + 1);
    step++;
  }
  const id = 'mob_' + (nextMobId++);
  const m = { id, type: typeName, x: fallbackX, y: fallbackY, vx:0, vy:0, hp:def.maxHp, maxHp:def.maxHp, radius:def.radius, aggroRadius:650, damageContrib: {}, spawnPoint: sp, def, respawnAt: null, dead: false, stunnedUntil: 0 };
  mobs.set(id, m); return m;
}

// spawn initial mobs
for (const sp of mobSpawnPoints) {
  const count = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const t = sp.types[Math.floor(Math.random() * sp.types.length)];
    spawnMobAt(sp, t);
  }
}

// --- Skills / cooldowns ---
const SKILL_DEFS = {
  warrior: [
    { kind: 'melee', damage: 60, range: 48, ttl: 0, type: 'slash' },
    { kind: 'aoe_stun', damage: 40, radius: 48, ttl: 0, type: 'shieldbash', stunMs: 3000 },
    { kind: 'aoe', damage: 10, radius: 80, ttl: 0, type: 'charge', buff: { type: 'speed', multiplier: 1.5, durationMs: 5000 } },
    { kind: 'buff', damage: 0, radius: 0, ttl: 0, type: 'rage', buff: { type: 'damage', multiplier: 1.15, durationMs: 10000 } }
  ],
  ranger: [
    { kind: 'proj_target', damage: 40, speed: 680, radius: 6, ttlMs: 3000, type: 'arrow' },
    { kind: 'proj_burst', damage: 20, speed: 720, radius: 5, ttlMs: 2500, type: 'rapid', count: 5, spreadDeg: 12 },
    { kind: 'proj_target_stun', damage: 12, speed: 380, radius: 8, ttlMs: 1600, type: 'trap', stunMs: 3000 },
    { kind: 'proj_target', damage: 120, speed: 880, radius: 7, ttlMs: 3500, type: 'snipe' }
  ],
  mage: [
    { kind: 'proj_target', damage: 45, speed: 420, radius: 10, ttlMs: 3000, type: 'spark' },
    { kind: 'proj_target', damage: 135, speed: 360, radius: 10, ttlMs: 3000, type: 'fireball' },
    { kind: 'proj_target_stun', damage: 60, speed: 0, radius: 0, ttlMs: 0, type: 'frostnova', stunMs: 3000 },
    { kind: 'proj_aoe_spread', damage: 45, speed: 520, radius: 12, ttlMs: 3200, type: 'arcane', count: 6, spreadDeg: 45 }
  ]
};
const CLASS_COOLDOWNS_MS = {
  warrior: [3500,7000,10000,25000],
  ranger:  [2000,25000,12000,4000],
  mage:    [2500,5000,25000,10000]
};

// --- Utilities ---
function nowMs(){ return Date.now(); }
function randRange(min,max){ return Math.random()*(max-min)+min; }

// bottom-left fixed spawn
function bottomLeftSpawn() {
  const x = -MAP_HALF + CELL * 1.5;
  const y = MAP_HALF - CELL * 1.5;
  return { x, y };
}

// create player runtime (spawn bottom-left)
function createPlayerRuntime(ws, opts = {}) {
  const fixedId = opts.id || null;
  const id = fixedId ? String(fixedId) : String(nextPlayerId++);
  const pos = bottomLeftSpawn();
  const color = `hsl(${Math.floor(Math.random()*360)},70%,60%)`;
  const p = {
    id, name: opts.name || ('Player' + id),
    x: pos.x, y: pos.y, vx:0, vy:0, radius:28, color,
    ws, lastInput: { x:0, y:0 }, lastSeen: nowMs(), chatTimestamps: [],
    maxHp: 200, hp: 200, xp: 0, gold: 0,
    lastAttackTime: 0, attackCooldown: 0.6, baseDamage: 18, invulnerableUntil: 0,
    class: opts.class || 'warrior',
    cooldowns: {},
    baseSpeed: 380,
    buffs: [],
    stunnedUntil: 0
  };
  players.set(String(p.id), p);
  return p;
}

// --- HTTP server ---
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Moborr.io server running\n'); return;
  }
  if (req.method === 'GET' && req.url === '/walls') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(walls)); return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocket.Server({ server });
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : null;

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      try { p.ws.send(msg); } catch (e) {}
    }
  }
}

// damage & death helpers (unchanged)
function damageMob(mob, amount, playerId) {
  if (!mob) return;
  if (typeof mob.hp !== 'number') mob.hp = Number(mob.hp) || 0;
  if (mob.hp <= 0) return;
  mob.hp -= amount;
  if (playerId) { mob.damageContrib[playerId] = (mob.damageContrib[playerId] || 0) + amount; }

  // Broadcast mob_hurt for damage numbers and immediate UI feedback
  try {
    broadcast({ t: 'mob_hurt', mobId: mob.id, hp: Math.max(0, Math.round(mob.hp)), damage: Math.round(amount), sourceId: playerId || null });
  } catch (e) {}

  if (mob.hp <= 0) { if (!mob.respawnAt) handleMobDeath(mob, playerId); }
}
function handleMobDeath(mob, killerId = null) {
  if (!mob) return;
  if (mob.respawnAt) return;
  let topId = killerId || null;
  let topDmg = 0;
  for (const pid in mob.damageContrib) {
    const d = mob.damageContrib[pid];
    if (d > topDmg) { topDmg = d; topId = pid; }
  }
  const def = mob.def;
  const gold = Math.round(randRange(def.goldMin, def.goldMax));
  const xp = def.xp || 0;
  if (topId && players.has(String(topId))) {
    const killer = players.get(String(topId));
    killer.gold = Number(killer.gold||0) + gold;
    killer.xp = Number(killer.xp||0) + xp;
    broadcast({ t:'mob_died', mobId: mob.id, mobType: mob.type, killerId: killer.id, gold, xp });
  } else {
    broadcast({ t:'mob_died', mobId: mob.id, mobType: mob.type, killerId: null, gold:0, xp:0 });
  }
  mob.respawnAt = nowMs() + (mob.def.respawn || 10) * 1000;
  mob.hp = 0; mob.dead = true; mob.damageContrib = {};
}

function applyDamageToPlayer(targetPlayer, amount, attackerId) {
  if (!targetPlayer || targetPlayer.hp <= 0) return;
  targetPlayer.hp -= amount;
  if (targetPlayer.hp <= 0) {
    handlePlayerDeath(targetPlayer, attackerId ? { id: attackerId } : null);
    broadcast({ t: 'player_died', id: targetPlayer.id, killerId: attackerId || null });
  } else {
    broadcast({ t: 'player_hurt', id: targetPlayer.id, hp: Math.round(targetPlayer.hp), source: attackerId || null, damage: Math.round(amount) });
  }
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

// collision AABB
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

// --- Server tick ---
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
    if (m.hp <= 0) continue;
    if (m.stunnedUntil && now < m.stunnedUntil) {
      m.vx *= 0.8; m.vy *= 0.8; continue;
    }
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
    const nowMsVal = nowMs();
    p.buffs = (p.buffs || []).filter(b => b.until > nowMsVal);
    let speedMultiplier = 1.0; let damageMultiplier = 1.0;
    for (const b of p.buffs) { speedMultiplier *= (b.multiplier || 1.0); if (b.type === 'damage') damageMultiplier *= (b.multiplier || 1.0); }

    if (p.stunnedUntil && nowMsVal < p.stunnedUntil) { p.vx = 0; p.vy = 0; p.lastSeen = now; continue; }

    const inVec = p.lastInput || { x:0, y:0 }; const speed = (p.baseSpeed || 380) * speedMultiplier; const vx = inVec.x * speed, vy = inVec.y * speed;
    p.x += vx * TICK_DT; p.y += vy * TICK_DT; p.vx = vx; p.vy = vy;
    const limit = MAP_HALF - p.radius - 1;
    if (p.x > limit) p.x = limit; if (p.x < -limit) p.x = -limit; if (p.y > limit) p.y = limit; if (p.y < -limit) p.y = -limit;
    for (const w of walls) {
      if (w.points && Array.isArray(w.points)) {
        // resolve circle vs polygon (simple push using edge distances)
        // reuse pointToSegment distance logic and push outward if overlapping edges -> simple implementation
        // (This is a non-perfect resolution, but sufficient for preventing players entering polygon area.)
        let minOverlap = Infinity, push = null;
        for (let i = 0; i < w.points.length; i++) {
          const a = w.points[i];
          const b = w.points[(i+1) % w.points.length];
          const vx = b.x - a.x, vy = b.y - a.y;
          const wx = p.x - a.x, wy = p.y - a.y;
          const dv = vx*vx + vy*vy;
          let t = dv > 0 ? (wx*vx + wy*vy)/dv : 0;
          t = Math.max(0, Math.min(1, t));
          const cx = a.x + vx * t, cy = a.y + vy * t;
          const dx = p.x - cx, dy = p.y - cy;
          const d = Math.hypot(dx, dy);
          const overlap = p.radius - d;
          if (overlap > 0 && overlap < minOverlap) {
            minOverlap = overlap;
            // compute normal
            let nx = -vy, ny = vx; const nlen = Math.hypot(nx, ny) || 1; nx /= nlen; ny /= nlen;
            // determine correct normal sign by sampling
            const sampleX = cx + nx * 2, sampleY = cy + ny * 2;
            // simple winding test
            let inside = false;
            for (let ii = 0, jj = w.points.length - 1; ii < w.points.length; jj = ii++) {
              const xi = w.points[ii].x, yi = w.points[ii].y;
              const xj = w.points[jj].x, yj = w.points[jj].y;
              const inter = ((yi > sampleY) !== (yj > sampleY)) && (sampleX < (xj - xi) * (sampleY - yi) / (yj - yi + 0.0) + xi);
              if (inter) inside = !inside;
            }
            if (inside) { nx = -nx; ny = -ny; }
            push = { nx, ny, overlap: minOverlap };
          }
        }
        if (push) {
          p.x += push.nx * push.overlap;
          p.y += push.ny * push.overlap;
          const vn = p.vx * push.nx + p.vy * push.ny;
          if (vn > 0) { p.vx -= vn * push.nx; p.vy -= vn * push.ny; }
        }
      } else {
        resolveCircleAABB(p, w);
      }
    }

    const nowSec = Date.now()/1000;
    if (p.hp > 0) {
      for (const m of mobs.values()) {
        if (m.hp <= 0) continue;
        const d = Math.hypot(m.x - p.x, m.y - p.y); const range = p.radius + m.radius + 8;
        if (d <= range) {
          if (nowSec - (p.lastAttackTime || 0) >= p.attackCooldown) { p.lastAttackTime = nowSec; const dmg = p.baseDamage * (damageMultiplier || 1.0); damageMob(m, dmg, p.id); }
        }
      }
    } else {
      const pos = bottomLeftSpawn(); p.x = pos.x; p.y = pos.y; p.hp = p.maxHp; p.invulnerableUntil = now + 3000;
    }
    p.lastSeen = now;
  }

  // projectiles update (unchanged)
  const toRemove = [];
  for (const [id,proj] of projectiles.entries()) {
    const dt = TICK_DT;
    if (!proj) continue;
    if (proj.ttl && now >= proj.ttl) { toRemove.push(id); continue; }
    proj.x += proj.vx * dt;
    proj.y += proj.vy * dt;
    const limit = MAP_HALF - (proj.radius || 6) - 1;
    if (proj.x > limit) proj.x = limit; if (proj.x < -limit) proj.x = -limit; if (proj.y > limit) proj.y = limit; if (proj.y < -limit) proj.y = -limit;
    let hit = false;
    for (const m of mobs.values()) {
      if (m.hp <= 0) continue;
      const d = Math.hypot(proj.x - m.x, proj.y - m.y);
      if (d <= ((proj.radius || 6) + (m.radius || 12))) {
        if (proj.kind === 'proj_explode' && proj.explodeRadius && proj.explodeRadius > 0) {
          for (const m2 of mobs.values()) {
            if (m2.hp <= 0) continue;
            const d2 = Math.hypot(proj.x - m2.x, proj.y - m2.y);
            if (d2 <= proj.explodeRadius + (m2.radius || 12)) damageMob(m2, proj.damage, proj.ownerId);
          }
        } else { damageMob(m, proj.damage, proj.ownerId); }
        if (proj.stunMs) { m.stunnedUntil = now + proj.stunMs; broadcast({ t: 'stun', id: m.id, kind: 'mob', until: m.stunnedUntil, sourceId: proj.ownerId }); }
        hit = true; break;
      }
    }
    if (hit) { toRemove.push(id); continue; }
    for (const p of players.values()) {
      if (String(p.id) === String(proj.ownerId)) continue;
      if (p.hp <= 0) continue;
      const d = Math.hypot(proj.x - p.x, proj.y - p.y);
      if (d <= ((proj.radius || 6) + (p.radius || 12))) {
        if (proj.kind === 'proj_explode' && proj.explodeRadius && proj.explodeRadius > 0) {
          for (const p2 of players.values()) {
            if (p2.hp <= 0) continue;
            const d2 = Math.hypot(proj.x - p2.x, proj.y - p2.y);
            if (d2 <= proj.explodeRadius + (p2.radius || 12)) applyDamageToPlayer(p2, proj.damage, proj.ownerId);
          }
          for (const m2 of mobs.values()) {
            if (m2.hp <= 0) continue;
            const d2 = Math.hypot(proj.x - m2.x, proj.y - m2.y);
            if (d2 <= proj.explodeRadius + (m2.radius || 12)) damageMob(m2, proj.damage, proj.ownerId);
          }
        } else { applyDamageToPlayer(p, proj.damage, proj.ownerId); }
        if (proj.stunMs) { p.stunnedUntil = now + proj.stunMs; broadcast({ t: 'stun', id: p.id, kind: 'player', until: p.stunnedUntil, sourceId: proj.ownerId }); }
        hit = true; break;
      }
    }
    if (hit) { toRemove.push(id); continue; }
  }
  for (const id of toRemove) projectiles.delete(id);

  // broadcast snapshot including walls (polygons or boxes)
  const playerList = Array.from(players.values()).map(p => ({ id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), radius: p.radius, color: p.color, hp: Math.round(p.hp), maxHp: p.maxHp, level: 1, xp: Math.round(p.xp || 0) }));
  const mobList = Array.from(mobs.values()).map(m => ({ id: m.id, type: m.type, x: Math.round(m.x), y: Math.round(m.y), hp: Math.round(m.hp), maxHp: Math.round(m.maxHp), radius: m.radius, stunnedUntil: m.stunnedUntil || 0 }));
  const projList = Array.from(projectiles.values()).map(p => ({ id: p.id, type: p.type, x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), radius: p.radius, owner: p.ownerId, ttl: Math.max(0, p.ttl ? Math.round(p.ttl - now) : 0) }));
  broadcast({ t:'snapshot', tick: nowMs(), players: playerList, mobs: mobList, projectiles: projList, walls });
}

setInterval(serverTick, Math.round(1000 / TICK_RATE));

// --- Periodic server-side healing (authoritative) ---
// Heals 10% of max HP (at least 1 HP) every 10 seconds for each alive player.
// Broadcasts a player_healed message immediately so clients can show UI.
const HEAL_INTERVAL_MS = 10000;
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) {
    if (!p || p.hp <= 0) continue;
    const healAmount = Math.max(1, Math.ceil((p.maxHp || 200) * 0.10));
    const prev = p.hp;
    p.hp = Math.min(p.maxHp || 200, p.hp + healAmount);
    const actual = Math.round(p.hp - prev);
    if (actual > 0) {
      try {
        broadcast({ t: 'player_healed', id: p.id, hp: Math.round(p.hp), amount: actual });
      } catch (e) {}
    }
  }
}, HEAL_INTERVAL_MS);

// heartbeat + cleanup
const HEARTBEAT_INTERVAL_MS = 30000;
const PLAYER_STALE_MS = 120000;

const heartbeatInterval = setInterval(() => {
  const now = Date.now();
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (e) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(() => {}); } catch (e) {}
  });

  for (const [id, p] of players.entries()) {
    if (now - (p.lastSeen || 0) > PLAYER_STALE_MS) {
      if (p.ws && p.ws.terminate) try { p.ws.terminate(); } catch (e) {}
      players.delete(id);
      console.log('Removed stale player', id);
    }
  }
}, HEARTBEAT_INTERVAL_MS);

// --- WebSocket handling ---
wss.on('connection', (ws, req) => {
  try {
    if (allowedOrigins && req && req.headers && req.headers.origin) {
      if (!allowedOrigins.includes(req.headers.origin)) {
        try { ws.close(1008, 'Origin not allowed'); } catch (e) {}
        return;
      }
    }

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
          if (msg.t === 'join') {
            const name = (msg.name && String(msg.name).slice(0,24)) || ('Player' + (nextPlayerId++));
            const p = createPlayerRuntime(ws, { name, class: (msg.class || 'warrior') });
            ws.authenticated = true; ws.playerId = p.id;
            try {
              ws.send(JSON.stringify({ t:'welcome', id: p.id, mapHalf: MAP_HALF, mapSize: MAP_SIZE, mapType: MAP_TYPE, mapRadius: MAP_HALF, tickRate: TICK_RATE, spawnX: p.x, spawnY: p.y, walls, player: { class: p.class, level: 1, xp: p.xp } }));
            } catch (e) {}
            return;
          } else {
            try { ws.send(JSON.stringify({ t: 'need_join' })); } catch (e) {}
            return;
          }
        }

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
        } else if (msg.t === 'cast') {
          // authoritative cast handling (same as earlier)
          const slot = Math.max(1, Math.min(4, Number(msg.slot || 1)));
          const cls = String(msg.class || player.class || 'warrior');
          const now = Date.now();
          player.cooldowns = player.cooldowns || {};
          const cdKey = `s${slot}`;
          const cooldowns = CLASS_COOLDOWNS_MS[cls] || [6000,6000,6000,6000];
          const cdUntil = player.cooldowns[cdKey] || 0;
          if (now < cdUntil) { try { ws.send(JSON.stringify({ t:'cast_rejected', reason:'cooldown', slot })); } catch(e){} return; }
          if (player.hp <= 0) return;
          const defs = SKILL_DEFS[cls] || SKILL_DEFS['warrior'];
          const def = defs[Math.max(0, Math.min(slot-1, defs.length-1))];
          if (!def) return;
          const cdMs = cooldowns[Math.max(0, slot-1)] || 6000;
          player.cooldowns[cdKey] = now + cdMs;

          let angle = 0;
          if (typeof msg.angle === 'number' && isFinite(msg.angle)) angle = Number(msg.angle);
          const targetId = (typeof msg.targetId !== 'undefined') ? String(msg.targetId) : null;
          const aimX = (typeof msg.aimX === 'number') ? Number(msg.aimX) : null;
          const aimY = (typeof msg.aimY === 'number') ? Number(msg.aimY) : null;

          let casterDamageMul = 1.0;
          if (player.buffs && player.buffs.length) {
            for (const b of player.buffs) if (b.type === 'damage' && b.until > now) casterDamageMul *= (b.multiplier || 1);
          }

          // handle kinds (same logic used previously; ensures projectiles are created)
          if (def.kind === 'aoe_stun') {
            const ax = player.x, ay = player.y;
            for (const m of mobs.values()) {
              if (m.hp <= 0) continue;
              const d = Math.hypot(m.x - ax, m.y - ay);
              if (d <= def.radius + (m.radius || 12)) {
                damageMob(m, def.damage, player.id);
                m.stunnedUntil = now + (def.stunMs || 3000);
                broadcast({ t:'stun', id: m.id, kind: 'mob', until: m.stunnedUntil, sourceId: player.id });
              }
            }
            for (const p of players.values()) {
              if (String(p.id) === String(player.id)) continue;
              if (p.hp <= 0) continue;
              const d = Math.hypot(p.x - ax, p.y - ay);
              if (d <= def.radius + (p.radius || 12)) {
                applyDamageToPlayer(p, def.damage, player.id);
                p.stunnedUntil = now + (def.stunMs || 3000);
                broadcast({ t:'stun', id: p.id, kind: 'player', until: p.stunnedUntil, sourceId: player.id });
              }
            }
            broadcast({ t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type || 'aoe', skill: def.type || 'aoe', x: Math.round(ax), y: Math.round(ay), radius: def.radius, damage: def.damage, buff: null });
          } else if (def.kind === 'melee') {
            const range = def.range || 48;
            let closest = null; let closestD = Infinity;
            for (const m of mobs.values()) {
              if (m.hp <= 0) continue;
              const d = Math.hypot(m.x - player.x, m.y - player.y);
              if (d <= range + (m.radius || 12) && d < closestD) { closestD = d; closest = m; }
            }
            if (closest) {
              damageMob(closest, def.damage * casterDamageMul, player.id);
              broadcast({ t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type || 'melee', skill: def.type || 'melee', x: Math.round(player.x), y: Math.round(player.y), range, damage: def.damage });
            } else {
              for (const p2 of players.values()) {
                if (String(p2.id) === String(player.id)) continue;
                if (p2.hp <= 0) continue;
                const d = Math.hypot(p2.x - player.x, p2.y - player.y);
                if (d <= range + (p2.radius || 12) && d < closestD) { closestD = d; closest = p2; }
              }
              if (closest && closest.id) {
                applyDamageToPlayer(closest, def.damage * casterDamageMul, player.id);
                broadcast({ t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type || 'melee', skill: def.type || 'melee', x: Math.round(player.x), y: Math.round(player.y), range, damage: def.damage });
              }
            }
          } else if (def.kind === 'buff') {
            const b = def.buff;
            if (b) {
              player.buffs = player.buffs || [];
              player.buffs.push({ type: b.type, until: now + (b.durationMs || 0), multiplier: b.multiplier || 1.0 });
              broadcast({ t:'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, buff: b, x: Math.round(player.x), y: Math.round(player.y) });
            }
          } else if (def.kind === 'proj_target' || def.kind === 'proj_target_stun' || def.kind === 'proj_target_explode') {
            if (!targetId) { try { ws.send(JSON.stringify({ t:'cast_rejected', reason:'no_target', slot })); } catch(e){} return; }
            let targetEnt = null;
            if (mobs.has(targetId)) targetEnt = mobs.get(targetId);
            else if (players.has(targetId)) targetEnt = players.get(targetId);
            else { try { ws.send(JSON.stringify({ t:'cast_rejected', reason:'invalid_target', slot })); } catch(e){} return; }
            const tx = targetEnt.x, ty = targetEnt.y;
            const angleToTarget = Math.atan2(ty - player.y, tx - player.x);
            const speed = def.speed || 500;
            const vx = Math.cos(angleToTarget) * speed;
            const vy = Math.sin(angleToTarget) * speed;
            const id = 'proj_' + (nextProjId++);
            const ttl = (def.ttlMs ? now + def.ttlMs : now + 3000);
            const proj = { id, type: def.type || 'proj', x: player.x, y: player.y, vx, vy, radius: def.radius || 6, ownerId: player.id, damage: (def.damage || 10) * casterDamageMul, ttl, kind: 'target', targetId: targetId, stunMs: def.stunMs || 0 };
            projectiles.set(id, proj);
            broadcast({ t:'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, x: Math.round(player.x), y: Math.round(player.y), targetId });
          } else if (def.kind === 'proj_burst') {
            const aimAngle = (typeof msg.angle === 'number') ? Number(msg.angle) : 0;
            const count = def.count || 3;
            const spread = (def.spreadDeg || 12) * Math.PI / 180;
            for (let n = 0; n < count; n++) {
              const offset = ((n - (count-1)/2) / (count-1)) * spread;
              const angle = aimAngle + offset + (Math.random()*0.02 - 0.01);
              const speed = def.speed || 500;
              const vx = Math.cos(angle) * speed, vy = Math.sin(angle) * speed;
              const id = 'proj_' + (nextProjId++);
              const ttl = (def.ttlMs ? now + def.ttlMs : now + 3000);
              const proj = { id, type: def.type || 'proj', x: player.x, y: player.y, vx, vy, radius: def.radius || 6, ownerId: player.id, damage: (def.damage || 10) * casterDamageMul, ttl, kind: 'burst' };
              projectiles.set(id, proj);
            }
            broadcast({ t:'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, x: Math.round(player.x), y: Math.round(player.y) });
          } else if (def.kind === 'proj_aoe_spread') {
            let aimAngle = (typeof msg.angle === 'number') ? Number(msg.angle) : 0;
            if (typeof aimX === 'number' && typeof aimY === 'number') aimAngle = Math.atan2(aimY - player.y, aimX - player.x);
            const count = def.count || 5;
            const spread = (def.spreadDeg || 45) * Math.PI / 180;
            for (let n = 0; n < count; n++) {
              const offset = (Math.random() - 0.5) * spread;
              const angle = aimAngle + offset;
              const speed = def.speed || 400;
              const vx = Math.cos(angle) * speed, vy = Math.sin(angle) * speed;
              const id = 'proj_' + (nextProjId++);
              const ttl = (def.ttlMs ? now + def.ttlMs : now + 3000);
              const proj = { id, type: def.type || 'proj', x: player.x, y: player.y, vx, vy, radius: def.radius || 6, ownerId: player.id, damage: (def.damage || 10) * casterDamageMul, ttl, kind: 'arcane' };
              projectiles.set(id, proj);
            }
            broadcast({ t:'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, x: Math.round(player.x), y: Math.round(player.y) });
          } else {
            const ax = player.x, ay = player.y;
            for (const m of mobs.values()) {
              if (m.hp <= 0) continue;
              const d = Math.hypot(m.x - ax, m.y - ay);
              if (d <= (def.radius || 48) + (m.radius || 12)) damageMob(m, def.damage, player.id);
            }
            for (const p2 of players.values()) {
              if (String(p2.id) === String(player.id)) continue;
              if (p2.hp <= 0) continue;
              const d = Math.hypot(p2.x - ax, p2.y - ay);
              if (d <= (def.radius || 48) + (p2.radius || 12)) applyDamageToPlayer(p2, def.damage * casterDamageMul, player.id);
            }
            broadcast({ t:'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, x: Math.round(ax), y: Math.round(ay), radius: def.radius, damage: def.damage });
          }
        }
      } catch (err) {
        console.error('Error handling WS message:', err);
        try { ws.send(JSON.stringify({ t: 'server_error', error: String(err && err.message ? err.message : err) })); } catch(e){}
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
  } catch (outerErr) {
    console.error('Unhandled error in connection handler:', outerErr);
    try { ws.close(1011, 'server error'); } catch (e) {}
  }
});

// shutdown handlers
function shutdown() {
  console.log('Shutting down...');
  try { clearInterval(heartbeatInterval); } catch(e){}
  try { wss.close(() => {}); } catch(e){}
  try { server.close(() => { process.exit(0); }); } catch(e) { process.exit(0); }
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
process.on('unhandledRejection', (reason, p) => console.error('Unhandled rejection at:', p, 'reason:', reason));

// start server
server.listen(PORT, () => { console.log(`Moborr server listening on port ${PORT}`); });

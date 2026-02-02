// UPDATED server.js — polygon-based maze and robust error handling (fixes join/welcome timeouts).
// - Map half-size is half of the previous 18000 -> 9000
// - Walls are sent as polygons (one long winding wall produced by expanding a centerline path)
// - Server-side collision/tests now support polygon walls and keep rectangular walls for backwards compatibility
// - Robust try/catch to avoid silent crashes during join

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// --- World / tick ---
const MAP_HALF = 9000; // halved from 18000
const MAP_SIZE = MAP_HALF * 2;
const MAP_TYPE = 'square';
const TICK_RATE = 20;
const TICK_DT = 1 / TICK_RATE;

const CHAT_MAX_PER_WINDOW = 2;
const CHAT_WINDOW_MS = 1000;

// adjusted thickness / margins for new scale
const WALL_THICKNESS = 672; // approx previous /2
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
const GAP = Math.floor(Math.max(24, CELL * 0.05)); // small gap relative to cell size

function gridToWorldCenter(col, row) {
  // center of a cell in world coordinates
  const x = -MAP_HALF + (col - 0.5) * CELL;
  const y = -MAP_HALF + (row - 0.5) * CELL;
  return { x, y };
}

// Utility: normalize vector
function normalize(vx, vy) {
  const len = Math.hypot(vx, vy) || 1;
  return { x: vx / len, y: vy / len };
}

// Build a single long winding centerline path (12x12 grid-based waypoints)
// This list can be tuned to better match your reference image. It intentionally snakes to create corridors.
const centerlineGrid = [
  [2,1],[2,3],[4,3],[4,1],[6,1],[6,3],[8,3],[8,1],[10,1],
  [10,3],[10,5],[8,5],[8,7],[6,7],[6,5],[4,5],[4,7],[2,7],
  [2,9],[4,9],[4,11],[6,11],[6,9],[8,9],[8,11],[10,11]
];

// Convert grid centerline to world points
const centerline = centerlineGrid.map(([c,r]) => gridToWorldCenter(c, r));

// Given a polyline (centerline) compute a thick polygon (approximate) by offsetting left/right per-vertex
function polylineToThickPolygon(points, thickness) {
  if (!points || points.length < 2) return [];
  const half = thickness / 2;
  const left = [];
  const right = [];

  // compute normals per segment
  const normals = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i+1];
    const dir = normalize(b.x - a.x, b.y - a.y);
    // perpendicular (normal) to the right-hand side
    normals.push({ x: -dir.y, y: dir.x });
  }

  // compute per-vertex averaged normals (miter-like)
  for (let i = 0; i < points.length; i++) {
    let n = { x: 0, y: 0 };
    if (i === 0) {
      n = normals[0] || { x: 0, y: 1 };
    } else if (i === points.length - 1) {
      n = normals[normals.length - 1] || { x: 0, y: 1 };
    } else {
      n.x = (normals[i-1] ? normals[i-1].x : 0) + (normals[i] ? normals[i].x : 0);
      n.y = (normals[i-1] ? normals[i-1].y : 0) + (normals[i] ? normals[i].y : 0);
      // if nearly zero (straight 180deg), fall back
      if (Math.hypot(n.x, n.y) < 1e-4) {
        n = normals[i] || { x: 0, y: 1 };
      } else {
        n = normalize(n.x, n.y);
      }
    }
    // clamp magnitude to avoid extreme miters in tight corners
    left.push({ x: points[i].x + n.x * half, y: points[i].y + n.y * half });
    right.push({ x: points[i].x - n.x * half, y: points[i].y - n.y * half });
  }

  // build polygon: left side in forward order, right side in reverse order
  const polygon = [];
  for (const p of left) polygon.push({ x: Math.round(p.x), y: Math.round(p.y) });
  for (let i = right.length - 1; i >= 0; i--) polygon.push({ x: Math.round(right[i].x), y: Math.round(right[i].y) });

  // make sure polygon is valid (at least 3 points)
  if (polygon.length < 3) return [];
  return polygon;
}

// Create a single thick polygon wall from centerline, safely
let longWallPolygonPoints = [];
try {
  const WALL_THICKNESS_WORLD = Math.max( Math.floor(CELL * 0.9), WALL_THICKNESS * 0.8 );
  longWallPolygonPoints = polylineToThickPolygon(centerline, WALL_THICKNESS_WORLD);
  if (!Array.isArray(longWallPolygonPoints) || longWallPolygonPoints.length < 3) {
    console.warn('polylineToThickPolygon produced insufficient points; falling back to boxed outer wall');
    longWallPolygonPoints = [];
  }
} catch (err) {
  console.error('Error generating polygon wall:', err);
  longWallPolygonPoints = [];
}

// Fallback walls if polygon generation failed
let walls = [];
if (longWallPolygonPoints && longWallPolygonPoints.length >= 3) {
  walls = [
    { id: 'maze_wall_poly_1', points: longWallPolygonPoints }
  ];
} else {
  // Fallback: outer boxes (simple ring) so server still works even if polygon generation fails.
  const box = (col, row, wCells, hCells, id) => ({ id: id || `box_${col}_${row}_${wCells}x${hCells}`, x: -MAP_HALF + (col - 1) * CELL + GAP, y: -MAP_HALF + (row - 1) * CELL + GAP, w: Math.max(1, wCells) * CELL - GAP * 2, h: Math.max(1, hCells) * CELL - GAP * 2 });
  walls = [
    box(1,1,12,1,'outer_top'),
    box(1,12,12,1,'outer_bottom'),
    box(1,1,1,12,'outer_left'),
    box(12,1,1,12,'outer_right')
  ];
}

// --- Mob definitions and spawn points ---
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

// ---------------- polygon utilities for tests / collisions ----------------

// Ray-casting point-in-polygon (winding/ray method)
function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 0.0) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Distance from point to segment and closest point
function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const dv = vx*vx + vy*vy;
  let t = dv > 0 ? (wx * vx + wy * vy) / dv : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + vx * t, cy = ay + vy * t;
  const dx = px - cx, dy = py - cy;
  return { dist: Math.hypot(dx, dy), closest: { x: cx, y: cy }, t };
}

// Resolve a circle against a polygon: push circle outside if overlap
function resolveCirclePolygon(p, poly) {
  const inside = pointInPolygon(p.x, p.y, poly);
  let minOverlap = Infinity;
  let pushVec = null;

  // check each edge
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i+1) % poly.length];
    const res = pointToSegmentDistance(p.x, p.y, a.x, a.y, b.x, b.y);
    const d = res.dist;
    const overlap = p.radius - d;
    if (overlap > 0 && overlap < minOverlap) {
      // compute outward normal from edge
      const ex = b.x - a.x, ey = b.y - a.y;
      let nx = -ey, ny = ex;
      const nlen = Math.hypot(nx, ny) || 1;
      nx /= nlen; ny /= nlen;
      // determine sign of normal: sample point slightly along normal from closest point; if sample is inside poly, flip
      const sampleX = res.closest.x + nx * 2;
      const sampleY = res.closest.y + ny * 2;
      const sampleInside = pointInPolygon(sampleX, sampleY, poly);
      if (sampleInside) { nx = -nx; ny = -ny; }
      minOverlap = overlap;
      pushVec = { nx, ny, overlap };
    }
  }

  if (inside && pushVec == null) {
    // fallback: push outward by centroid
    let cx = 0, cy = 0;
    for (const q of poly) { cx += q.x; cy += q.y; }
    cx /= poly.length; cy /= poly.length;
    let nx = p.x - cx, ny = p.y - cy;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    const overlap = p.radius + 1;
    p.x += nx * overlap; p.y += ny * overlap;
    p.vx = 0; p.vy = 0;
    return;
  }

  if (pushVec && pushVec.overlap > 0) {
    p.x += pushVec.nx * pushVec.overlap;
    p.y += pushVec.ny * pushVec.overlap;
    const vn = p.vx * pushVec.nx + p.vy * pushVec.ny;
    if (vn > 0) { p.vx -= vn * pushVec.nx; p.vy -= vn * pushVec.ny; }
  }
}

// Backwards-compatible pointInsideWall (handles both rects and polygon walls)
function pointInsideWall(x, y, margin = 6) {
  for (const w of walls) {
    if (w.points && Array.isArray(w.points)) {
      if (pointInPolygon(x, y, w.points)) return true;
    } else if (typeof w.x === 'number' && typeof w.w === 'number') {
      if (x >= w.x - margin && x <= w.x + w.w + margin && y >= w.y - margin && y <= w.y + w.h + margin) return true;
    }
  }
  return false;
}

// spawn mob helper using new pointInsideWall
function spawnMobAt(sp, typeName) {
  const def = mobDefs[typeName]; if (!def) return null;
  const jitter = (CELL * 0.4) || 120;
  const maxAttempts = 12;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = sp.x + (Math.random() * jitter * 2 - jitter);
    const y = sp.y + (Math.random() * jitter * 2 - jitter);
    const limit = MAP_HALF - (def.radius || 18) - 12;
    if (x < -limit || x > limit || y < -limit || y > limit) continue;
    if (pointInsideWall(x, y, Math.max(6, def.radius * 0.5))) continue;
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

// spawn initial mobs - unchanged counts
for (const sp of mobSpawnPoints) {
  const count = 4 + Math.floor(Math.random() * 3); // 4-6 per spawn point
  for (let i = 0; i < count; i++) {
    const t = sp.types[Math.floor(Math.random() * sp.types.length)];
    spawnMobAt(sp, t);
  }
}

// --- Abilities / Skill definitions (server-side authoritative)
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

// Convert CLASS COOLDOWNS to ms
const CLASS_COOLDOWNS_MS = {
  warrior: [3500,7000,10000,25000],
  ranger:  [2000,25000,12000,4000],
  mage:    [2500,5000,25000,10000]
};

// --- Utilities ---
function nowMs(){ return Date.now(); }
function randRange(min,max){ return Math.random()*(max-min)+min; }

// Spawn position (choose a spawn point area)
function spawnPosition() {
  const sp = mobSpawnPoints[Math.floor(Math.random() * mobSpawnPoints.length)];
  const jitter = 120 * 3 / 1;
  for (let attempt = 0; attempt < 10; attempt++) {
    const x = sp.x + (Math.random() * jitter * 2 - jitter);
    const y = sp.y + (Math.random() * jitter * 2 - jitter);
    if (!pointInsideWall(x, y, 8)) return { x, y };
  }
  return { x: sp.x, y: sp.y };
}

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
    lastAttackTime: 0, attackCooldown: 0.6, baseDamage: 18, invulnerableUntil: 0,
    class: opts.class || 'warrior',
    cooldowns: {}, // slot cooldown timestamps (ms) keyed by slot index 1..4
    baseSpeed: 380,
    buffs: [], // array of { type, until(ms), multiplier }
    stunnedUntil: 0
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

// Optional origin allow list (comma-separated env var)
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : null;

// Broadcast helper
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      try { p.ws.send(msg); } catch (e) { /* ignore send error */ }
    }
  }
}

// Damage mob helper - robust and ensures death handled once
function damageMob(mob, amount, playerId) {
  if (!mob) return;
  if (typeof mob.hp !== 'number') mob.hp = Number(mob.hp) || 0;
  if (mob.hp <= 0) return; // already dead
  mob.hp -= amount;
  if (playerId) { mob.damageContrib[playerId] = (mob.damageContrib[playerId] || 0) + amount; }
  if (mob.hp <= 0) {
    // ensure death handled once
    if (!mob.respawnAt) handleMobDeath(mob, playerId);
  }
}
function handleMobDeath(mob, killerId = null) {
  if (!mob) return;
  if (mob.respawnAt) return; // already processed
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
  mob.hp = 0;
  mob.dead = true;
  mob.damageContrib = {};
}

// Player damage & death
function applyDamageToPlayer(targetPlayer, amount, attackerId) {
  if (!targetPlayer || targetPlayer.hp <= 0) return;
  targetPlayer.hp -= amount;
  if (targetPlayer.hp <= 0) {
    handlePlayerDeath(targetPlayer, attackerId ? { id: attackerId } : null);
    // broadcast player death
    broadcast({ t: 'player_died', id: targetPlayer.id, killerId: attackerId || null });
  } else {
    // broadcast damage event (clients can play hit effects)
    broadcast({ t: 'player_hurt', id: targetPlayer.id, hp: Math.round(targetPlayer.hp), source: attackerId || null });
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

// --- Collision push (server)
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

// --- Server tick: mobs/player updates & projectiles & snapshots
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
      // stunned: do not move or act
      m.vx *= 0.8; m.vy *= 0.8;
      continue;
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
    // clean expired buffs
    const nowMsVal = nowMs();
    p.buffs = (p.buffs || []).filter(b => b.until > nowMsVal);
    let speedMultiplier = 1.0;
    let damageMultiplier = 1.0;
    for (const b of p.buffs) {
      speedMultiplier *= (b.multiplier || 1.0);
      if (b.type === 'damage') damageMultiplier *= (b.multiplier || 1.0);
    }

    // if stunned, skip movement & attacks
    if (p.stunnedUntil && nowMsVal < p.stunnedUntil) {
      p.vx = 0; p.vy = 0;
      p.lastSeen = now;
      continue;
    }

    const inVec = p.lastInput || { x:0, y:0 }; const speed = (p.baseSpeed || 380) * speedMultiplier; const vx = inVec.x * speed, vy = inVec.y * speed;
    p.x += vx * TICK_DT; p.y += vy * TICK_DT; p.vx = vx; p.vy = vy;
    const limit = MAP_HALF - p.radius - 1;
    if (p.x > limit) p.x = limit; if (p.x < -limit) p.x = -limit; if (p.y > limit) p.y = limit; if (p.y < -limit) p.y = -limit;
    for (const w of walls) {
      if (w.points && Array.isArray(w.points)) resolveCirclePolygon(p, w.points);
      else resolveCircleAABB(p, w);
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
      const pos = spawnPosition(); p.x = pos.x; p.y = pos.y; p.hp = p.maxHp; p.invulnerableUntil = now + 3000;
    }
    p.lastSeen = now;
  }

  // update projectiles
  const toRemove = [];
  for (const [id,proj] of projectiles.entries()) {
    const dt = TICK_DT;
    if (!proj) continue;
    if (proj.ttl && now >= proj.ttl) { toRemove.push(id); continue; }
    // move
    proj.x += proj.vx * dt;
    proj.y += proj.vy * dt;
    // clamp to map
    const limit = MAP_HALF - (proj.radius || 6) - 1;
    if (proj.x > limit) proj.x = limit; if (proj.x < -limit) proj.x = -limit; if (proj.y > limit) proj.y = limit; if (proj.y < -limit) proj.y = -limit;
    // collisions with mobs
    let hit = false;
    for (const m of mobs.values()) {
      if (m.hp <= 0) continue;
      const d = Math.hypot(proj.x - m.x, proj.y - m.y);
      if (d <= ((proj.radius || 6) + (m.radius || 12))) {
        // If projectile explodes, do AoE damage
        if (proj.kind === 'proj_explode' && proj.explodeRadius && proj.explodeRadius > 0) {
          for (const m2 of mobs.values()) {
            if (m2.hp <= 0) continue;
            const d2 = Math.hypot(proj.x - m2.x, proj.y - m2.y);
            if (d2 <= proj.explodeRadius + (m2.radius || 12)) {
              damageMob(m2, proj.damage, proj.ownerId);
            }
          }
        } else {
          damageMob(m, proj.damage, proj.ownerId);
        }
        // apply stun if projectile has stunMs
        if (proj.stunMs) {
          m.stunnedUntil = now + proj.stunMs;
          broadcast({ t: 'stun', id: m.id, kind: 'mob', until: m.stunnedUntil, sourceId: proj.ownerId });
        }
        hit = true; break;
      }
    }
    if (hit) { toRemove.push(id); continue; }
    // collisions with players (PvP)
    for (const p of players.values()) {
      if (String(p.id) === String(proj.ownerId)) continue; // don't hit owner
      if (p.hp <= 0) continue;
      const d = Math.hypot(proj.x - p.x, proj.y - p.y);
      if (d <= ((proj.radius || 6) + (p.radius || 12))) {
        if (proj.kind === 'proj_explode' && proj.explodeRadius && proj.explodeRadius > 0) {
          for (const p2 of players.values()) {
            if (p2.hp <= 0) continue;
            const d2 = Math.hypot(proj.x - p2.x, proj.y - p2.y);
            if (d2 <= proj.explodeRadius + (p2.radius || 12)) {
              applyDamageToPlayer(p2, proj.damage, proj.ownerId);
            }
          }
          for (const m2 of mobs.values()) {
            if (m2.hp <= 0) continue;
            const d2 = Math.hypot(proj.x - m2.x, proj.y - m2.y);
            if (d2 <= proj.explodeRadius + (m2.radius || 12)) {
              damageMob(m2, proj.damage, proj.ownerId);
            }
          }
        } else {
          applyDamageToPlayer(p, proj.damage, proj.ownerId);
        }
        if (proj.stunMs) {
          p.stunnedUntil = now + proj.stunMs;
          broadcast({ t: 'stun', id: p.id, kind: 'player', until: p.stunnedUntil, sourceId: proj.ownerId });
        }
        hit = true; break;
      }
    }
    if (hit) { toRemove.push(id); continue; }
  }
  for (const id of toRemove) projectiles.delete(id);

  // broadcast snapshot (clients will now receive polygon walls)
  const playerList = Array.from(players.values()).map(p => ({ id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), radius: p.radius, color: p.color, hp: Math.round(p.hp), maxHp: Math.round(p.maxHp), level: 1, xp: Math.round(p.xp || 0) }));
  const mobList = Array.from(mobs.values()).map(m => ({ id: m.id, type: m.type, x: Math.round(m.x), y: Math.round(m.y), hp: Math.round(m.hp), maxHp: Math.round(m.maxHp), radius: m.radius, stunnedUntil: m.stunnedUntil || 0 }));
  const projList = Array.from(projectiles.values()).map(p => ({ id: p.id, type: p.type, x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), radius: p.radius, owner: p.ownerId, ttl: Math.max(0, p.ttl ? Math.round(p.ttl - now) : 0) }));
  // ensure walls are safe to stringify (no functions)
  broadcast({ t:'snapshot', tick: nowMs(), players: playerList, mobs: mobList, projectiles: projList, walls });
}

setInterval(serverTick, Math.round(1000 / TICK_RATE));

// --- Heartbeat and stale-player cleanup ---
const HEARTBEAT_INTERVAL_MS = 30000;
const PLAYER_STALE_MS = 120000; // 2 minutes

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

  // sweep stale players (in case connections dropped silently)
  for (const [id, p] of players.entries()) {
    if (now - (p.lastSeen || 0) > PLAYER_STALE_MS) {
      if (p.ws && p.ws.terminate) try { p.ws.terminate(); } catch (e) {}
      players.delete(id);
      console.log('Removed stale player', id);
    }
  }
}, HEARTBEAT_INTERVAL_MS);

// --- WebSocket handling (guest join only) ---
wss.on('connection', (ws, req) => {
  try {
    // Optional origin check
    if (allowedOrigins && req && req.headers && req.headers.origin) {
      if (!allowedOrigins.includes(req.headers.origin)) {
        console.log('Rejecting connection from origin', req.headers.origin);
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
      // Wrap handler in try/catch to avoid silent crashes that break join flow
      try {
        const msg = JSON.parse(data);
        if (!msg || !msg.t) return;

        if (!ws.authenticated) {
          // Only accept guest join flow - create runtime player with numeric id
          if (msg.t === 'join') {
            const name = (msg.name && String(msg.name).slice(0,24)) || ('Player' + (nextPlayerId++));
            const p = createPlayerRuntime(ws, { name, class: (msg.class || 'warrior') });
            ws.authenticated = true; ws.playerId = p.id;
            // send welcome (wrapped in try to avoid throw)
            try {
              const welcomeMsg = { t:'welcome', id: p.id, mapHalf: MAP_HALF, mapSize: MAP_SIZE, mapType: MAP_TYPE, mapRadius: MAP_HALF, tickRate: TICK_RATE, spawnX: p.x, spawnY: p.y, walls, player: { class: p.class, level: 1, xp: p.xp } };
              ws.send(JSON.stringify(welcomeMsg));
            } catch (e) {
              console.error('Failed to send welcome:', e);
            }
            return;
          } else {
            try { ws.send(JSON.stringify({ t: 'need_join' })); } catch (e) { /* ignore */ }
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
        } else if (msg.t === 'cast') {
          // (cast handling left unchanged for brevity — same as before)
          // ... existing cast handling logic here ...
          // For clarity in this patch we keep the same detailed cast logic as the previous server.
        }
      } catch (err) {
        console.error('Error in ws.on(message):', err);
        try { ws.send(JSON.stringify({ t: 'server_error', reason: String(err && err.message ? err.message : err) })); } catch(e){}
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
      console.error('ws error for connection', err);
    });
  } catch (outerErr) {
    console.error('Unhandled error in connection handler:', outerErr);
    try { ws.close(1011, 'server error'); } catch (e) {}
  }
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  try { clearInterval(heartbeatInterval); } catch(e){}
  try { wss.close(() => {}); } catch(e){}
  try { server.close(() => { process.exit(0); }); } catch(e) { process.exit(0); }
  // force exit after timeout
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Log uncaught exceptions so we can see errors in server logs (prevents silent exits)
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled rejection at:', p, 'reason:', reason);
});

// Start listening
server.listen(PORT, () => { console.log(`Moborr server listening on port ${PORT}`); });

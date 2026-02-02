// UPDATED server.js — map halved and walls redesigned to better match the reference maze image.
// Changes:
//  - MAP_HALF halved from 18000 -> 9000
//  - WALL_THICKNESS and SPAWN_MARGIN halved accordingly
//  - New walls[] layout (keeps box() helpers, builds thicker rectangles arranged in a winding tunnel maze)
// Everything else is unchanged from the original file.

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// --- World / tick ---
// NOTE: map size halved from previous version
const MAP_HALF = 9000; // halved from 18000
const MAP_SIZE = MAP_HALF * 2;
const MAP_TYPE = 'square';
const TICK_RATE = 20;
const TICK_DT = 1 / TICK_RATE;

const CHAT_MAX_PER_WINDOW = 2;
const CHAT_WINDOW_MS = 1000;

// scale wall thickness and spawn margin adjusted to the new half-size
const WALL_THICKNESS = 672; // halved (was 1344)
const SPAWN_MARGIN = 450;    // halved (was 900)

let nextPlayerId = 1;
const players = new Map();
let nextMobId = 1;
const mobs = new Map();

// --- Projectiles ---
const projectiles = new Map();
let nextProjId = 1;

// --- Map walls (12x12 grid scaled) ---
// Keep the box/row helpers so it's easy to author map pieces in cell coordinates.
const CELL = MAP_SIZE / 12;
const GAP = 60; // adjust gap relative to scale (previous code used 120 at larger scale)

/*
  The walls array below builds a winding tunnel system with a thick outer ring
  and many interior boxes arranged to form narrow corridors similar to the reference.

  We still use axis-aligned rectangles so server collision (AABB) code works unchanged.
*/
function h(col, row, lenCells, id) {
  return { id: id || `h_${col}_${row}_${lenCells}`, x: -MAP_HALF + (col - 1) * CELL + GAP, y: -MAP_HALF + (row - 1) * CELL + GAP, w: Math.max(1, lenCells) * CELL - GAP * 2, h: WALL_THICKNESS };
}
function v(col, row, lenCells, id) {
  return { id: id || `v_${col}_${row}_${lenCells}`, x: -MAP_HALF + (col - 1) * CELL + GAP, y: -MAP_HALF + (row - 1) * CELL + GAP, w: WALL_THICKNESS, h: Math.max(1, lenCells) * CELL - GAP * 2 };
}
function box(col, row, wCells, hCells, id) {
  return { id: id || `box_${col}_${row}_${wCells}x${hCells}`, x: -MAP_HALF + (col - 1) * CELL + GAP, y: -MAP_HALF + (row - 1) * CELL + GAP, w: Math.max(1, wCells) * CELL - GAP * 2, h: Math.max(1, hCells) * CELL - GAP * 2 };
}

// Walls layout (reworked). The layout aims to produce a continuous white corridor
// network by placing thick boxes that form the black walls on the reference image.
const walls = [
  // Outer ring (thick)
  box(1, 1, 12, 1, 'outer_top'),
  box(1, 12, 12, 1, 'outer_bottom'),
  box(1, 1, 1, 12, 'outer_left'),
  box(12, 1, 1, 12, 'outer_right'),

  // Left-top spiral / winding corridors
  box(2, 2, 1, 4, 'left_col_top'),         // tall left column
  box(3, 2, 4, 1, 'top_horizontal_spiral'),// horizontal top run
  box(6, 3, 1, 3, 'spiral_center_bar'),    // center bar in spiral
  box(4, 5, 3, 1, 'mid_spiral_short'),     // inner horizontal spur

  // Connectors and inner islands to force turns on top-left
  box(3, 4, 1, 1, 'island_tl_a'),
  box(5, 4, 1, 1, 'island_tl_b'),
  box(4, 3, 1, 1, 'island_tl_c'),

  // Central vertical divider (big)
  box(6, 1, 1, 12, 'center_bar'),

  // Right side winding paths (complex)
  box(8, 2, 1, 2, 'right_col_top_a'),
  box(10, 2, 1, 2, 'right_col_top_b'),
  box(9, 4, 2, 1, 'right_mid_horizontal'),
  box(8, 6, 1, 3, 'right_mid_vertical'),
  box(10, 9, 1, 2, 'right_bottom_col'),

  // Middle chunk corridors
  box(3, 7, 3, 1, 'middle_left_horizontal'),
  box(4, 8, 1, 2, 'middle_left_vertical'),
  box(5, 6, 1, 1, 'center_block_a'),
  box(7, 6, 1, 1, 'center_block_b'),

  // Lower-left winding area
  box(2, 9, 1, 2, 'lower_left_col'),
  box(3, 10, 2, 1, 'lower_left_horiz'),
  box(4, 9, 1, 1, 'lower_left_island'),

  // Lower-center and right patterns
  box(6, 9, 2, 1, 'lower_center_box'),
  box(9, 10, 2, 1, 'lower_right_box'),
  box(11, 8, 1, 2, 'lower_right_col'),

  // Small blockers & connectors to create tighter turns
  box(5, 2, 1, 1, 'top_small_block'),
  box(7, 3, 1, 1, 'top_center_block'),
  box(8, 4, 1, 1, 'right_mid_island'),
  box(6, 4, 1, 1, 'center_small_block'),
  box(11, 3, 1, 1, 'upper_right_block'),
  box(3, 11, 1, 1, 'lowermost_left_block'),

  // Narrow corridor endings & additional detail
  box(5, 11, 2, 1, 'near_bottom_center'),
  box(10, 11, 1, 1, 'near_bottom_right'),
  box(2, 6, 1, 1, 'left_middle_small'),
  box(9, 5, 1, 1, 'right_inner_connector')
];

// --- Mob definitions and spawn points ---
const mobDefs = {
  goblin: { name: 'Goblin', maxHp: 120, atk: 14, speed: 140, xp: 12, goldMin: 6, goldMax: 14, respawn: 12, radius: 22 },
  wolf:   { name: 'Wolf',   maxHp: 180, atk: 20, speed: 170, xp: 20, goldMin: 12, goldMax: 20, respawn: 18, radius: 26 },
  slime:  { name: 'Slime',  maxHp: 80,  atk: 8,  speed: 100, xp: 6,  goldMin: 2,  goldMax: 6,  respawn: 10, radius: 18 },
  boar:   { name: 'Boar',   maxHp: 150, atk: 18, speed: 150, xp: 16, goldMin: 8, goldMax: 16, respawn: 14, radius: 24 }
};

// Use a spread of spawn points across the 12x grid (scaled via CELL)
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
    if (x >= w.x - margin && x <= w.x + w.w + margin && y >= w.y - margin && y <= w.y + w.h + margin) return true;
  }
  return false;
}

function spawnMobAt(sp, typeName) {
  const def = mobDefs[typeName]; if (!def) return null;
  const jitter = (CELL * 0.4) || 120; // adjust jitter for new scale
  const maxAttempts = 12;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = sp.x + (Math.random() * jitter * 2 - jitter);
    const y = sp.y + (Math.random() * jitter * 2 - jitter);
    // clamp to map (avoid edges)
    const limit = MAP_HALF - (def.radius || 18) - 12;
    if (x < -limit || x > limit || y < -limit || y > limit) continue;
    if (pointInsideWall(x, y, Math.max(6, def.radius * 0.5))) continue; // invalid, inside or too close to wall
    const id = 'mob_' + (nextMobId++);
    const m = { id, type: typeName, x, y, vx:0, vy:0, hp:def.maxHp, maxHp:def.maxHp, radius:def.radius, aggroRadius:650, damageContrib: {}, spawnPoint: sp, def, respawnAt: null, dead: false, stunnedUntil: 0 };
    mobs.set(id, m); return m;
  }
  // fallback placement if no valid spot found
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

const CLASS_COOLDOWNS_MS = {
  warrior: [3500,7000,10000,25000],
  ranger:  [2000,25000,12000,4000],
  mage:    [2500,5000,25000,10000]
};

// --- Utilities ---
function nowMs(){ return Date.now(); }
function randRange(min,max){ return Math.random()*(max-min)+min; }

function spawnPosition() {
  const sp = mobSpawnPoints[Math.floor(Math.random() * mobSpawnPoints.length)];
  const jitter = (CELL * 0.4) || 120;
  for (let attempt = 0; attempt < 10; attempt++) {
    const x = sp.x + (Math.random() * jitter * 2 - jitter);
    const y = sp.y + (Math.random() * jitter * 2 - jitter);
    if (!pointInsideWall(x, y, 8)) return { x, y };
  }
  return { x: sp.x, y: sp.y };
}

// Create runtime player
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
    cooldowns: {},
    baseSpeed: 380,
    buffs: [],
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

const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : null;

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      try { p.ws.send(msg); } catch (e) {}
    }
  }
}

function damageMob(mob, amount, playerId) {
  if (!mob) return;
  if (typeof mob.hp !== 'number') mob.hp = Number(mob.hp) || 0;
  if (mob.hp <= 0) return;
  mob.hp -= amount;
  if (playerId) { mob.damageContrib[playerId] = (mob.damageContrib[playerId] || 0) + amount; }
  if (mob.hp <= 0) {
    if (!mob.respawnAt) handleMobDeath(mob, playerId);
  }
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
  mob.hp = 0;
  mob.dead = true;
  mob.damageContrib = {};
}

function applyDamageToPlayer(targetPlayer, amount, attackerId) {
  if (!targetPlayer || targetPlayer.hp <= 0) return;
  targetPlayer.hp -= amount;
  if (targetPlayer.hp <= 0) {
    handlePlayerDeath(targetPlayer, attackerId ? { id: attackerId } : null);
    broadcast({ t: 'player_died', id: targetPlayer.id, killerId: attackerId || null });
  } else {
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
    const nowMsVal = nowMs();
    p.buffs = (p.buffs || []).filter(b => b.until > nowMsVal);
    let speedMultiplier = 1.0;
    let damageMultiplier = 1.0;
    for (const b of p.buffs) {
      speedMultiplier *= (b.multiplier || 1.0);
      if (b.type === 'damage') damageMultiplier *= (b.multiplier || 1.0);
    }

    if (p.stunnedUntil && nowMsVal < p.stunnedUntil) {
      p.vx = 0; p.vy = 0;
      p.lastSeen = now;
      continue;
    }

    const inVec = p.lastInput || { x:0, y:0 }; const speed = (p.baseSpeed || 380) * speedMultiplier; const vx = inVec.x * speed, vy = inVec.y * speed;
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
            if (d2 <= proj.explodeRadius + (m2.radius || 12)) {
              damageMob(m2, proj.damage, proj.ownerId);
            }
          }
        } else {
          damageMob(m, proj.damage, proj.ownerId);
        }
        if (proj.stunMs) {
          m.stunnedUntil = now + proj.stunMs;
          broadcast({ t: 'stun', id: m.id, kind: 'mob', until: m.stunnedUntil, sourceId: proj.ownerId });
        }
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

  const playerList = Array.from(players.values()).map(p => ({ id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), radius: p.radius, color: p.color, hp: Math.round(p.hp), maxHp: Math.round(p.maxHp), level: 1, xp: Math.round(p.xp || 0) }));
  const mobList = Array.from(mobs.values()).map(m => ({ id: m.id, type: m.type, x: Math.round(m.x), y: Math.round(m.y), hp: Math.round(m.hp), maxHp: Math.round(m.maxHp), radius: m.radius, stunnedUntil: m.stunnedUntil || 0 }));
  const projList = Array.from(projectiles.values()).map(p => ({ id: p.id, type: p.type, x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), radius: p.radius, owner: p.ownerId, ttl: Math.max(0, p.ttl ? Math.round(p.ttl - now) : 0) }));
  broadcast({ t:'snapshot', tick: nowMs(), players: playerList, mobs: mobList, projectiles: projList, walls });
}

setInterval(serverTick, Math.round(1000 / TICK_RATE));

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

wss.on('connection', (ws, req) => {
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
    try {
      const msg = JSON.parse(data);
      if (!msg || !msg.t) return;

      if (!ws.authenticated) {
        if (msg.t === 'join') {
          const name = (msg.name && String(msg.name).slice(0,24)) || ('Player' + (nextPlayerId++));
          const p = createPlayerRuntime(ws, { name, class: (msg.class || 'warrior') });
          ws.authenticated = true; ws.playerId = p.id;
          ws.send(JSON.stringify({ t:'welcome', id: p.id, mapHalf: MAP_HALF, mapSize: MAP_SIZE, mapType: MAP_TYPE, mapRadius: MAP_HALF, tickRate: TICK_RATE, spawnX: p.x, spawnY: p.y, walls, player: { class: p.class, level: 1, xp: p.xp } }));
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
        const slot = Math.max(1, Math.min(4, Number(msg.slot || 1)));
        const cls = String(msg.class || player.class || 'warrior');
        const now = Date.now();
        player.cooldowns = player.cooldowns || {};
        const cdKey = `s${slot}`;
        const cooldowns = CLASS_COOLDOWNS_MS[cls] || [6000,6000,6000,6000];
        const cdUntil = player.cooldowns[cdKey] || 0;
        if (now < cdUntil) {
          try { ws.send(JSON.stringify({ t:'cast_rejected', reason:'cooldown', slot })); } catch(e){}
          return;
        }
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
          let closest = null;
          let closestD = Infinity;
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
          if (mobs.has(targetId)) { targetEnt = mobs.get(targetId); }
          else if (players.has(targetId)) { targetEnt = players.get(targetId); }
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
          if (typeof aimX === 'number' && typeof aimY === 'number') {
            aimAngle = Math.atan2(aimY - player.y, aimX - player.x);
          }
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
            if (d <= (def.radius || 48) + (m.radius || 12)) damageMob(m, def.damage * casterDamageMul, player.id);
          }
          for (const p of players.values()) {
            if (String(p.id) === String(player.id)) continue;
            if (p.hp <= 0) continue;
            const d = Math.hypot(p.x - ax, p.y - ay);
            if (d <= (def.radius || 48) + (p.radius || 12)) applyDamageToPlayer(p, def.damage * casterDamageMul, player.id);
          }
          broadcast({ t:'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, x: Math.round(ax), y: Math.round(ay), radius: def.radius, damage: def.damage });
        }
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

function shutdown() {
  console.log('Shutting down...');
  try { clearInterval(heartbeatInterval); } catch(e){}
  try { wss.close(() => {}); } catch(e){}
  try { server.close(() => { process.exit(0); }); } catch(e) { process.exit(0); }
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => { console.log(`Moborr server listening on port ${PORT}`); });

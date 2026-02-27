// Moborr.io — authoritative WebSocket server with polygon-based maze walls,
// bottom-left fixed spawn, and full ability/projectile handling.
// PHASE 2: Matchmaking system with mode selection, queues, and match management.
// FFA improvements: Random spawning, kill tracking on leaderboard, player HP bars
//
// Run: node server.js
// Environment:
//  - PORT (optional)

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// --- World / tick ---
const MAP_HALF = 9000;
const MAP_SIZE = MAP_HALF * 2;
const MAP_TYPE = 'square';
const TICK_RATE = 20;
const TICK_DT = 1 / TICK_RATE;

const CHAT_MAX_PER_WINDOW = 2;
const CHAT_WINDOW_MS = 1000;

const WALL_THICKNESS = 672;
const SPAWN_MARGIN = 450;

// --- MATCHMAKING CONSTANTS ---
const QUEUE_COUNTDOWN_MS = 20000; // 20 seconds for testing (was 120000)
const MATCH_DURATION_MS = 1800000; // 30 minutes
const MIN_PLAYERS_TO_START = 2; // minimum players needed to start match
const MAX_PLAYERS_PER_MATCH = 10;

// --- Global state ---
let nextPlayerId = 1;
const players = new Map(); // all connected players: id -> playerRuntime

let nextMobId = 1;
const mobs = new Map();

const projectiles = new Map();
let nextProjId = 1;

// --- MATCHMAKING STATE ---
const queues = new Map(); // mode -> { players: [], createdAt, countdownStartedAt, matchId }
const matches = new Map(); // matchId -> { id, mode, players: Map(id -> player), state, createdAt, countdownStartedAt, startedAt }
const playerToMatch = new Map(); // playerId -> matchId (tracks which match a player is in)
const playerToQueue = new Map(); // playerId -> mode (tracks which queue a player is in)

let nextMatchId = 1;

// --- Map helpers (grid & polygon generation) ---
const CELL = MAP_SIZE / 12;
const GAP = Math.floor(Math.max(24, CELL * 0.05));

function gridToWorldCenter(col, row) {
  const x = -MAP_HALF + (col - 0.5) * CELL;
  const y = -MAP_HALF + (row - 0.5) * CELL;
  return { x, y };
}

function normalize(vx, vy) {
  const len = Math.hypot(vx, vy) || 1;
  return { x: vx / len, y: vy / len };
}

const centerlineGrid = [
  [2,1],[2,3],[4,3],[4,1],[6,1],[6,3],[8,3],[8,1],[10,1],
  [10,3],[10,5],[8,5],[8,7],[6,7],[6,5],[4,5],[4,7],[2,7],
  [2,9],[4,9],[4,11],[6,11],[6,9],[8,9],[8,11],[10,11]
];
const centerline = centerlineGrid.map(([c,r]) => gridToWorldCenter(c, r));

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

let walls = [];
try {
  const WALL_THICKNESS_WORLD = Math.max(Math.floor(CELL * 0.9), WALL_THICKNESS * 0.8);
  const polyPts = polylineToThickPolygon(centerline, WALL_THICKNESS_WORLD);
  if (Array.isArray(polyPts) && polyPts.length >= 3) {
    walls = [{ id: 'maze_wall_poly_1', points: polyPts }];
  } else {
    throw new Error('poly generation produced insufficient points');
  }
} catch (err) {
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
  goblin: { name: 'Goblin', maxHp: 120, atk: 14, speed: 140, xp: 12, goldMin: 6, goldMax: 14, respawn: 12, radius: 40 },
  wolf:   { name: 'Wolf',   maxHp: 180, atk: 20, speed: 170, xp: 20, goldMin: 12, goldMax: 20, respawn: 18, radius: 40 },
  golem:  { name: 'Golem',  maxHp: 420, atk: 34, speed: 60,  xp: 60, goldMin: 20, goldMax: 40, respawn: 25, radius: 46 }
};

const purpleGridCoords = [
  [-3, 10], [3, 10], [8, 6], [5, 2], [1, -1], [4, -4], [-2, -5], [-6, -3], [-7, 1], [-6, 5], [-1, 4]
];

const mobSpawnPoints = [];
const squareWorld = MAP_SIZE / 20;
for (const [sx, sy] of purpleGridCoords) {
  const wx = sx * squareWorld;
  const wy = sy * squareWorld;
  mobSpawnPoints.push({ x: wx, y: wy, types: ['goblin', 'wolf', 'golem'] });
}

function pointInsideWall(x, y, margin = 6) {
  for (const w of walls) {
    if (w.points && Array.isArray(w.points)) {
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
  const def = mobDefs[typeName];
  if (!def) return null;
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
    mobs.set(id, m);
    return m;
  }
  let fallbackX = sp.x, fallbackY = sp.y;
  let step = 0;
  while (pointInsideWall(fallbackX, fallbackY, 8) && step < 8) {
    fallbackX += (step % 2 === 0 ? 1 : -1) * (def.radius + 20) * (step + 1);
    fallbackY += (step % 3 === 0 ? -1 : 1) * (def.radius + 20) * (step + 1);
    step++;
  }
  const id = 'mob_' + (nextMobId++);
  const m = { id, type: typeName, x: fallbackX, y: fallbackY, vx:0, vy:0, hp:def.maxHp, maxHp:def.maxHp, radius:def.radius, aggroRadius:650, damageContrib: {}, spawnPoint: sp, def, respawnAt: null, dead: false, stunnedUntil: 0 };
  mobs.set(id, m);
  return m;
}

// Spawn initial mobs
for (const sp of mobSpawnPoints) {
  for (let i = 0; i < 5; i++) spawnMobAt(sp, 'goblin');
  for (let i = 0; i < 2; i++) spawnMobAt(sp, 'golem');
  for (let i = 0; i < 3; i++) spawnMobAt(sp, 'wolf');
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
function nowMs() { return Date.now(); }
function randRange(min, max) { return Math.random() * (max - min) + min; }

function bottomLeftSpawn() {
  const x = -MAP_HALF + CELL * 1.5;
  const y = MAP_HALF - CELL * 1.5;
  return { x, y };
}

function randomMapSpawn() {
  // Spawn randomly around the map, avoiding walls
  const limit = MAP_HALF - 50;
  const maxAttempts = 20;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = (Math.random() * 2 - 1) * limit;
    const y = (Math.random() * 2 - 1) * limit;
    
    if (!pointInsideWall(x, y, 50)) {
      return { x, y };
    }
  }
  
  return bottomLeftSpawn();
}

// --- MATCHMAKING HELPERS ---
function createQueue(mode) {
  if (!queues.has(mode)) {
    queues.set(mode, { players: [], createdAt: nowMs(), countdownStartedAt: null, matchId: null });
  }
  return queues.get(mode);
}

function getOrCreateQueue(mode) {
  return createQueue(mode);
}

function broadcastQueueUpdate(mode) {
  const queue = queues.get(mode);
  if (!queue) return;
  const msg = JSON.stringify({
    t: 'queue_update',
    mode,
    players: queue.players.map(p => ({ id: p.id, name: p.name })),
    count: queue.players.length
  });
  for (const p of queue.players) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      try { p.ws.send(msg); } catch (e) {}
    }
  }
}

function addPlayerToQueue(player, mode) {
  if (playerToQueue.has(player.id)) {
    const oldMode = playerToQueue.get(player.id);
    const oldQueue = queues.get(oldMode);
    if (oldQueue) {
      oldQueue.players = oldQueue.players.filter(p => p.id !== player.id);
      broadcastQueueUpdate(oldMode);
    }
  }
  
  const queue = getOrCreateQueue(mode);
  queue.players.push(player);
  playerToQueue.set(player.id, mode);
  
  broadcastQueueUpdate(mode);
  
  if (queue.players.length >= MIN_PLAYERS_TO_START && !queue.countdownStartedAt) {
    startQueueCountdown(mode);
  }
}

function removePlayerFromQueue(playerId) {
  if (!playerToQueue.has(playerId)) return;
  const mode = playerToQueue.get(playerId);
  const queue = queues.get(mode);
  if (queue) {
    queue.players = queue.players.filter(p => p.id !== playerId);
    broadcastQueueUpdate(mode);
    
    if (queue.players.length === 0) {
      queue.countdownStartedAt = null;
    }
  }
  playerToQueue.delete(playerId);
}

function startQueueCountdown(mode) {
  const queue = queues.get(mode);
  if (!queue || queue.countdownStartedAt) return;
  
  queue.countdownStartedAt = nowMs();
  
  const msg = JSON.stringify({
    t: 'match_created',
    mode,
    matchId: `match_${nextMatchId}`,
    countdownMs: QUEUE_COUNTDOWN_MS
  });
  
  for (const p of queue.players) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      try { p.ws.send(msg); } catch (e) {}
    }
  }
}

function updateQueueCountdowns() {
  const now = nowMs();
  
  for (const [mode, queue] of queues.entries()) {
    if (!queue.countdownStartedAt) continue;
    
    const elapsed = now - queue.countdownStartedAt;
    const remaining = Math.max(0, QUEUE_COUNTDOWN_MS - elapsed);
    
    if (elapsed % 1000 < TICK_DT * 1000) {
      const msg = JSON.stringify({
        t: 'match_countdown',
        mode,
        remainingMs: remaining,
        players: queue.players.map(p => ({ id: p.id, name: p.name }))
      });
      
      for (const p of queue.players) {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
          try { p.ws.send(msg); } catch (e) {}
        }
      }
    }
    
    if (remaining <= 0 && queue.players.length >= MIN_PLAYERS_TO_START) {
      createMatchFromQueue(mode);
    }
  }
}

function createMatchFromQueue(mode) {
  const queue = queues.get(mode);
  if (!queue || queue.players.length === 0) return;
  
  const matchId = `match_${nextMatchId++}`;
  const matchPlayers = new Map();
  
  for (const p of queue.players) {
    matchPlayers.set(p.id, p);
    playerToMatch.set(p.id, matchId);
    playerToQueue.delete(p.id);
  }
  
  const match = {
    id: matchId,
    mode,
    players: matchPlayers,
    state: 'loading',
    createdAt: nowMs(),
    countdownStartedAt: null,
    startedAt: null,
    timerAdjusted: false,
    leaderboard: Array.from(matchPlayers.values()).map(p => ({ playerId: p.id, playerName: p.name, kills: 0 }))
  };
  
  matches.set(matchId, match);
  
  queues.delete(mode);
  
  const msg = JSON.stringify({
    t: 'match_start',
    matchId,
    mode,
    mapHalf: MAP_HALF,
    mapSize: MAP_SIZE,
    mapType: MAP_TYPE,
    mapRadius: MAP_HALF,
    tickRate: TICK_RATE,
    matchDurationMs: MATCH_DURATION_MS,
    walls
  });
  
  for (const p of matchPlayers.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.hp = p.maxHp;
      p.kills = 0;
      p.deaths = 0;
      p.xp = 0;
      p.level = 1;
      p.nextLevelXp = 100;
      
      // ✅ RANDOM SPAWN FOR FFA
      let pos;
      if (mode === 'ffa') {
        pos = randomMapSpawn();
      } else {
        pos = bottomLeftSpawn();
      }
      p.x = pos.x;
      p.y = pos.y;
      p.serverX = pos.x;
      p.serverY = pos.y;
      
      try {
        p.ws.send(msg);
      } catch (e) {}
    }
  }
  
  match.startedAt = nowMs();
  match.state = 'in_game';
}

function checkMatchEndConditions() {
  const now = nowMs();
  
  for (const [matchId, match] of matches.entries()) {
    if (match.state !== 'in_game') continue;
    
    const elapsed = now - (match.startedAt || 0);
    const remaining = MATCH_DURATION_MS - elapsed;
    
    // Check if match time ended
    if (remaining <= 0) {
      console.log(`🏁 Match ${matchId} time expired - ending match`);
      endMatch(matchId, 'time_expired');
    }
  }
}

function endMatch(matchId, reason) {
  const match = matches.get(matchId);
  if (!match) return;
  
  match.state = 'ended';
  
  // Sort leaderboard by kills
  const sorted = (match.leaderboard || []).sort((a, b) => (b.kills || 0) - (a.kills || 0));
  
  const msg = JSON.stringify({
    t: 'match_end',
    matchId,
    reason,
    leaderboard: sorted,
    winner: sorted.length > 0 ? sorted[0].playerName : null
  });
  
  for (const p of match.players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      try { p.ws.send(msg); } catch (e) {}
    }
  }
  
  console.log(`✓ Match ${matchId} ended - winner: ${sorted.length > 0 ? sorted[0].playerName : 'N/A'}`);
}

function createPlayerRuntime(ws, opts = {}) {
  const fixedId = opts.id || null;
  const id = fixedId ? String(fixedId) : String(nextPlayerId++);
  const pos = bottomLeftSpawn();
  const color = `hsl(${Math.floor(Math.random()*360)},70%,60%)`;
  const p = {
    id, name: opts.name || ('Player' + id),
    x: pos.x, y: pos.y, vx:0, vy:0, radius:28, color,
    ws, lastInput: { x:0, y:0 }, lastSeen: nowMs(), chatTimestamps: [],
    maxHp: 200, hp: 200, xp: 0, nextLevelXp: 100, level: 1, gold: 0,
    lastAttackTime: 0, attackCooldown: 0.6, baseDamage: 18, invulnerableUntil: 0,
    class: opts.class || 'warrior',
    cooldowns: {},
    baseSpeed: 380,
    buffs: [],
    damageMul: 1.0,
    buffDurationMul: 1.0,
    stunnedUntil: 0,
    equipment: new Array(5).fill(null),
    _baseMaxHp: 200,
    _baseBaseSpeed: 380,
    _baseBaseDamage: 18,
    kills: 0,
    deaths: 0,
    serverX: pos.x,
    serverY: pos.y
  };
  players.set(String(p.id), p);
  return p;
}

function applyEquipmentBonusesForPlayer(player) {
  if (!player) return;
  if (typeof player._baseMaxHp !== 'number') player._baseMaxHp = player.maxHp || 200;
  if (typeof player._baseBaseSpeed !== 'number') player._baseBaseSpeed = player.baseSpeed || 380;
  if (typeof player._baseBaseDamage !== 'number') player._baseBaseDamage = player.baseDamage || 18;

  const bonus = { maxHp: 0, baseDamage: 0, baseSpeed: 0, damageMul: 0, buffDurationMul: 0 };
  const equipArr = Array.isArray(player.equipment) ? player.equipment : [];
  for (const it of equipArr) {
    if (!it || !it.stats) continue;
    const s = it.stats;
    if (typeof s.maxHp === 'number') bonus.maxHp += s.maxHp;
    if (typeof s.baseDamage === 'number') bonus.baseDamage += s.baseDamage;
    if (typeof s.baseSpeed === 'number') bonus.baseSpeed += s.baseSpeed;
    if (typeof s.damageMul === 'number') bonus.damageMul += s.damageMul;
    if (typeof s.buffDurationMul === 'number') bonus.buffDurationMul += s.buffDurationMul;
  }

  const prevMax = player.maxHp || player._baseMaxHp;
  const newMax = Math.max(1, Math.round((player._baseMaxHp || 200) + bonus.maxHp));
  const delta = newMax - prevMax;
  player.maxHp = newMax;
  if (delta > 0) {
    player.hp = Math.min(player.maxHp, (player.hp || prevMax) + delta);
  } else {
    player.hp = Math.min(player.hp || player.maxHp, player.maxHp);
  }

  player.baseDamage = Math.max(0, (player._baseBaseDamage || 18) + bonus.baseDamage);
  player.baseSpeed = Math.max(1, (player._baseBaseSpeed || 380) + bonus.baseSpeed);
  player.damageMul = Math.max(0, 1 + bonus.damageMul);
  player.buffDurationMul = Math.max(0, 1 + bonus.buffDurationMul);
}

// --- HTTP server ---
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Moborr.io server running\n');
    return;
  }
  if (req.method === 'GET' && req.url === '/walls') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(walls));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server });
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : null;

function broadcastToMatch(matchId, obj) {
  const match = matches.get(matchId);
  if (!match) return;
  const msg = JSON.stringify(obj);
  for (const p of match.players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      try { p.ws.send(msg); } catch (e) {}
    }
  }
}

function broadcastToAllMatches(obj) {
  for (const match of matches.values()) {
    broadcastToMatch(match.id, obj);
  }
}

function awardXpToPlayer(player, amount) {
  if (!player) return;
  player.xp = Number(player.xp || 0) + Number(amount || 0);
  let leveled = false;
  let levelUps = 0;
  player.nextLevelXp = player.nextLevelXp || 100;
  while (player.xp >= player.nextLevelXp) {
    const req = player.nextLevelXp;
    player.xp -= req;
    player.level = (player.level || 1) + 1;
    player.maxHp = (player.maxHp || 200) + 50;
    player.hp = Math.min(player.maxHp, (player.hp || player.maxHp) + 50);
    player.nextLevelXp = Math.ceil(req * 1.3);
    levelUps++;
    leveled = true;
    if ((player.level % 5) === 0) {
      player.damageMul = (player.damageMul || 1) * 1.3;
      player.buffDurationMul = (player.buffDurationMul || 1) * 1.1;
    }
  }
  if (leveled) {
    try {
      const matchId = playerToMatch.get(player.id);
      if (matchId) {
        broadcastToMatch(matchId, {
          t: 'player_levelup',
          playerName: player.name,
          level: player.level,
          hpGain: 50 * levelUps,
          newHp: Math.round(player.hp),
          newMaxHp: Math.round(player.maxHp),
          xp: Math.round(player.xp || 0),
          nextLevelXp: Math.round(player.nextLevelXp || 100),
          damageMul: player.damageMul || 1,
          buffDurationMul: player.buffDurationMul || 1
        });
      }
    } catch (e) {}
  }
}

function damageMob(mob, amount, playerId) {
  if (!mob) return;
  if (typeof mob.hp !== 'number') mob.hp = Number(mob.hp) || 0;
  if (mob.hp <= 0) return;
  mob.hp -= amount;
  if (playerId) { mob.damageContrib[playerId] = (mob.damageContrib[playerId] || 0) + amount; }

  const matchId = playerToMatch.get(playerId);
  if (matchId) {
    try {
      broadcastToMatch(matchId, { t: 'mob_hurt', mobId: mob.id, hp: Math.max(0, Math.round(mob.hp)), damage: Math.round(amount), sourceId: playerId || null });
    } catch (e) {}
  }

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
    killer.kills = (killer.kills || 0) + 1;
    awardXpToPlayer(killer, xp);
    
    const matchId = playerToMatch.get(killer.id);
    if (matchId) {
      const match = matches.get(matchId);
      if (match) {
        const entry = match.leaderboard.find(e => e.playerId === killer.id);
        if (entry) entry.kills++;
        broadcastToMatch(matchId, { t:'mob_died', mobId: mob.id, mobType: mob.type, killerId: killer.id, gold, xp, leaderboard: match.leaderboard });
      }
    }
  } else {
    const matchId = Array.from(playerToMatch.values())[0];
    if (matchId) {
      broadcastToMatch(matchId, { t:'mob_died', mobId: mob.id, mobType: mob.type, killerId: null, gold:0, xp:0 });
    }
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
    const matchId = playerToMatch.get(targetPlayer.id);
    if (matchId) {
      broadcastToMatch(matchId, { t: 'player_died', id: targetPlayer.id, killerId: attackerId || null });
    }
  } else {
    const matchId = playerToMatch.get(targetPlayer.id);
    if (matchId) {
      broadcastToMatch(matchId, { t: 'player_hurt', id: targetPlayer.id, hp: Math.round(targetPlayer.hp), source: attackerId || null, damage: Math.round(amount) });
    }
  }
}

function handlePlayerDeath(player, killer) {
  const killerIsPlayer = killer && killer.id && players.has(String(killer.id));
  if (killerIsPlayer) {
    const victim = player;
    const killerP = players.get(String(killer.id));
    const stolen = Math.floor((victim.gold || 0) * 0.05);
    if (stolen > 0) {
      victim.gold = Math.max(0, (victim.gold||0) - stolen);
      killerP.gold = Number(killerP.gold||0) + stolen;
      killerP.kills = (killerP.kills || 0) + 1;
    }
    
    // ✅ UPDATE LEADERBOARD ON PLAYER KILL
    const matchId = playerToMatch.get(killerP.id);
    if (matchId) {
      const match = matches.get(matchId);
      if (match && match.leaderboard) {
        const leaderboardEntry = match.leaderboard.find(e => e.playerId === killerP.id);
        if (leaderboardEntry) {
          leaderboardEntry.kills++;
          console.log(`✅ Updated leaderboard for ${killerP.name}: ${leaderboardEntry.kills} kills`);
        }
      }
    }
  }
  player.hp = 0;
  player.deaths = (player.deaths || 0) + 1;
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

// --- Server tick ---
function serverTick() {
  const now = nowMs();
  
  updateQueueCountdowns();
  checkMatchEndConditions();
  
  for (const [id,m] of mobs.entries()) {
    if (m.hp <= 0 && m.respawnAt && now >= m.respawnAt) {
      mobs.delete(id); const sp = m.spawnPoint; spawnMobAt(sp, m.type);
    }
  }

  for (const m of mobs.values()) {
    if (m.hp <= 0) continue;
    if (m.stunnedUntil && now < m.stunnedUntil) {
      m.vx *= 0.8; m.vy *= 0.8; continue;
    }
    let target = null, bestD = Infinity;
    for (const p of players.values()) {
      if (p.hp <= 0) continue;
      const d = Math.hypot(m.x - p.x, m.y - p.y);
      if (d < m.aggroRadius && d < bestD) { bestD = d; target = p; }
    }
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

  for (const p of players.values()) {
    const nowMsVal = nowMs();
    p.buffs = (p.buffs || []).filter(b => b.until > nowMsVal);
    let speedMultiplier = 1.0; let damageMultiplier = 1.0;
    for (const b of p.buffs) { speedMultiplier *= (b.multiplier || 1); if (b.type === 'damage') damageMultiplier *= (b.multiplier || 1); }

    damageMultiplier = damageMultiplier * (p.damageMul || 1.0);

    if (p.stunnedUntil && nowMsVal < p.stunnedUntil) { p.vx = 0; p.vy = 0; p.lastSeen = now; continue; }

    const inVec = p.lastInput || { x:0, y:0 };
    const speed = (p.baseSpeed || 380) * speedMultiplier;
    const vx = inVec.x * speed, vy = inVec.y * speed;
    p.x += vx * TICK_DT; p.y += vy * TICK_DT;
    p.vx = vx; p.vy = vy;
    const limit = MAP_HALF - p.radius - 1;
    if (p.x > limit) p.x = limit; if (p.x < -limit) p.x = -limit; if (p.y > limit) p.y = limit; if (p.y < -limit) p.y = -limit;
    for (const w of walls) {
      if (w.points && Array.isArray(w.points)) {
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
            let nx = -vy, ny = vx; const nlen = Math.hypot(nx, ny) || 1; nx /= nlen; ny /= nlen;
            const sampleX = cx + nx * 2, sampleY = cy + ny * 2;
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
        const d = Math.hypot(m.x - p.x, m.y - p.y); const range = p.radius + m.radius + 6;
        if (d <= range) {
          if (nowSec - (p.lastAttackTime || 0) >= p.attackCooldown) { p.lastAttackTime = nowSec; const dmg = p.baseDamage * (damageMultiplier || 1.0); damageMob(m, dmg, p.id); }
        }
      }
    } else {
      const pos = bottomLeftSpawn(); p.x = pos.x; p.y = pos.y; p.hp = p.maxHp; p.invulnerableUntil = now + 3000;
    }
    p.lastSeen = now;
  }

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
        if (proj.stunMs) { m.stunnedUntil = now + proj.stunMs; const matchId = playerToMatch.get(proj.ownerId); if (matchId) broadcastToMatch(matchId, { t: 'stun', id: m.id, kind: 'mob', until: m.stunnedUntil, sourceId: proj.ownerId }); }
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
        if (proj.stunMs) { p.stunnedUntil = now + proj.stunMs; const matchId = playerToMatch.get(proj.ownerId); if (matchId) broadcastToMatch(matchId, { t: 'stun', id: p.id, kind: 'player', until: p.stunnedUntil, sourceId: proj.ownerId }); }
        hit = true; break;
      }
    }
    if (hit) { toRemove.push(id); continue; }
  }
  for (const id of toRemove) projectiles.delete(id);

  for (const [matchId, match] of matches.entries()) {
    if (match.state !== 'in_game') continue;
    
    const playerList = Array.from(match.players.values()).map(p => ({ id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), radius: p.radius, color: p.color, hp: Math.round(p.hp), maxHp: p.maxHp, level: p.level, xp: Math.round(p.xp || 0), nextLevelXp: p.nextLevelXp || 100, kills: p.kills || 0 }));
    const mobList = Array.from(mobs.values()).map(m => ({ id: m.id, type: m.type, x: Math.round(m.x), y: Math.round(m.y), hp: Math.round(m.hp), maxHp: Math.round(m.maxHp), radius: m.radius, stunnedUntil: m.stunnedUntil || 0 }));
    const projList = Array.from(projectiles.values()).map(p => ({ id: p.id, type: p.type, x: Math.round(p.x), y: Math.round(p.y), vx: Math.round(p.vx), vy: Math.round(p.vy), radius: p.radius, owner: p.ownerId, ttl: Math.max(0, p.ttl ? Math.round(p.ttl - now) : 0) }));
    
    broadcastToMatch(matchId, { t:'snapshot', tick: now, players: playerList, mobs: mobList, projectiles: projList, walls, leaderboard: match.leaderboard });
  }
}

setInterval(serverTick, Math.round(1000 / TICK_RATE));

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
        const matchId = playerToMatch.get(p.id);
        if (matchId) {
          broadcastToMatch(matchId, { t: 'player_healed', id: p.id, hp: Math.round(p.hp), amount: actual });
        }
      } catch (e) {}
    }
  }
}, HEAL_INTERVAL_MS);

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
      removePlayerFromQueue(id);
      const matchId = playerToMatch.get(id);
      if (matchId) {
        const match = matches.get(matchId);
        if (match) {
          match.players.delete(id);
          if (match.players.size === 0) {
            matches.delete(matchId);
          }
        }
        playerToMatch.delete(id);
      }
      
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
            ws.authenticated = true;
            ws.playerId = p.id;
            
            try {
              ws.send(JSON.stringify({ 
                t:'welcome', 
                id: p.id, 
                mapHalf: MAP_HALF, 
                mapSize: MAP_SIZE, 
                mapType: MAP_TYPE, 
                mapRadius: MAP_HALF, 
                tickRate: TICK_RATE, 
                walls,
                player: { class: p.class, level: p.level, xp: p.xp, nextLevelXp: p.nextLevelXp, maxHp: p.maxHp } 
              }));
            } catch (e) {}
            return;
          } else {
            try { ws.send(JSON.stringify({ t: 'need_join' })); } catch (e) {}
            return;
          }
        }

        const player = players.get(String(ws.playerId));
        if (!player) return;

        if (msg.t === 'join_queue') {
          const mode = String(msg.mode || 'ffa');
          addPlayerToQueue(player, mode);
          return;
        } else if (msg.t === 'cancel_queue') {
          removePlayerFromQueue(player.id);
          return;
        }
        
        const matchId = playerToMatch.get(player.id);
        if (!matchId) return;

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
          broadcastToMatch(matchId, { t: 'chat', name: player.name, text, ts: now, chatId: msg.chatId || null });
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

          let casterDamageMul = Number(player.damageMul || 1.0);
          if (player.buffs && player.buffs.length) {
            for (const b of player.buffs) if (b.type === 'damage') casterDamageMul *= (b.multiplier || 1);
          }

          if (def.kind === 'aoe_stun') {
            const ax = player.x, ay = player.y;
            for (const m of mobs.values()) {
              if (m.hp <= 0) continue;
              const d = Math.hypot(m.x - ax, m.y - ay);
              if (d <= def.radius + (m.radius || 12)) {
                damageMob(m, def.damage * casterDamageMul, player.id);
                m.stunnedUntil = now + (def.stunMs || 3000);
                broadcastToMatch(matchId, { t:'stun', id: m.id, kind: 'mob', until: m.stunnedUntil, sourceId: player.id });
              }
            }
            for (const p of players.values()) {
              if (String(p.id) === String(player.id)) continue;
              if (p.hp <= 0) continue;
              const d = Math.hypot(p.x - ax, p.y - ay);
              if (d <= def.radius + (p.radius || 12)) {
                applyDamageToPlayer(p, def.damage * casterDamageMul, player.id);
                p.stunnedUntil = now + (def.stunMs || 3000);
                broadcastToMatch(matchId, { t:'stun', id: p.id, kind: 'player', until: p.stunnedUntil, sourceId: player.id });
              }
            }
            broadcastToMatch(matchId, { t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type || 'aoe', skill: def.type || 'aoe', x: Math.round(ax), y: Math.round(ay), radius: def.radius, damage: def.damage, buff: null });
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
              broadcastToMatch(matchId, { t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type || 'melee', skill: def.type || 'melee', x: Math.round(player.x), y: Math.round(player.y), range, damage: def.damage });
            } else {
              for (const p2 of players.values()) {
                if (String(p2.id) === String(player.id)) continue;
                if (p2.hp <= 0) continue;
                const d = Math.hypot(p2.x - player.x, p2.y - player.y);
                if (d <= range + (p2.radius || 12) && d < closestD) { closestD = d; closest = p2; }
              }
              if (closest && closest.id) {
                applyDamageToPlayer(closest, def.damage * casterDamageMul, player.id);
                broadcastToMatch(matchId, { t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type || 'melee', skill: def.type || 'melee', x: Math.round(player.x), y: Math.round(player.y), range, damage: def.damage });
              }
            }
          } else if (def.kind === 'buff') {
            const b = def.buff;
            if (b) {
              player.buffs = player.buffs || [];
              const actualDurationMs = Math.round((b.durationMs || 0) * (player.buffDurationMul || 1.0));
              player.buffs.push({ type: b.type, until: now + (actualDurationMs || 0), multiplier: b.multiplier || 1.0 });
              broadcastToMatch(matchId, { t:'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, buff: { type: b.type, multiplier: b.multiplier || 1.0, durationMs: actualDurationMs }, x: Math.round(player.x), y: Math.round(player.y) });
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
            broadcastToMatch(matchId, { t:'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, x: Math.round(player.x), y: Math.round(player.y), targetId });
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
            broadcastToMatch(matchId, { t:'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, x: Math.round(player.x), y: Math.round(player.y) });
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
            broadcastToMatch(matchId, { t:'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, x: Math.round(player.x), y: Math.round(player.y) });
          } else {
            const ax = player.x, ay = player.y;
            for (const m of mobs.values()) {
              if (m.hp <= 0) continue;
              const d = Math.hypot(m.x - ax, m.y - ay);
              if (d <= (def.radius || 48) + (m.radius || 12)) damageMob(m, def.damage * casterDamageMul, player.id);
            }
            for (const p2 of players.values()) {
              if (String(p2.id) === String(player.id)) continue;
              if (p2.hp <= 0) continue;
              const d = Math.hypot(p2.x - ax, p2.y - ay);
              if (d <= (def.radius || 48) + (p2.radius || 12)) applyDamageToPlayer(p2, def.damage * casterDamageMul, player.id);
            }
            broadcastToMatch(matchId, { t:'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, x: Math.round(ax), y: Math.round(ay), radius: def.radius, damage: def.damage });
          }
        } else if (msg.t === 'equip') {
          const slot = Math.max(0, Math.min(5 - 1, Number(msg.slot || 0)));
          const item = (msg.item && typeof msg.item === 'object') ? msg.item : null;
          player.equipment = player.equipment || new Array(5).fill(null);
          if (item) player.equipment[slot] = item;
          else player.equipment[slot] = null;
          applyEquipmentBonusesForPlayer(player);
          try { ws.send(JSON.stringify({ t: 'equip_ack', slot, item: player.equipment[slot] })); } catch (e) {}
        }
      } catch (err) {
        console.error('Error handling WS message:', err);
        try { ws.send(JSON.stringify({ t: 'server_error', error: String(err && err.message ? err.message : err) })); } catch(e){}
      }
    });

    ws.on('close', () => {
      if (ws.playerId) {
        console.log('disconnect', ws.playerId);
        removePlayerFromQueue(ws.playerId);
        const matchId = playerToMatch.get(ws.playerId);
        if (matchId) {
          const match = matches.get(matchId);
          if (match) {
            match.players.delete(ws.playerId);
            if (match.players.size === 0) {
              matches.delete(matchId);
            }
          }
          playerToMatch.delete(ws.playerId);
        }
        players.delete(String(ws.playerId));
      }
    });

    ws.on('error', (err) => {
      if (ws.playerId) {
        removePlayerFromQueue(ws.playerId);
        playerToMatch.delete(ws.playerId);
        players.delete(String(ws.playerId));
      }
    });
  } catch (outerErr) {
    console.error('Unhandled error in connection handler:', outerErr);
    try { ws.close(1011, 'server error'); } catch (e) {}
  }
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
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
process.on('unhandledRejection', (reason, p) => console.error('Unhandled rejection at:', p, 'reason:', reason));

server.listen(PORT, () => { console.log(`Moborr server listening on port ${PORT}`); });

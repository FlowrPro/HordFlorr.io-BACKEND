// Moborr.io — authoritative WebSocket server with matchmaking system
// Supports multiple game modes and isolated match instances

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// --- GAME MODE CONFIG ---
const GAME_MODES = {
  ffa: {
    name: 'Free For All',
    maxPlayers: 10,
    minPlayers: 4, // Minimum to start match
    matchDurationMs: 1800000, // 30 minutes
    countdownMs: 120000 // 2 minutes
  }
};

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

// --- Global IDs ---
let nextPlayerId = 1;
let nextMobId = 1;
let nextProjId = 1;
let nextMatchId = 1;

// --- MATCHMAKING ---
const queues = new Map(); // mode → Queue instance
const matches = new Map(); // matchId → MatchInstance
const players = new Map(); // playerId → player object (tracks globally for websocket management)

// Queue class for managing players waiting for a match
class Queue {
  constructor(mode) {
    this.mode = mode;
    this.players = [];
    this.lastMatchCreatedTime = 0;
  }

  addPlayer(player) {
    if (!this.players.find(p => p.id === player.id)) {
      this.players.push(player);
    }
  }

  removePlayer(playerId) {
    this.players = this.players.filter(p => p.id !== playerId);
  }

  getPlayers() {
    return this.players;
  }

  clear() {
    this.players = [];
  }
}

// Match instance - isolated game world
class MatchInstance {
  constructor(matchId, mode) {
    this.id = matchId;
    this.mode = mode;
    this.config = GAME_MODES[mode];
    this.state = 'COUNTDOWN'; // COUNTDOWN → ACTIVE → FINISHED
    this.players = new Map(); // playerId → player
    this.mobs = new Map();
    this.projectiles = new Map();
    this.walls = [];
    this.map = { type: MAP_TYPE, half: MAP_HALF, size: MAP_SIZE, center: { x: 0, y: 0 }, walls: [] };
    
    this.countdownStartTime = Date.now();
    this.countdownMs = this.config.countdownMs;
    this.matchStartTime = null;
    this.matchDurationMs = this.config.matchDurationMs;
    
    this.createdAt = Date.now();
    this.nextMobId = 1;
    this.nextProjId = 1;

    // Initialize mob spawning for this match
    this.mobSpawnPoints = this.initializeMobSpawns();
    this.spawnInitialMobs();
  }

  initializeMobSpawns() {
    // Same spawn logic as before (reuse from original)
    const purpleGridCoords = [
      [-3, 10], [3, 10], [8, 6], [5, 2], [1, -1],
      [4, -4], [-2, -5], [-6, -3], [-7, 1], [-6, 5], [-1, 4]
    ];
    const squareWorld = MAP_SIZE / 20;
    return purpleGridCoords.map(([sx, sy]) => ({
      x: sx * squareWorld,
      y: sy * squareWorld,
      types: ['goblin', 'wolf', 'golem']
    }));
  }

  spawnInitialMobs() {
    // Spawn mobs per point (same logic as before)
    for (const sp of this.mobSpawnPoints) {
      for (let i = 0; i < 5; i++) this.spawnMobAt(sp, 'goblin');
      for (let i = 0; i < 2; i++) this.spawnMobAt(sp, 'golem');
      for (let i = 0; i < 3; i++) this.spawnMobAt(sp, 'wolf');
    }
  }

  spawnMobAt(sp, typeName) {
    const def = mobDefs[typeName];
    if (!def) return null;
    const jitter = 120 * 3;
    const maxAttempts = 12;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const x = sp.x + (Math.random() * jitter * 2 - jitter);
      const y = sp.y + (Math.random() * jitter * 2 - jitter);
      const limit = MAP_HALF - (def.radius || 18) - 12;
      if (x < -limit || x > limit || y < -limit || y > limit) continue;
      if (this.pointInsideWall(x, y, 8)) continue;
      const id = 'mob_' + (this.nextMobId++);
      const m = {
        id, type: typeName, x, y, vx: 0, vy: 0, hp: def.maxHp, maxHp: def.maxHp,
        radius: def.radius, aggroRadius: 650, damageContrib: {}, spawnPoint: sp,
        def, respawnAt: null, dead: false, stunnedUntil: 0
      };
      this.mobs.set(id, m);
      return m;
    }
    // Fallback
    let fallbackX = sp.x, fallbackY = sp.y;
    let step = 0;
    while (this.pointInsideWall(fallbackX, fallbackY, 8) && step < 8) {
      fallbackX += (step % 2 === 0 ? 1 : -1) * (def.radius + 20) * (step + 1);
      fallbackY += (step % 3 === 0 ? -1 : 1) * (def.radius + 20) * (step + 1);
      step++;
    }
    const id = 'mob_' + (this.nextMobId++);
    const m = {
      id, type: typeName, x: fallbackX, y: fallbackY, vx: 0, vy: 0,
      hp: def.maxHp, maxHp: def.maxHp, radius: def.radius, aggroRadius: 650,
      damageContrib: {}, spawnPoint: sp, def, respawnAt: null, dead: false, stunnedUntil: 0
    };
    this.mobs.set(id, m);
    return m;
  }

  addPlayer(player) {
    this.players.set(String(player.id), player);
    player.matchId = this.id;
    player.kills = 0;
  }

  removePlayer(playerId) {
    this.players.delete(String(playerId));
  }

  getPlayerCount() {
    return this.players.size;
  }

  getCountdownRemainingMs() {
    return Math.max(0, this.countdownMs - (Date.now() - this.countdownStartTime));
  }

  getMatchRemainingMs() {
    if (!this.matchStartTime) return this.matchDurationMs;
    return Math.max(0, this.matchDurationMs - (Date.now() - this.matchStartTime));
  }

  canStart() {
    const remaining = this.getCountdownRemainingMs();
    const playerCount = this.getPlayerCount();
    // Start if countdown done OR we have max players
    return remaining <= 0 || playerCount >= this.config.maxPlayers;
  }

  isFinished() {
    if (this.state !== 'ACTIVE') return false;
    return this.getMatchRemainingMs() <= 0;
  }

  pointInsideWall(x, y, margin = 6) {
    // Reuse wall collision logic
    for (const w of this.walls) {
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

  getRandomSpawnPoint() {
    // Random spawn across map, avoiding walls
    const maxAttempts = 50;
    for (let i = 0; i < maxAttempts; i++) {
      const x = (Math.random() - 0.5) * MAP_SIZE * 0.8;
      const y = (Math.random() - 0.5) * MAP_SIZE * 0.8;
      if (!this.pointInsideWall(x, y, 40)) {
        return { x, y };
      }
    }
    // Fallback to center
    return { x: 0, y: 0 };
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.ws && p.ws.readyState === WebSocket.OPEN) {
        try { p.ws.send(msg); } catch (e) {}
      }
    }
  }

  tick() {
    // Match tick logic (same as before, but scoped to this match)
    const now = Date.now();

    // Respawn mobs
    for (const [id, m] of this.mobs.entries()) {
      if (m.hp <= 0 && m.respawnAt && now >= m.respawnAt) {
        this.mobs.delete(id);
        this.spawnMobAt(m.spawnPoint, m.type);
      }
    }

    // Update mobs
    for (const m of this.mobs.values()) {
      if (m.hp <= 0) continue;
      if (m.stunnedUntil && now < m.stunnedUntil) {
        m.vx *= 0.8; m.vy *= 0.8; continue;
      }
      let target = null, bestD = Infinity;
      for (const p of this.players.values()) {
        if (p.hp <= 0) continue;
        const d = Math.hypot(m.x - p.x, m.y - p.y);
        if (d < m.aggroRadius && d < bestD) { bestD = d; target = p; }
      }
      if (target) {
        const dx = target.x - m.x, dy = target.y - m.y, len = Math.hypot(dx, dy) || 1;
        const spd = m.def.speed;
        m.vx = (dx / len) * spd;
        m.vy = (dy / len) * spd;
        m.x += m.vx * TICK_DT;
        m.y += m.vy * TICK_DT;
        const minDist = m.radius + target.radius + 6;
        if (Math.hypot(m.x - target.x, m.y - target.y) <= minDist) {
          const dmg = m.def.atk * TICK_DT * 0.8;
          if (now >= (target.invulnerableUntil || 0)) {
            target.hp -= dmg;
            if (target.hp <= 0) this.handlePlayerDeath(target, null);
          }
        }
      } else {
        m.vx *= 0.9; m.vy *= 0.9; m.x += m.vx * TICK_DT; m.y += m.vy * TICK_DT;
      }
    }

    // Update players
    for (const p of this.players.values()) {
      const nowMsVal = Date.now();
      p.buffs = (p.buffs || []).filter(b => b.until > nowMsVal);
      let speedMultiplier = 1.0, damageMultiplier = 1.0;
      for (const b of p.buffs) {
        speedMultiplier *= (b.multiplier || 1);
        if (b.type === 'damage') damageMultiplier *= (b.multiplier || 1);
      }
      damageMultiplier = damageMultiplier * (p.damageMul || 1.0);

      if (p.stunnedUntil && nowMsVal < p.stunnedUntil) { p.vx = 0; p.vy = 0; continue; }

      const inVec = p.lastInput || { x: 0, y: 0 };
      const speed = (p.baseSpeed || 380) * speedMultiplier;
      const vx = inVec.x * speed, vy = inVec.y * speed;
      p.x += vx * TICK_DT; p.y += vy * TICK_DT; p.vx = vx; p.vy = vy;

      const limit = MAP_HALF - p.radius - 1;
      if (p.x > limit) p.x = limit;
      if (p.x < -limit) p.x = -limit;
      if (p.y > limit) p.y = limit;
      if (p.y < -limit) p.y = -limit;

      // Wall collision (simplified)
      for (const w of this.walls) {
        if (w.points && Array.isArray(w.points)) {
          let minOverlap = Infinity, push = null;
          for (let i = 0; i < w.points.length; i++) {
            const a = w.points[i];
            const b = w.points[(i + 1) % w.points.length];
            const vx = b.x - a.x, vy = b.y - a.y;
            const wx = p.x - a.x, wy = p.y - a.y;
            const dv = vx * vx + vy * vy;
            let t = dv > 0 ? (wx * vx + wy * vy) / dv : 0;
            t = Math.max(0, Math.min(1, t));
            const cx = a.x + vx * t, cy = a.y + vy * t;
            const dx = p.x - cx, dy = p.y - cy;
            const d = Math.hypot(dx, dy);
            const overlap = p.radius - d;
            if (overlap > 0 && overlap < minOverlap) {
              minOverlap = overlap;
              let nx = -vy, ny = vx;
              const nlen = Math.hypot(nx, ny) || 1;
              nx /= nlen; ny /= nlen;
              let inside = false;
              for (let ii = 0, jj = w.points.length - 1; ii < w.points.length; jj = ii++) {
                const xi = w.points[ii].x, yi = w.points[ii].y;
                const xj = w.points[jj].x, yj = w.points[jj].y;
                const inter = ((yi > cy) !== (yj > cy)) && (cx < (xj - xi) * (cy - yi) / (yj - yi + 0.0) + xi);
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
        }
      }

      // Player auto-attack on mobs
      const nowSec = Date.now() / 1000;
      if (p.hp > 0) {
        for (const m of this.mobs.values()) {
          if (m.hp <= 0) continue;
          const d = Math.hypot(m.x - p.x, m.y - p.y);
          const range = p.radius + m.radius + 6;
          if (d <= range) {
            if (nowSec - (p.lastAttackTime || 0) >= p.attackCooldown) {
              p.lastAttackTime = nowSec;
              const dmg = p.baseDamage * (damageMultiplier || 1.0);
              this.damageMob(m, dmg, p.id);
            }
          }
        }
      }
    }

    // Projectiles
    const toRemove = [];
    for (const [id, proj] of this.projectiles.entries()) {
      const dt = TICK_DT;
      if (!proj) continue;
      if (proj.ttl && now >= proj.ttl) { toRemove.push(id); continue; }
      proj.x += proj.vx * dt; proj.y += proj.vy * dt;
      const limit = MAP_HALF - (proj.radius || 6) - 1;
      if (proj.x > limit) proj.x = limit;
      if (proj.x < -limit) proj.x = -limit;
      if (proj.y > limit) proj.y = limit;
      if (proj.y < -limit) proj.y = -limit;

      let hit = false;
      for (const m of this.mobs.values()) {
        if (m.hp <= 0) continue;
        const d = Math.hypot(proj.x - m.x, proj.y - m.y);
        if (d <= ((proj.radius || 6) + (m.radius || 12))) {
          this.damageMob(m, proj.damage, proj.ownerId);
          if (proj.stunMs) {
            m.stunnedUntil = now + proj.stunMs;
            this.broadcast({ t: 'stun', id: m.id, kind: 'mob', until: m.stunnedUntil, sourceId: proj.ownerId });
          }
          hit = true;
          break;
        }
      }
      if (hit) { toRemove.push(id); continue; }

      for (const p of this.players.values()) {
        if (String(p.id) === String(proj.ownerId)) continue;
        if (p.hp <= 0) continue;
        const d = Math.hypot(proj.x - p.x, proj.y - p.y);
        if (d <= ((proj.radius || 6) + (p.radius || 12))) {
          this.applyDamageToPlayer(p, proj.damage, proj.ownerId);
          if (proj.stunMs) {
            p.stunnedUntil = now + proj.stunMs;
            this.broadcast({ t: 'stun', id: p.id, kind: 'player', until: p.stunnedUntil, sourceId: proj.ownerId });
          }
          hit = true;
          break;
        }
      }
      if (hit) { toRemove.push(id); continue; }
    }
    for (const id of toRemove) this.projectiles.delete(id);

    // Broadcast snapshot
    const playerList = Array.from(this.players.values()).map(p => ({
      id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y),
      vx: Math.round(p.vx), vy: Math.round(p.vy), radius: p.radius, color: p.color,
      hp: Math.round(p.hp), maxHp: p.maxHp, level: p.level, xp: Math.round(p.xp || 0),
      nextLevelXp: p.nextLevelXp || 100, kills: p.kills || 0
    }));
    const mobList = Array.from(this.mobs.values()).map(m => ({
      id: m.id, type: m.type, x: Math.round(m.x), y: Math.round(m.y),
      hp: Math.round(m.hp), maxHp: Math.round(m.maxHp), radius: m.radius, stunnedUntil: m.stunnedUntil || 0
    }));
    const projList = Array.from(this.projectiles.values()).map(p => ({
      id: p.id, type: p.type, x: Math.round(p.x), y: Math.round(p.y),
      vx: Math.round(p.vx), vy: Math.round(p.vy), radius: p.radius, owner: p.ownerId,
      ttl: Math.max(0, p.ttl ? Math.round(p.ttl - now) : 0)
    }));

    // Build leaderboard (sorted by kills)
    const leaderboard = Array.from(this.players.values())
      .map(p => ({ playerId: p.id, playerName: p.name, kills: p.kills || 0 }))
      .sort((a, b) => (b.kills || 0) - (a.kills || 0))
      .slice(0, 10);

    this.broadcast({
      t: 'snapshot', tick: now, players: playerList, mobs: mobList,
      projectiles: projList, walls: this.walls, leaderboard
    });
  }

  damageMob(mob, amount, playerId) {
    if (!mob) return;
    if (typeof mob.hp !== 'number') mob.hp = Number(mob.hp) || 0;
    if (mob.hp <= 0) return;
    mob.hp -= amount;
    if (playerId) { mob.damageContrib[playerId] = (mob.damageContrib[playerId] || 0) + amount; }

    this.broadcast({ t: 'mob_hurt', mobId: mob.id, hp: Math.max(0, Math.round(mob.hp)), damage: Math.round(amount), sourceId: playerId || null });

    if (mob.hp <= 0) {
      if (!mob.respawnAt) this.handleMobDeath(mob, playerId);
    }
  }

  handleMobDeath(mob, killerId = null) {
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
    if (topId && this.players.has(String(topId))) {
      const killer = this.players.get(String(topId));
      killer.gold = Number(killer.gold || 0) + gold;
      this.awardXpToPlayer(killer, xp);
      this.broadcast({ t: 'mob_died', mobId: mob.id, mobType: mob.type, killerId: killer.id, gold, xp });
    } else {
      this.broadcast({ t: 'mob_died', mobId: mob.id, mobType: mob.type, killerId: null, gold: 0, xp: 0 });
    }
    mob.respawnAt = Date.now() + (mob.def.respawn || 10) * 1000;
    mob.hp = 0;
    mob.dead = true;
    mob.damageContrib = {};
  }

  applyDamageToPlayer(targetPlayer, amount, attackerId) {
    if (!targetPlayer || targetPlayer.hp <= 0) return;
    targetPlayer.hp -= amount;
    if (targetPlayer.hp <= 0) {
      this.handlePlayerDeath(targetPlayer, attackerId ? { id: attackerId } : null);
      this.broadcast({ t: 'player_died', id: targetPlayer.id, killerId: attackerId || null });
    } else {
      this.broadcast({ t: 'player_hurt', id: targetPlayer.id, hp: Math.round(targetPlayer.hp), source: attackerId || null, damage: Math.round(amount) });
    }
  }

  handlePlayerDeath(player, killer) {
    if (killer && killer.id && this.players.has(String(killer.id))) {
      const killerP = this.players.get(String(killer.id));
      killerP.kills = (killerP.kills || 0) + 1;
      // Broadcast updated leaderboard
      const leaderboard = Array.from(this.players.values())
        .map(p => ({ playerId: p.id, playerName: p.name, kills: p.kills || 0 }))
        .sort((a, b) => (b.kills || 0) - (a.kills || 0))
        .slice(0, 10);
      this.broadcast({ t: 'leaderboard_update', leaderboard });
    }
    player.hp = 0;
  }

  awardXpToPlayer(player, amount) {
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
        this.broadcast({
          t: 'player_levelup', playerName: player.name, level: player.level,
          hpGain: 50 * levelUps, newHp: Math.round(player.hp), newMaxHp: Math.round(player.maxHp),
          xp: Math.round(player.xp || 0), nextLevelXp: Math.round(player.nextLevelXp || 100),
          damageMul: player.damageMul || 1, buffDurationMul: player.buffDurationMul || 1
        });
      } catch (e) {}
    }
  }
}

// --- Mob definitions ---
const mobDefs = {
  goblin: { name: 'Goblin', maxHp: 120, atk: 14, speed: 140, xp: 12, goldMin: 6, goldMax: 14, respawn: 12, radius: 40 },
  wolf: { name: 'Wolf', maxHp: 180, atk: 20, speed: 170, xp: 20, goldMin: 12, goldMax: 20, respawn: 18, radius: 40 },
  golem: { name: 'Golem', maxHp: 420, atk: 34, speed: 60, xp: 60, goldMin: 20, goldMax: 40, respawn: 25, radius: 46 }
};

// --- Skill definitions ---
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
  warrior: [3500, 7000, 10000, 25000],
  ranger: [2000, 25000, 12000, 4000],
  mage: [2500, 5000, 25000, 10000]
};

// --- Helpers ---
function nowMs() { return Date.now(); }
function randRange(min, max) { return Math.random() * (max - min) + min; }

// --- Build walls (same as original) ---
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
    throw new Error('poly generation failed');
  }
} catch (err) {
  // Fallback rectangular walls
  const h = (col, row, lenCells, id) => ({ id: id || `h_${col}_${row}_${lenCells}`, x: -MAP_HALF + (col - 1) * CELL + GAP, y: -MAP_HALF + (row - 1) * CELL + GAP, w: Math.max(1, lenCells) * CELL - GAP * 2, h: WALL_THICKNESS });
  const v = (col, row, lenCells, id) => ({ id: id || `v_${col}_${row}_${lenCells}`, x: -MAP_HALF + (col - 1) * CELL + GAP, y: -MAP_HALF + (row - 1) * CELL + GAP, w: WALL_THICKNESS, h: Math.max(1, lenCells) * CELL - GAP * 2 });
  const box = (col, row, wCells, hCells, id) => ({ id: id || `box_${col}_${row}_${wCells}x${hCells}`, x: -MAP_HALF + (col - 1) * CELL + GAP, y: -MAP_HALF + (row - 1) * CELL + GAP, w: Math.max(1, wCells) * CELL - GAP * 2, h: Math.max(1, hCells) * CELL - GAP * 2 });
  walls = [
    box(1, 1, 12, 1, 'outer_top'), box(1, 12, 12, 1, 'outer_bottom'),
    box(1, 1, 1, 12, 'outer_left'), box(12, 1, 1, 12, 'outer_right'),
    box(2, 2, 1, 3, 'v_left_1'), box(2, 6, 1, 3, 'v_left_2'), box(2, 10, 1, 2, 'v_left_3'),
    box(3, 2, 4, 1, 'h_top_spiral'), box(6, 3, 1, 3, 'v_spiral_center'),
    box(4, 5, 4, 1, 'h_mid_spiral'), box(6, 1, 1, 12, 'center_bar_full'),
    box(8, 2, 1, 2, 'v_right_1'), box(10, 2, 1, 2, 'v_right_2'),
    box(9, 4, 3, 1, 'h_right_mid_1'), box(8, 6, 1, 3, 'v_right_mid_2'),
    box(10, 9, 1, 2, 'v_right_bottom'), box(3, 8, 2, 1, 'box_lower_left_1'),
    box(2, 9, 1, 2, 'v_lower_left'), box(4, 10, 3, 1, 'h_lower_left'),
    box(7, 9, 2, 1, 'box_lower_center'), box(9, 10, 2, 1, 'box_lower_right'),
    box(11, 8, 1, 2, 'v_lower_right'), box(4, 3, 1, 1, 'island_a'), box(5, 6, 1, 1, 'island_b'),
    box(8, 4, 1, 1, 'island_c'), box(7, 7, 1, 1, 'island_d'),
    box(3, 7, 4, 1, 'h_middle_left'), box(5, 4, 1, 2, 'v_inner_left_connector'),
    box(9, 5, 1, 2, 'v_inner_right_connector'), box(5, 11, 2, 1, 'h_near_bottom_center'),
    box(10, 11, 1, 1, 'h_near_bottom_right'), box(6, 4, 1, 1, 'block_center_1'),
    box(8, 8, 1, 1, 'block_center_2'), box(3, 10, 1, 1, 'block_ll'),
    box(11, 3, 1, 1, 'block_ur'), box(7, 3, 1, 1, 'block_mid_top')
  ];
}

// --- HTTP server ---
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Moborr.io matchmaking server running\n');
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

// --- MATCHMAKING LOOP ---
function processMatchmakingQueue() {
  for (const [mode, queue] of queues.entries()) {
    const playerCount = queue.getPlayers().length;
    
    // Always create a match if we have ANY players and enough time passed
    const now = Date.now();
    const timeSinceLastMatch = now - queue.lastMatchCreatedTime;
    const shouldCreateMatch = playerCount > 0 && (timeSinceLastMatch > 5000 || playerCount >= 10);
    
    if (shouldCreateMatch) {
      const match = new MatchInstance('match_' + (nextMatchId++), mode);
      
      // Add all queued players to this match
      for (const player of queue.getPlayers()) {
        match.addPlayer(player);
        const spawnPoint = match.getRandomSpawnPoint();
        player.x = spawnPoint.x;
        player.y = spawnPoint.y;
        player.hp = player.maxHp;
        player.kills = 0;
        player.matchId = match.id;
      }
      
      match.walls = walls;
      matches.set(match.id, match);
      
      // Notify players about match creation
      match.broadcast({
        t: 'match_created',
        matchId: match.id,
        countdownMs: GAME_MODES[mode].countdownMs,
        players: Array.from(match.players.values()).map(p => ({ id: p.id, name: p.name }))
      });
      
      queue.clear();
      queue.lastMatchCreatedTime = now;
    }
  }

  // Process active matches - check if countdown is over or if not enough players
  for (const [matchId, match] of matches.entries()) {
    if (match.state === 'COUNTDOWN') {
      const countdownRemaining = match.getCountdownRemainingMs();
      
      // Broadcast countdown updates every second
      if (countdownRemaining % 1000 < TICK_DT * 1000 * 2) {
        match.broadcast({
          t: 'match_countdown',
          remainingMs: countdownRemaining,
          players: Array.from(match.players.values()).map(p => ({ id: p.id, name: p.name }))
        });
      }
      
      // Check if we should start or cancel
      if (countdownRemaining <= 0) {
        // Countdown finished - check if we have minimum players
        const playerCount = match.getPlayerCount();
        if (playerCount < GAME_MODES[match.mode].minPlayers) {
          // Not enough players - cancel match and send them back to queue
          for (const p of match.players.values()) {
            try {
              p.ws.send(JSON.stringify({
                t: 'match_cancelled',
                reason: 'insufficient_players',
                message: `Match cancelled: not enough players joined (${playerCount}/${GAME_MODES[match.mode].minPlayers})`
              }));
            } catch (e) {}
            // Re-add to queue
            if (!queues.has(match.mode)) {
              queues.set(match.mode, new Queue(match.mode));
            }
            queues.get(match.mode).addPlayer(p);
          }
          matches.delete(matchId);
        } else {
          // Start the match!
          match.state = 'ACTIVE';
          match.matchStartTime = Date.now();
          match.broadcast({
            t: 'match_start',
            matchId: match.id,
            id: null, // Will be set per-player in welcome
            mapHalf: MAP_HALF,
            mapSize: MAP_SIZE,
            mapType: MAP_TYPE,
            mapRadius: MAP_HALF,
            walls: match.walls,
            matchDurationMs: GAME_MODES[match.mode].matchDurationMs,
            players: Array.from(match.players.values()).map(p => ({
              id: p.id, name: p.name, level: p.level, xp: p.xp, nextLevelXp: p.nextLevelXp, maxHp: p.maxHp
            }))
          });
        }
      }
    } else if (match.state === 'ACTIVE') {
      // Tick the match
      match.tick();
      
      // Check if match is finished
      if (match.isFinished()) {
        // Build results
        const results = Array.from(match.players.values())
          .map(p => ({ id: p.id, name: p.name, kills: p.kills || 0 }))
          .sort((a, b) => (b.kills || 0) - (a.kills || 0))
          .slice(0, 5);
        
        match.broadcast({
          t: 'match_finished',
          matchId: match.id,
          results: results
        });
        
        match.state = 'FINISHED';
      }
    } else if (match.state === 'FINISHED') {
      // Cleanup finished matches after a delay
      if (Date.now() - match.createdAt > 30000) {
        matches.delete(matchId);
      }
    }
  }
}

setInterval(() => {
  for (const [matchId, match] of matches.entries()) {
    if (match.state === 'ACTIVE') {
      match.tick();
    }
  }
}, Math.round(1000 / TICK_RATE));

setInterval(processMatchmakingQueue, 1000);

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
            const name = (msg.name && String(msg.name).slice(0, 24)) || ('Player' + (nextPlayerId++));
            const p = {
              id: String(nextPlayerId++), name, class: (msg.class || 'warrior'), ws,
              x: 0, y: 0, vx: 0, vy: 0, radius: 28, color: `hsl(${Math.floor(Math.random()*360)},70%,60%)`,
              hp: 200, maxHp: 200, xp: 0, nextLevelXp: 100, level: 1, gold: 0,
              lastInput: { x: 0, y: 0 }, lastSeen: nowMs(), chatTimestamps: [],
              lastAttackTime: 0, attackCooldown: 0.6, baseDamage: 18, invulnerableUntil: 0,
              cooldowns: {}, baseSpeed: 380, buffs: [],
              damageMul: 1.0, buffDurationMul: 1.0, stunnedUntil: 0,
              equipment: new Array(5).fill(null),
              _baseMaxHp: 200, _baseBaseSpeed: 380, _baseBaseDamage: 18,
              kills: 0, matchId: null
            };
            players.set(String(p.id), p);
            ws.authenticated = true;
            ws.playerId = p.id;
            try {
              ws.send(JSON.stringify({ t: 'authenticated', id: p.id, name: p.name }));
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
          if (!GAME_MODES[mode]) { try { ws.send(JSON.stringify({ t: 'error', message: 'Invalid mode' })); } catch(e){} return; }
          
          if (!queues.has(mode)) {
            queues.set(mode, new Queue(mode));
          }
          queues.get(mode).addPlayer(player);
          
          // Send queue update to this player
          const queue = queues.get(mode);
          try {
            ws.send(JSON.stringify({
              t: 'queue_update',
              players: queue.getPlayers().map(p => ({ id: p.id, name: p.name }))
            }));
          } catch (e) {}
        } else if (msg.t === 'cancel_queue') {
          // Remove from all queues
          for (const [mode, queue] of queues.entries()) {
            queue.removePlayer(player.id);
          }
        } else if (msg.t === 'input') {
          const input = msg.input;
          if (input && typeof input.x === 'number' && typeof input.y === 'number') {
            let x = Number(input.x), y = Number(input.y);
            if (!isFinite(x) || !isFinite(y)) { player.lastInput = { x: 0, y: 0 }; return; }
            x = Math.max(-1, Math.min(1, x));
            y = Math.max(-1, Math.min(1, y));
            const len = Math.hypot(x, y);
            if (len > 1e-6) { const inv = 1 / Math.max(len, 1); player.lastInput = { x: x * inv, y: y * inv }; } else { player.lastInput = { x: 0, y: 0 }; }
          }
        } else if (msg.t === 'chat') {
          // Chat only works in active matches
          if (!player.matchId || !matches.has(player.matchId)) return;
          const match = matches.get(player.matchId);
          const now = Date.now();
          player.chatTimestamps = (player.chatTimestamps || []).filter(ts => now - ts < CHAT_WINDOW_MS);
          if (player.chatTimestamps.length >= CHAT_MAX_PER_WINDOW) { try { ws.send(JSON.stringify({ t: 'chat_blocked', reason: 'rate_limit', ts: now })); } catch (e) {} return; }
          player.chatTimestamps.push(now);
          let text = String(msg.text || '');
          text = text.replace(/[\r\n]+/g, ' ').slice(0, 240);
          match.broadcast({ t: 'chat', name: player.name, text, ts: now, chatId: msg.chatId || null });
        } else if (msg.t === 'ping') {
          try { ws.send(JSON.stringify({ t: 'pong', ts: msg.ts || Date.now() })); } catch (e) {}
        } else if (msg.t === 'cast') {
          // Cast only in active match
          if (!player.matchId || !matches.has(player.matchId)) return;
          const match = matches.get(player.matchId);
          if (match.state !== 'ACTIVE') return;

          // (Same cast logic as before, but using match.projectiles, etc.)
          const slot = Math.max(1, Math.min(4, Number(msg.slot || 1)));
          const cls = String(msg.class || player.class || 'warrior');
          const now = Date.now();
          player.cooldowns = player.cooldowns || {};
          const cdKey = `s${slot}`;
          const cooldowns = CLASS_COOLDOWNS_MS[cls] || [6000, 6000, 6000, 6000];
          const cdUntil = player.cooldowns[cdKey] || 0;
          if (now < cdUntil) { try { ws.send(JSON.stringify({ t: 'cast_rejected', reason: 'cooldown', slot })); } catch (e) {} return; }
          if (player.hp <= 0) return;
          const defs = SKILL_DEFS[cls] || SKILL_DEFS['warrior'];
          const def = defs[Math.max(0, Math.min(slot - 1, defs.length - 1))];
          if (!def) return;
          const cdMs = cooldowns[Math.max(0, slot - 1)] || 6000;
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
            for (const m of match.mobs.values()) {
              if (m.hp <= 0) continue;
              const d = Math.hypot(m.x - ax, m.y - ay);
              if (d <= def.radius + (m.radius || 12)) {
                match.damageMob(m, def.damage * casterDamageMul, player.id);
                m.stunnedUntil = now + (def.stunMs || 3000);
                match.broadcast({ t: 'stun', id: m.id, kind: 'mob', until: m.stunnedUntil, sourceId: player.id });
              }
            }
            for (const p of match.players.values()) {
              if (String(p.id) === String(player.id)) continue;
              if (p.hp <= 0) continue;
              const d = Math.hypot(p.x - ax, p.y - ay);
              if (d <= def.radius + (p.radius || 12)) {
                match.applyDamageToPlayer(p, def.damage * casterDamageMul, player.id);
                p.stunnedUntil = now + (def.stunMs || 3000);
                match.broadcast({ t: 'stun', id: p.id, kind: 'player', until: p.stunnedUntil, sourceId: player.id });
              }
            }
            match.broadcast({ t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type || 'aoe', skill: def.type || 'aoe', x: Math.round(ax), y: Math.round(ay), radius: def.radius, damage: def.damage, buff: null });
          } else if (def.kind === 'melee') {
            const range = def.range || 48;
            let closest = null, closestD = Infinity;
            for (const m of match.mobs.values()) {
              if (m.hp <= 0) continue;
              const d = Math.hypot(m.x - player.x, m.y - player.y);
              if (d <= range + (m.radius || 12) && d < closestD) { closestD = d; closest = m; }
            }
            if (closest) {
              match.damageMob(closest, def.damage * casterDamageMul, player.id);
              match.broadcast({ t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type || 'melee', skill: def.type || 'melee', x: Math.round(player.x), y: Math.round(player.y), range, damage: def.damage });
            } else {
              for (const p2 of match.players.values()) {
                if (String(p2.id) === String(player.id)) continue;
                if (p2.hp <= 0) continue;
                const d = Math.hypot(p2.x - player.x, p2.y - player.y);
                if (d <= range + (p2.radius || 12) && d < closestD) { closestD = d; closest = p2; }
              }
              if (closest && closest.id) {
                match.applyDamageToPlayer(closest, def.damage * casterDamageMul, player.id);
                match.broadcast({ t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type || 'melee', skill: def.type || 'melee', x: Math.round(player.x), y: Math.round(player.y), range, damage: def.damage });
              }
            }
          } else if (def.kind === 'buff') {
            const b = def.buff;
            if (b) {
              player.buffs = player.buffs || [];
              const actualDurationMs = Math.round((b.durationMs || 0) * (player.buffDurationMul || 1.0));
              player.buffs.push({ type: b.type, until: now + (actualDurationMs || 0), multiplier: b.multiplier || 1.0 });
              match.broadcast({ t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, buff: { type: b.type, multiplier: b.multiplier || 1.0, durationMs: actualDurationMs }, x: Math.round(player.x), y: Math.round(player.y) });
            }
          } else if (def.kind === 'proj_target' || def.kind === 'proj_target_stun') {
            if (!targetId) { try { ws.send(JSON.stringify({ t: 'cast_rejected', reason: 'no_target', slot })); } catch (e) {} return; }
            let targetEnt = null;
            if (match.mobs.has(targetId)) targetEnt = match.mobs.get(targetId);
            else if (match.players.has(targetId)) targetEnt = match.players.get(targetId);
            else { try { ws.send(JSON.stringify({ t: 'cast_rejected', reason: 'invalid_target', slot })); } catch (e) {} return; }
            const tx = targetEnt.x, ty = targetEnt.y;
            const angleToTarget = Math.atan2(ty - player.y, tx - player.x);
            const speed = def.speed || 500;
            const vx = Math.cos(angleToTarget) * speed;
            const vy = Math.sin(angleToTarget) * speed;
            const id = 'proj_' + (match.nextProjId++);
            const ttl = (def.ttlMs ? now + def.ttlMs : now + 3000);
            const proj = { id, type: def.type || 'proj', x: player.x, y: player.y, vx, vy, radius: def.radius || 6, ownerId: player.id, damage: (def.damage || 10) * casterDamageMul, ttl, kind: 'target', targetId: targetId, stunMs: def.stunMs || 0 };
            match.projectiles.set(id, proj);
            match.broadcast({ t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, x: Math.round(player.x), y: Math.round(player.y), targetId });
          } else if (def.kind === 'proj_burst') {
            const aimAngle = (typeof msg.angle === 'number') ? Number(msg.angle) : 0;
            const count = def.count || 3;
            const spread = (def.spreadDeg || 12) * Math.PI / 180;
            for (let n = 0; n < count; n++) {
              const offset = ((n - (count - 1) / 2) / (count - 1)) * spread;
              const angle = aimAngle + offset + (Math.random() * 0.02 - 0.01);
              const speed = def.speed || 500;
              const vx = Math.cos(angle) * speed, vy = Math.sin(angle) * speed;
              const id = 'proj_' + (match.nextProjId++);
              const ttl = (def.ttlMs ? now + def.ttlMs : now + 3000);
              const proj = { id, type: def.type || 'proj', x: player.x, y: player.y, vx, vy, radius: def.radius || 6, ownerId: player.id, damage: (def.damage || 10) * casterDamageMul, ttl, kind: 'burst' };
              match.projectiles.set(id, proj);
            }
            match.broadcast({ t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, x: Math.round(player.x), y: Math.round(player.y) });
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
              const id = 'proj_' + (match.nextProjId++);
              const ttl = (def.ttlMs ? now + def.ttlMs : now + 3000);
              const proj = { id, type: def.type || 'proj', x: player.x, y: player.y, vx, vy, radius: def.radius || 6, ownerId: player.id, damage: (def.damage || 10) * casterDamageMul, ttl, kind: 'arcane' };
              match.projectiles.set(id, proj);
            }
            match.broadcast({ t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, x: Math.round(player.x), y: Math.round(player.y) });
          } else {
            const ax = player.x, ay = player.y;
            for (const m of match.mobs.values()) {
              if (m.hp <= 0) continue;
              const d = Math.hypot(m.x - ax, m.y - ay);
              if (d <= (def.radius || 48) + (m.radius || 12)) match.damageMob(m, def.damage * casterDamageMul, player.id);
            }
            for (const p2 of match.players.values()) {
              if (String(p2.id) === String(player.id)) continue;
              if (p2.hp <= 0) continue;
              const d = Math.hypot(p2.x - ax, p2.y - ay);
              if (d <= (def.radius || 48) + (p2.radius || 12)) match.applyDamageToPlayer(p2, def.damage * casterDamageMul, player.id);
            }
            match.broadcast({ t: 'cast_effect', casterId: player.id, casterName: player.name, type: def.type, skill: def.type, x: Math.round(ax), y: Math.round(ay), radius: def.radius, damage: def.damage });
          }
        }
      } catch (err) {
        console.error('Error handling WS message:', err);
        try { ws.send(JSON.stringify({ t: 'server_error', error: String(err && err.message ? err.message : err) })); } catch (e) {}
      }
    });

    ws.on('close', () => {
      if (ws.playerId) {
        console.log('disconnect', ws.playerId);
        const player = players.get(String(ws.playerId));
        if (player) {
          // Remove from queues
          for (const [mode, queue] of queues.entries()) {
            queue.removePlayer(player.id);
          }
          // Remove from active match if in one
          if (player.matchId && matches.has(player.matchId)) {
            const match = matches.get(player.matchId);
            match.removePlayer(player.id);
          }
        }
        players.delete(String(ws.playerId));
      }
    });

    ws.on('error', (err) => {
      if (ws.playerId) {
        const player = players.get(String(ws.playerId));
        if (player) {
          for (const [mode, queue] of queues.entries()) {
            queue.removePlayer(player.id);
          }
          if (player.matchId && matches.has(player.matchId)) {
            const match = matches.get(player.matchId);
            match.removePlayer(player.id);
          }
        }
        players.delete(String(ws.playerId));
      }
    });
  } catch (outerErr) {
    console.error('Unhandled error in connection handler:', outerErr);
    try { ws.close(1011, 'server error'); } catch (e) {}
  }
});

// Shutdown handlers
function shutdown() {
  console.log('Shutting down...');
  try { wss.close(() => {}); } catch (e) {}
  try { server.close(() => { process.exit(0); }); } catch (e) { process.exit(0); }
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
process.on('unhandledRejection', (reason, p) => console.error('Unhandled rejection at:', p, 'reason:', reason));

server.listen(PORT, () => { console.log(`Moborr matchmaking server listening on port ${PORT}`); });

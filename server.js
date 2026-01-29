// Minimal authoritative game server for Moborr.io (with chat broadcast + rate-limiting + static walls).
// Uses 'ws' WebSocket library. Run with: node server.js
// Listens on process.env.PORT (Render provides this) or 8080 locally.

const http = require('http');
const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;

// --- World / tick ---
const MAP_HALF = 3000;             // half-size of square map (linear ×4 from 750 -> 3000)
const MAP_SIZE = MAP_HALF * 2;     // full side
const MAP_TYPE = 'square';

const TICK_RATE = 20;
const TICK_DT = 1 / TICK_RATE;

// Chat rate limit: max N messages per WINDOW_MS per player
const CHAT_MAX_PER_WINDOW = 2;
const CHAT_WINDOW_MS = 1000; // 1 second

// Wall thickness (8 × player diameter). Player radius = 28 -> diameter = 56 -> thickness = 448
const WALL_THICKNESS = 448;

// Fixed spawn: bottom-left inside the square
const SPAWN_MARGIN = 60; // distance from edges

// --- Static walls (mapped from sketch using 12x12 grid, cell = 500) ---
// Format: { id, x, y, w, h } where x,y are top-left in world coords.
// Outer border walls intentionally REMOVED per request; only keep internal obstacles.
const walls = [
  // inner features approximated from your sketch (aligned to 12x12 grid, cell=500)
  // Left large vertical (~column 1 spanning rows 1..10)
  { id: 'left_big_v', x: -2474, y: -2474, w: WALL_THICKNESS, h: 5000 },

  // Top inner horizontal (columns 2..9 at row 1)
  { id: 'inner_top_h', x: -1974, y: -2474, w: 4000, h: WALL_THICKNESS },

  // Left inner small horizontal near middle (columns 1..3, row 5)
  { id: 'left_mid_h', x: -2474, y: -474, w: 1500, h: WALL_THICKNESS },

  // Left inner vertical (column 3 spanning rows 2..6)
  { id: 'left_inner_v', x: -1474, y: -1974, w: WALL_THICKNESS, h: 2500 },

  // Center box (columns 5..6 rows 3..5)
  { id: 'center_box', x: -474, y: -1474, w: 1000, h: 1500 },

  // Right vertical building (column 9 rows 2..8)
  { id: 'right_building_v', x: 1526, y: -1974, w: WALL_THICKNESS, h: 3500 },

  // Right inner small box (columns 7..8 rows 3..5)
  { id: 'right_inner_box', x: 526, y: -1474, w: 1000, h: 1500 },

  // Bottom central box (columns 4..6 row 9)
  { id: 'bottom_box', x: -974, y: 1526, w: 1500, h: 500 }
];

let nextPlayerId = 1;
const players = new Map();

// Utility
function randRange(min, max) { return Math.random() * (max - min) + min; }

// spawnPosition is fixed bottom-left for everyone
function spawnPosition() {
  const x = -MAP_HALF + SPAWN_MARGIN;
  const y = MAP_HALF - SPAWN_MARGIN;
  return { x, y };
}

function createPlayer(ws) {
  const id = String(nextPlayerId++);
  const pos = spawnPosition();
  const color = `hsl(${Math.floor(Math.random() * 360)},70%,60%)`;
  const p = {
    id,
    name: 'Player' + id,
    x: pos.x,
    y: pos.y,
    vx: 0, vy: 0,
    radius: 28,
    color,
    ws,
    lastInput: { x: 0, y: 0 },
    lastSeen: Date.now(),
    chatTimestamps: []
  };
  players.set(id, p);
  return p;
}

function removePlayer(id) {
  players.delete(id);
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      try { p.ws.send(msg); } catch (e) { /* ignore send errors */ }
    }
  }
}

function broadcastSnapshot() {
  const snapshot = {
    t: 'snapshot',
    tick: Date.now(),
    players: Array.from(players.values()).map(p => ({
      id: p.id,
      name: p.name,
      x: Math.round(p.x),
      y: Math.round(p.y),
      vx: Math.round(p.vx),
      vy: Math.round(p.vy),
      radius: p.radius,
      color: p.color
    }))
  };
  broadcast(snapshot);
}

// Collision: circle (player) vs AABB (rect)
function resolveCircleAABB(p, rect) {
  const rx1 = rect.x;
  const ry1 = rect.y;
  const rx2 = rect.x + rect.w;
  const ry2 = rect.y + rect.h;

  // closest point on AABB to circle center
  const closestX = Math.max(rx1, Math.min(p.x, rx2));
  const closestY = Math.max(ry1, Math.min(p.y, ry2));

  let dx = p.x - closestX;
  let dy = p.y - closestY;
  const distSq = dx * dx + dy * dy;

  if (distSq === 0) {
    // circle center is exactly at a rectangle edge or inside; handle by pushing out along smallest penetration
    const leftDist = Math.abs(p.x - rx1);
    const rightDist = Math.abs(rx2 - p.x);
    const topDist = Math.abs(p.y - ry1);
    const bottomDist = Math.abs(ry2 - p.y);
    const minHoriz = Math.min(leftDist, rightDist);
    const minVert = Math.min(topDist, bottomDist);
    if (minHoriz < minVert) {
      if (leftDist < rightDist) {
        p.x = rx1 - p.radius - 0.1;
      } else {
        p.x = rx2 + p.radius + 0.1;
      }
    } else {
      if (topDist < bottomDist) {
        p.y = ry1 - p.radius - 0.1;
      } else {
        p.y = ry2 + p.radius + 0.1;
      }
    }
    p.vx = 0; p.vy = 0;
    return;
  }

  const dist = Math.sqrt(distSq);
  const overlap = p.radius - dist;
  if (overlap > 0) {
    dx /= dist; dy /= dist;
    p.x += dx * overlap;
    p.y += dy * overlap;
    const vn = p.vx * dx + p.vy * dy;
    if (vn > 0) {
      p.vx -= vn * dx;
      p.vy -= vn * dy;
    }
  }
}

function serverTick() {
  for (const p of players.values()) {
    const inVec = p.lastInput || { x: 0, y: 0 };
    const speed = 380; // keep current speed clamp
    const vx = inVec.x * speed;
    const vy = inVec.y * speed;
    p.x += vx * TICK_DT;
    p.y += vy * TICK_DT;
    p.vx = vx; p.vy = vy;

    // clamp to square bounds around 0
    const limit = MAP_HALF - p.radius - 1;
    if (p.x > limit) p.x = limit;
    if (p.x < -limit) p.x = -limit;
    if (p.y > limit) p.y = limit;
    if (p.y < -limit) p.y = -limit;

    // resolve collisions with walls
    for (const w of walls) resolveCircleAABB(p, w);

    p.lastSeen = Date.now();
  }
  broadcastSnapshot();
}

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Moborr.io server running\n');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('connection from', req.socket.remoteAddress);
  const player = createPlayer(ws);

  // Send welcome including authoritative spawn and walls
  ws.send(JSON.stringify({
    t: 'welcome',
    id: player.id,
    mapHalf: MAP_HALF,
    mapSize: MAP_SIZE,
    mapType: MAP_TYPE,
    tickRate: TICK_RATE,
    spawnX: player.x,
    spawnY: player.y,
    walls // include static walls (array) — no border walls
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (!msg || !msg.t) return;

      if (msg.t === 'join') {
        const name = (msg.name && String(msg.name).slice(0, 24)) || player.name;
        player.name = name;
        ws.send(JSON.stringify({ t: 'joined', id: player.id }));
      } else if (msg.t === 'input') {
        const input = msg.input;
        if (input && typeof input.x === 'number' && typeof input.y === 'number') {
          // sanitize numbers and clamp to [-1,1]
          let x = Number(input.x);
          let y = Number(input.y);
          if (!isFinite(x) || !isFinite(y)) { player.lastInput = { x: 0, y: 0 }; return; }
          x = Math.max(-1, Math.min(1, x));
          y = Math.max(-1, Math.min(1, y));
          // normalize vector to max length 1
          const len = Math.hypot(x, y);
          if (len > 1e-6) {
            const inv = 1 / Math.max(len, 1);
            player.lastInput = { x: x * inv, y: y * inv };
          } else {
            player.lastInput = { x: 0, y: 0 };
          }
        }
      } else if (msg.t === 'chat') {
        // rate limiting: sliding window of CHAT_WINDOW_MS, max CHAT_MAX_PER_WINDOW
        const now = Date.now();
        player.chatTimestamps = (player.chatTimestamps || []).filter(ts => now - ts < CHAT_WINDOW_MS);
        if (player.chatTimestamps.length >= CHAT_MAX_PER_WINDOW) {
          // notify sender that message was blocked by rate limit
          try {
            ws.send(JSON.stringify({ t: 'chat_blocked', reason: 'rate_limit', ts: now }));
          } catch (e) { /* ignore */ }
          return;
        }
        player.chatTimestamps.push(now);

        // sanitize text: remove newlines, clamp length
        let text = String(msg.text || '');
        text = text.replace(/[\r\n]+/g, ' ').slice(0, 240);

        const chat = {
          t: 'chat',
          name: player.name,
          text,
          ts: now
        };
        // include chatId if provided, so clients can correlate and dedupe
        if (msg.chatId) chat.chatId = msg.chatId;

        broadcast(chat);
      } else if (msg.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong', ts: msg.ts || Date.now() }));
      }
    } catch (err) {
      // ignore bad messages
    }
  });

  ws.on('close', () => {
    console.log('disconnect', player.id);
    removePlayer(player.id);
  });

  ws.on('error', (err) => {
    console.warn('ws error', err && err.message);
    removePlayer(player.id);
  });
});

server.listen(PORT, () => {
  console.log(`Moborr server listening on port ${PORT}`);
});

setInterval(serverTick, Math.round(1000 / TICK_RATE));

process.on('SIGINT', () => {
  console.log('Shutting down');
  wss.close(() => server.close(() => process.exit(0)));
});

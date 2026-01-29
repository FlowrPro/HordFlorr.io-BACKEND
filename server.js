// Minimal authoritative game server for Moborr.io (with chat broadcast + rate-limiting + static walls).
// Uses 'ws' WebSocket library. Run with: node server_Version8.js
// Listens on process.env.PORT (Render provides this) or 8080 locally.

const http = require('http');
const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;

// --- World / tick ---
const MAP_HALF = 6000;             // half-size of square map (now 12000 full side)
const MAP_SIZE = MAP_HALF * 2;     // full side = 12000
const MAP_TYPE = 'square';

const TICK_RATE = 20;
const TICK_DT = 1 / TICK_RATE;

// Chat rate limit: max N messages per WINDOW_MS per player
const CHAT_MAX_PER_WINDOW = 2;
const CHAT_WINDOW_MS = 1000; // 1 second

// Wall thickness (keep the same thickness as before)
const WALL_THICKNESS = 448;

// Fixed spawn: bottom-left inside the square (kept bottom-left)
// Small margin so spawn isn't exactly on the border
const SPAWN_MARGIN = 300; // larger than before because the map is larger

let nextPlayerId = 1;
const players = new Map();

// Utility
function randRange(min, max) { return Math.random() * (max - min) + min; }

// Helper: convert grid (12x12) -> world rectangles
const CELL = MAP_SIZE / 12; // 1000 with MAP_SIZE=12000
const GAP = 40; // small inset so walls don't lie exactly on cell boundaries (avoids tiny overlaps)

// Create rectangles using grid coordinates (col,row are 1-based)
function h(col, row, lenCells, id) {
  // horizontal wall: length spans lenCells * CELL, thickness is WALL_THICKNESS (height)
  return {
    id: id || `h_${col}_${row}_${lenCells}`,
    x: -MAP_HALF + (col - 1) * CELL + GAP,
    y: -MAP_HALF + (row - 1) * CELL + GAP,
    w: Math.max(1, lenCells) * CELL - GAP * 2,
    h: WALL_THICKNESS
  };
}
function v(col, row, lenCells, id) {
  // vertical wall: length spans lenCells * CELL, thickness is WALL_THICKNESS (width)
  return {
    id: id || `v_${col}_${row}_${lenCells}`,
    x: -MAP_HALF + (col - 1) * CELL + GAP,
    y: -MAP_HALF + (row - 1) * CELL + GAP,
    w: WALL_THICKNESS,
    h: Math.max(1, lenCells) * CELL - GAP * 2
  };
}
function box(col, row, wCells, hCells, id) {
  return {
    id: id || `box_${col}_${row}_${wCells}x${hCells}`,
    x: -MAP_HALF + (col - 1) * CELL + GAP,
    y: -MAP_HALF + (row - 1) * CELL + GAP,
    w: Math.max(1, wCells) * CELL - GAP * 2,
    h: Math.max(1, hCells) * CELL - GAP * 2
  };
}

// --- Walls: Option I (Mixed Islands + Dense Edge Pockets) scaled to 12000x12000
// We keep WALL_THICKNESS the same and scale positions using the 12x12 grid.
// Outer border walls are intentionally NOT included (so map edges are open).
const walls = [
  // Top edge pockets (left and right)
  h(1, 1, 2, 'top_pocket_left'),
  h(10, 1, 3, 'top_pocket_right'),

  // Top inner islands / small pockets
  box(3, 3, 1, 1, 'island_top_left'),
  box(6, 2, 1, 1, 'island_top_center'),
  box(8, 3, 1, 1, 'island_top_right'),

  // Left-side vertical features (pockets and corridors)
  v(1, 4, 3, 'left_inner_v1'),
  h(2, 5, 3, 'left_mid_h'),

  // Center island cluster
  box(5, 5, 2, 2, 'center_island'),

  // Bottom central islands (not blocking spawn)
  box(4, 9, 2, 1, 'bottom_mid_small'),

  // Right side vertical building and inner boxes
  v(10, 2, 5, 'right_building_v'),
  box(8, 4, 1, 2, 'right_inner_box'),

  // Several perimeter pocket segments along the bottom/right edges (but inset)
  h(2, 12, 2, 'bottom_pocket_left'),
  h(6, 12, 2, 'bottom_pocket_center'),
  v(12, 6, 3, 'right_pocket_vertical'),

  // scattered inner islands to create more pockets (chaotic)
  box(3, 8, 1, 1, 'island_lower_left'),
  box(9, 7, 1, 1, 'island_mid_right'),
  box(7, 9, 1, 1, 'island_bottom_right')
];

// spawnPosition is fixed bottom-left for everyone (inside map, away from edge)
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
    walls // include static walls (array) — interior pockets and islands, no border walls
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

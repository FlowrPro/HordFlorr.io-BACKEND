// Minimal authoritative game server for Moborr.io
// Uses 'ws' WebSocket library. Run with: node server.js
// Listens on process.env.PORT (Render provides this) or 8080 locally.

const http = require('http');
const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;

// World settings (match client)
const MAP_RADIUS = 750;
const TICK_RATE = 20; // ticks per second (authoritative tick)
const TICK_DT = 1 / TICK_RATE;

let nextPlayerId = 1;
const players = new Map(); // id -> player object
// player: { id, name, x, y, vx, vy, radius, color, ws, lastInput: {x,y}, lastSeen }

function randRange(min, max) { return Math.random() * (max - min) + min; }

function spawnPosition() {
  // spawn near center but random
  const r = MAP_RADIUS * 0.5 * Math.sqrt(Math.random());
  const a = Math.random() * Math.PI * 2;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
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
    vx: 0,
    vy: 0,
    radius: 28,
    color,
    ws,
    lastInput: { x: 0, y: 0 },
    lastSeen: Date.now()
  };
  players.set(id, p);
  return p;
}

function removePlayer(id) {
  players.delete(id);
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
  const msg = JSON.stringify(snapshot);
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  }
}

// apply inputs and advance physics per tick
function serverTick() {
  for (const p of players.values()) {
    // simple input is a vector normalized (x,y) where length <= 1
    const inVec = p.lastInput || { x: 0, y: 0 };
    const speed = 380; // should match client speed
    const vx = inVec.x * speed;
    const vy = inVec.y * speed;

    // integrate
    p.x += vx * TICK_DT;
    p.y += vy * TICK_DT;
    p.vx = vx;
    p.vy = vy;

    // clamp to circle map
    const dx = p.x - 0;
    const dy = p.y - 0;
    const dist = Math.hypot(dx, dy);
    const limit = MAP_RADIUS - p.radius - 1;
    if (dist > limit) {
      const k = limit / dist;
      p.x = dx * k;
      p.y = dy * k;
    }

    // housekeeping: drop stale connections later (handled on 'close')
    p.lastSeen = Date.now();
  }

  broadcastSnapshot();
}

// Start HTTP server (needed so Render can route)
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Moborr.io server running\n');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('connection from', req.socket.remoteAddress);
  const player = createPlayer(ws);

  // send welcome with assigned id and constants
  const welcome = {
    t: 'welcome',
    id: player.id,
    mapRadius: MAP_RADIUS,
    tickRate: TICK_RATE
  };
  ws.send(JSON.stringify(welcome));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (!msg || !msg.t) return;

      if (msg.t === 'join') {
        const name = (msg.name && String(msg.name).slice(0, 24)) || player.name;
        player.name = name;
        // send immediate snapshot to new player
        ws.send(JSON.stringify({
          t: 'joined',
          id: player.id
        }));
      } else if (msg.t === 'input') {
        // msg.input: {x,y} normalized vector
        const input = msg.input;
        if (input && typeof input.x === 'number' && typeof input.y === 'number') {
          // clamp length to 1
          const len = Math.hypot(input.x, input.y);
          if (len > 1e-6) {
            player.lastInput = { x: input.x / Math.max(len,1), y: input.y / Math.max(len,1) };
          } else {
            player.lastInput = { x: 0, y: 0 };
          }
        }
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

// run server and tick loop
server.listen(PORT, () => {
  console.log(`Moborr server listening on port ${PORT}`);
});

setInterval(serverTick, Math.round(1000 / TICK_RATE));

// graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down');
  wss.close(() => server.close(() => process.exit(0)));
});
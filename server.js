// Minimal authoritative game server for Moborr.io (with chat broadcast + rate-limiting).
// Uses 'ws' WebSocket library. Run with: node server.js
// Listens on process.env.PORT (Render provides this) or 8080 locally.

const http = require('http');
const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;

const MAP_RADIUS = 750;
const TICK_RATE = 20;
const TICK_DT = 1 / TICK_RATE;

// Chat rate limit: max N messages per WINDOW_MS per player
const CHAT_MAX_PER_WINDOW = 2;
const CHAT_WINDOW_MS = 1000; // 1 second

let nextPlayerId = 1;
const players = new Map();

function randRange(min, max) { return Math.random() * (max - min) + min; }
function spawnPosition() {
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
    vx: 0, vy: 0,
    radius: 28,
    color,
    ws,
    lastInput: { x: 0, y: 0 },
    lastSeen: Date.now(),
    // chat timestamps for rate limiting (array of ms timestamps)
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

function serverTick() {
  for (const p of players.values()) {
    const inVec = p.lastInput || { x: 0, y: 0 };
    const speed = 380; // keep current speed clamp
    const vx = inVec.x * speed;
    const vy = inVec.y * speed;
    p.x += vx * TICK_DT;
    p.y += vy * TICK_DT;
    p.vx = vx; p.vy = vy;
    const dx = p.x - 0; const dy = p.y - 0;
    const dist = Math.hypot(dx, dy);
    const limit = MAP_RADIUS - p.radius - 1;
    if (dist > limit) {
      const k = limit / dist;
      p.x = dx * k;
      p.y = dy * k;
    }
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

  ws.send(JSON.stringify({
    t: 'welcome',
    id: player.id,
    mapRadius: MAP_RADIUS,
    tickRate: TICK_RATE
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

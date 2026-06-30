"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const MAX_CLIENTS = Math.max(2, Number(process.env.MAX_CLIENTS) || 500);
const GAME_FILE = "bloxd_io_lobby_1_simulator_replays_15___1_BASE_CHEST_BACKUPS_FIXED (5).html";
const clients = new Set();
const waiting = [];
let nextPlayerId = 1;
let nextMatchId = 1;

function page(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/health") {
    return page(res, 200, JSON.stringify({
      ok: true,
      players: clients.size,
      queued: waiting.filter(client => !client.closed && client.queued).length
    }), "application/json; charset=utf-8");
  }
  if (url.pathname !== "/" && url.pathname !== "/game") return page(res, 404, "Not found");
  fs.readFile(path.join(__dirname, GAME_FILE), (err, data) => {
    if (err) return page(res, 500, "Game file could not be loaded.");
    page(res, 200, data, "text/html; charset=utf-8");
  });
});

function send(client, data) {
  if (!client || client.closed || !client.socket.writable) return;
  const payload = Buffer.from(JSON.stringify(data));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  client.socket.write(Buffer.concat([header, payload]));
}

function removeFromQueue(client) {
  let index;
  while ((index = waiting.indexOf(client)) !== -1) waiting.splice(index, 1);
  client.queued = false;
}

function cleanName(value, fallback) {
  const text = String(value || "").replace(/[^\w -]/g, "").trim().slice(0, 20);
  return text || fallback;
}

function opponentOf(client) {
  if (!client.match) return null;
  return client.match.players[0] === client ? client.match.players[1] : client.match.players[0];
}

function resetRound(match) {
  if (!match || match.ended || match.players.some(p => p.closed || p.match !== match)) return;
  match.roundActive = true;
  for (const player of match.players) {
    player.hp = 124;
    player.lastHitAt = 0;
    player.state = null;
    send(player, { type: "roundStart", side: player.side, hp: player.hp });
  }
}

function startMatch(a, b) {
  removeFromQueue(a);
  removeFromQueue(b);
  const match = {
    id: nextMatchId++,
    players: [a, b],
    roundActive: true,
    ended: false,
    resetTimer: null
  };
  a.match = match; a.side = 0; a.hp = 124; a.state = null; a.lastHitAt = 0;
  b.match = match; b.side = 1; b.hp = 124; b.state = null; b.lastHitAt = 0;
  send(a, { type: "matched", matchId: match.id, side: 0, opponent: b.name, hp: 124 });
  send(b, { type: "matched", matchId: match.id, side: 1, opponent: a.name, hp: 124 });
}

function tryMatchmake() {
  while (waiting.length >= 2) {
    const a = waiting.shift();
    const b = waiting.shift();
    if (!a || a.closed || a.match) continue;
    if (!b || b.closed || b.match) {
      waiting.unshift(a);
      continue;
    }
    startMatch(a, b);
  }
}

function joinQueue(client) {
  if (client.closed || client.match || client.queued) return;
  client.queued = true;
  waiting.push(client);
  send(client, { type: "queued", position: waiting.length });
  tryMatchmake();
}

function leaveMatch(client, requeueOpponent) {
  const match = client.match;
  if (!match) return;
  match.ended = true;
  if (match.resetTimer) clearTimeout(match.resetTimer);
  const other = opponentOf(client);
  client.match = null;
  client.side = null;
  if (other && other.match === match) {
    other.match = null;
    other.side = null;
    send(other, { type: "opponentLeft" });
    if (requeueOpponent && !other.closed) joinQueue(other);
  }
}

function validState(data) {
  const numbers = ["x", "y", "z", "yaw", "pitch"];
  if (!numbers.every(key => Number.isFinite(data[key]))) return null;
  return {
    x: Math.max(985, Math.min(1015, data.x)),
    y: Math.max(0, Math.min(12, data.y)),
    z: Math.max(985, Math.min(1015, data.z)),
    yaw: data.yaw,
    pitch: Math.max(-1.6, Math.min(1.6, data.pitch)),
    swinging: !!data.swinging
  };
}

function handleMessage(client, data) {
  if (!data || typeof data.type !== "string") return;
  if (data.type === "hello") {
    client.name = cleanName(data.name, `Player${client.id}`);
    send(client, { type: "ready", id: client.id, name: client.name });
    return;
  }
  if (data.type === "queue") return joinQueue(client);
  if (data.type === "cancelQueue") {
    removeFromQueue(client);
    send(client, { type: "queueCancelled" });
    return;
  }
  if (data.type === "leave") {
    removeFromQueue(client);
    leaveMatch(client, true);
    return;
  }
  const match = client.match;
  const other = opponentOf(client);
  if (!match || !other) return;
  if (data.type === "state") {
    const now = Date.now();
    if (now - client.lastStateAt < 20) return;
    const state = validState(data);
    if (!state) return;
    client.lastStateAt = now;
    client.state = state;
    send(other, { type: "opponentState", ...state, hp: client.hp });
    return;
  }
  if (data.type === "hit" && match.roundActive) {
    const now = Date.now();
    if (now - client.lastHitAt < 180 || !client.state || !other.state) return;
    const dx = other.state.x - client.state.x;
    const dz = other.state.z - client.state.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 4.35 || Math.abs(other.state.y - client.state.y) > 2.3) return;
    const aimX = -Math.sin(client.state.yaw);
    const aimZ = -Math.cos(client.state.yaw);
    const dot = distance > 0.001 ? (dx * aimX + dz * aimZ) / distance : 1;
    if (dot < 0.62) return;
    client.lastHitAt = now;
    const kbx = distance > 0.001 ? dx / distance : aimX;
    const kbz = distance > 0.001 ? dz / distance : aimZ;
    other.hp = Math.max(0, other.hp - 6);
    send(other, { type: "damage", amount: 6, hp: other.hp, by: client.name, kbx, kbz });
    send(client, { type: "hitConfirmed", opponentHp: other.hp });
    if (other.hp <= 0) {
      match.roundActive = false;
      send(client, { type: "roundEnd", won: true, winner: client.name });
      send(other, { type: "roundEnd", won: false, winner: client.name });
      match.resetTimer = setTimeout(() => resetRound(match), 3000);
    }
  }
}

function parseFrames(client, chunk) {
  client.alive = true;
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = !!(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      const longLength = client.buffer.readBigUInt64BE(2);
      if (longLength > BigInt(1024 * 1024)) return client.socket.destroy();
      length = Number(longLength);
      offset = 10;
    }
    if (!masked) return client.socket.destroy();
    if (client.buffer.length < offset + 4 + length) return;
    const mask = client.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
    client.buffer = client.buffer.subarray(offset + length);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    if (opcode === 0x8) return client.socket.end();
    if (opcode === 0x9) {
      client.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
      continue;
    }
    if (opcode === 0xA) {
      client.alive = true;
      continue;
    }
    if (opcode !== 0x1) continue;
    try {
      handleMessage(client, JSON.parse(payload.toString("utf8")));
    } catch (_) {}
  }
}

function disconnect(client) {
  if (client.closed) return;
  client.closed = true;
  clients.delete(client);
  removeFromQueue(client);
  leaveMatch(client, true);
}

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/ws" || !key) return socket.destroy();
  if (clients.size >= MAX_CLIENTS) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  const accept = crypto.createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const client = {
    id: nextPlayerId++,
    name: "",
    socket,
    buffer: Buffer.alloc(0),
    queued: false,
    match: null,
    side: null,
    state: null,
    hp: 124,
    lastHitAt: 0,
    lastStateAt: 0,
    alive: true,
    closed: false
  };
  clients.add(client);
  socket.on("data", chunk => parseFrames(client, chunk));
  socket.on("close", () => disconnect(client));
  socket.on("error", () => disconnect(client));
});

// Public proxies and mobile networks can silently drop idle queue connections.
// Protocol-level pings keep them open and remove dead sockets promptly.
const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.socket.destroy();
      continue;
    }
    client.alive = false;
    if (client.socket.writable) client.socket.write(Buffer.from([0x89, 0x00]));
  }
}, 25000);
heartbeat.unref();

function shutdown() {
  clearInterval(heartbeat);
  for (const client of clients) {
    send(client, { type: "serverRestart" });
    client.socket.end();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, HOST, () => {
  console.log(`MULTIBLOXD multiplayer is running at http://localhost:${PORT}`);
  console.log("Open that address in two browsers/computers, then press F6 in both.");
});

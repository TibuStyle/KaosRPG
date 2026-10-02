'use strict';
require('dotenv').config();
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT inválido');
const production = process.env.NODE_ENV === 'production';
if (production && !process.env.FRONTEND_ORIGINS) throw new Error('Configura FRONTEND_ORIGINS');
const origins = new Set((process.env.FRONTEND_ORIGINS ||
  'http://localhost:3000,http://127.0.0.1:3000').split(',').map(s => s.trim()).filter(Boolean));
for (const origin of origins) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin ||
      (production && url.protocol !== 'https:')) throw new Error('Origen inválido: ' + origin);
}
const app = express();
app.disable('x-powered-by');
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (!Number.isInteger(proxyHops) || proxyHops < 0) throw new Error('TRUST_PROXY_HOPS inválido');
if (proxyHops) app.set('trust proxy', proxyHops);
app.use(helmet({
  contentSecurityPolicy: { directives: {
    'script-src': ["'self'", 'https://cdn.socket.io'],
    'connect-src': ["'self'", 'https:', 'wss:'],
    'upgrade-insecure-requests': production ? [] : null
  } },
  strictTransportSecurity: production ? undefined : false
}));
const allowed = origin => !origin || origins.has(origin);
app.use(cors({ origin(origin, callback) { callback(null, allowed(origin)); } }));
app.use(rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false }));
app.get('/health', (_req, res) => res.json({ ok: true, version: '1.2.0' }));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const handshakes = new Map();
const io = new Server(server, {
  cors: { origin(origin, callback) { callback(null, allowed(origin)); }, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 32768,
  // Comprobar también el Origin de conexiones WebSocket (no solo CORS).
  allowRequest(req, callback) {
    const key = req.socket.remoteAddress;
    const now = Date.now();
    let entry = handshakes.get(key);
    if (!entry || now - entry.start > 60000) {
      entry = { start: now, count: 0 }; handshakes.set(key, entry);
    }
    callback(null, allowed(req.headers.origin) && ++entry.count <= 120);
  }
});

const rooms = new Map();
const sessions = new Map();
const ROOM_TTL = 24 * 60 * 60 * 1000;
const GRACE = 15 * 60 * 1000;
const MAX_ROOMS = 1000;
const MAX_PLAYERS = 8; // Además del host.
const choices = {
  magicLevel: ['high', 'low', 'none'],
  adventureTone: ['epic', 'dark', 'comic'],
  turnPace: ['live', 'async'],
  mortality: ['story', 'relentless']
};
function fail(message) { throw new Error(message); }
function text(value, min, max, label) {
  if (typeof value !== 'string' || value.length > max) fail(label + ': longitud inválida.');
  const result = value.trim();
  if (result.length < min) fail(label + ': campo obligatorio.');
  return result;
}
function world(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Configuración inválida.');
  const result = {
    storyName: text(input.storyName, 1, 80, 'Nombre de historia'),
    premise: text(input.premise, 0, 2000, 'Premisa'),
    redLines: text(input.redLines, 0, 4000, 'Líneas rojas')
  };
  for (const [key, values] of Object.entries(choices)) {
    if (!values.includes(input[key])) fail('Regla del mundo inválida.');
    result[key] = input[key];
  }
  return result;
}
function newCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += String.fromCharCode(65 + crypto.randomInt(26));
    if (!rooms.has(code)) return code;
  }
  fail('No se pudo generar código. Inténtalo de nuevo.');
}
function snapshot(room) {
  return {
    code: room.code, world: room.world,
    expiresAt: room.expiresAt,
    members: [...room.members.values()].map(member => ({
      id: member.id, isHost: member.isHost, name: member.name,
      connected: Boolean(member.socketId), ready: Boolean(member.character),
      characterName: member.character ? member.character.name : null
    }))
  };
}
function broadcast(room) { io.to(room.code).emit('room:state', snapshot(room)); }
function current(socket) {
  const session = sessions.get(socket.data.token);
  const room = session && rooms.get(session.code);
  const member = room && room.members.get(session.id);
  if (!room || !member || member.socketId !== socket.id) fail('No tienes una sesión activa.');
  if (room.expiresAt <= Date.now()) { closeRoom(room, 'La sala ha caducado.'); fail('La sala ha caducado.'); }
  return { room, member };
}
function closeRoom(room, reason) {
  io.to(room.code).emit('room:closed', { reason });
  for (const member of room.members.values()) {
    sessions.delete(member.token);
    const socket = io.sockets.sockets.get(member.socketId);
    if (socket) { socket.leave(room.code); delete socket.data.token; }
  }
  rooms.delete(room.code);
}
function removeMember(room, member) {
  if (member.isHost) return closeRoom(room, 'El anfitrión ha cerrado la sala.');
  sessions.delete(member.token);
  room.members.delete(member.id);
  const socket = io.sockets.sockets.get(member.socketId);
  if (socket) { socket.leave(room.code); delete socket.data.token; }
  broadcast(room);
}
function addMember(socket, room, name, isHost) {
  const member = {
    id: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'),
    name, isHost, socketId: socket.id, disconnectedAt: null, character: null
  };
  room.members.set(member.id, member);
  sessions.set(member.token, { code: room.code, id: member.id });
  socket.data.token = member.token;
  socket.join(room.code);
  broadcast(room);
  return { token: member.token, memberId: member.id, isHost, room: snapshot(room) };
}
function unused(socket) {
  if (sessions.has(socket.data.token)) fail('Sal de tu sala actual antes de crear o unirte a otra.');
}

io.on('connection', socket => {
  let bucket = { start: Date.now(), count: 0 };
  function handle(event, handler) {
    socket.on(event, (payload, ack) => {
      if (typeof ack !== 'function') return;
      if (Date.now() - bucket.start >= 60000) bucket = { start: Date.now(), count: 0 };
      if (++bucket.count > 40) return ack({ ok: false, error: 'Demasiadas solicitudes. Espera un minuto.' });
      try { ack({ ok: true, data: handler(payload) }); }
      catch (error) { ack({ ok: false, error: error.message }); }
    });
  }
  handle('room:create', payload => {
    unused(socket);
    if (rooms.size >= MAX_ROOMS) fail('Servidor lleno. Inténtalo más tarde.');
    const config = world(payload && payload.world);
    const name = text(payload && payload.playerName, 1, 40, 'Nombre del host');
    const room = { code: newCode(), world: config, members: new Map(), expiresAt: Date.now() + ROOM_TTL };
    rooms.set(room.code, room);
    return addMember(socket, room, name, true);
  });
  handle('room:join', payload => {
    unused(socket);
    const code = text(payload && payload.code, 6, 6, 'Código').toUpperCase();
    if (!/^[A-Z]{6}$/.test(code)) fail('El código debe tener seis letras A-Z.');
    const name = text(payload && payload.playerName, 1, 40, 'Nombre del jugador');
    const room = rooms.get(code);
    if (!room) fail('La sala no existe.');
    if (room.expiresAt <= Date.now()) { closeRoom(room, 'La sala ha caducado.'); fail('La sala ha caducado.'); }
    if (room.members.size >= MAX_PLAYERS + 1) fail('Sala llena (máximo ocho jugadores).');
    return addMember(socket, room, name, false);
  });
  handle('session:resume', payload => {
    const token = payload && payload.token;
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail('Sesión inválida.');
    const session = sessions.get(token);
    const room = session && rooms.get(session.code);
    const member = room && room.members.get(session.id);
    if (!member || room.expiresAt <= Date.now() ||
        (member.disconnectedAt && Date.now() - member.disconnectedAt >= GRACE)) fail('La sesión ha caducado.');
    if (socket.data.token && socket.data.token !== token) fail('Ya tienes otra sesión activa.');
    const oldSocket = io.sockets.sockets.get(member.socketId);
    member.socketId = socket.id;
    member.disconnectedAt = null;
    socket.data.token = token;
    if (oldSocket && oldSocket.id !== socket.id) {
      oldSocket.emit('session:replaced');
      oldSocket.disconnect(true);
    }
    socket.join(room.code);
    broadcast(room);
    return {
      token, memberId: member.id, isHost: member.isHost,
      room: snapshot(room), character: member.character
    };
  });
  handle('character:submit', payload => {
    const { room, member } = current(socket);
    if (member.isHost) fail('Esta vista de personaje corresponde a jugadores.');
    member.character = {
      name: text(payload && payload.name, 1, 60, 'Nombre del personaje'),
      history: text(payload && payload.history, 1, 6000, 'Historia del personaje')
    };
    broadcast(room);
    // La historia no se incluye en el estado público.
    return { character: member.character };
  });
  handle('room:leave', () => {
    const { room, member } = current(socket);
    removeMember(room, member);
    return {};
  });
  socket.on('disconnect', () => {
    const session = sessions.get(socket.data.token);
    const room = session && rooms.get(session.code);
    const member = room && room.members.get(session.id);
    if (member && member.socketId === socket.id) {
      member.socketId = null;
      member.disconnectedAt = Date.now();
      broadcast(room);
    }
  });
});
const maintenance = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of handshakes) if (now - value.start > 60000) handshakes.delete(key);
  for (const room of rooms.values()) {
    if (room.expiresAt <= now) { closeRoom(room, 'La sala ha caducado (24 horas).'); continue; }
    for (const member of room.members.values()) {
      if (member.disconnectedAt && now - member.disconnectedAt >= GRACE) {
        removeMember(room, member);
        if (member.isHost) break;
      }
    }
  }
}, 30000);
maintenance.unref();
server.listen(PORT, () => console.log(`Crónicas 1.2 escuchando en puerto ${PORT}`));
function shutdown() {
  clearInterval(maintenance);
  for (const room of [...rooms.values()]) closeRoom(room, 'El servidor se está reiniciando.');
  io.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

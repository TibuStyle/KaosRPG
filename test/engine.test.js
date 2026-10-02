// Pruebas aisladas: no red, no dependencias de producción, no coste de API.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function harness(reply, key = 'test-key') {
  const events = [];
  const app = { disable() {}, set() {}, use() {}, get() {} };
  const express = () => app; express.static = () => () => {};
  class Server {
    constructor() { this.sockets = { sockets: new Map() }; }
    on(name, fn) { if (name === 'connection') this.connection = fn; }
    to() { return { emit: (name, data) => events.push({ name, data }) }; }
    close(fn) { fn(); }
  }
  class OpenAI {
    constructor() { this.chat = { completions: { create: reply } }; }
  }
  const modules = {
    dotenv: { config() {} }, 'node:path': path, 'node:crypto': crypto,
    'node:http': { createServer: () => ({ listen() {}, close(fn) { fn(); } }) },
    express, cors: () => () => {}, helmet: () => () => {},
    'express-rate-limit': { rateLimit: () => () => {} }, 'socket.io': { Server }, openai: OpenAI
  };
  const context = vm.createContext({ require: name => modules[name], __dirname: path.join(__dirname, '..'),
    process: { env: { OPENAI_API_KEY: key }, once() {}, exit() {} }, console: { log() {}, warn() {} },
    setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: () => ({ unref() {} }),
    AbortController, URL, Buffer });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8') +
    '\n globalThis.engine = {validateDecision, canStart, snapshot, privateCharacter, evaluateCharacter, rooms, sessions, closeRoom, removeMember, io};', context);
  return { ...context.engine, events };
}
function decision(aprobado = true) {
  return { aprobado, mensaje_narrativo: 'Bienvenido al mundo.',
    perks: aprobado ? [{ nombre: 'Buen Navegante', tipo: 'ventaja' }] : [], defectos: [] };
}
function response(value = decision()) {
  return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] };
}
function roomFixture(engine) {
  const host = { id: 'host', isHost: true, name: 'Host', token: 'h', socketId: 's1', character: null, revision: 0 };
  const player = { id: 'player', isHost: false, name: 'Player', token: 'p', socketId: 's2', character: null,
    gm: null, revision: 0, aiRate: { start: Date.now(), count: 0 } };
  const room = { code: 'ABCDEF', world: { premise: 'Mar', magicLevel: 'none', adventureTone: 'epic', redLines: 'Prohibiciones' },
    expiresAt: Date.now() + 60000, phase: 'lobby', aiRate: { start: Date.now(), count: 0 }, members: new Map([['host', host], ['player', player]]) };
  engine.rooms.set(room.code, room);
  return { room, player, host };
}
const draft = { name: 'Jack', history: 'Soy un marinero sin magia.' };
test('Esquema estricto, enum, listas y rechazo', () => {
  const e = harness(async () => response());
  assert.equal(e.validateDecision(decision()).aprobado, true);
  for (const bad of [ { ...decision(), extra: true }, { ...decision(), aprobado: 'true' },
    { ...decision(), perks: [{ nombre: 'X', tipo: 'desventaja' }] },
    { ...decision(false), perks: decision().perks },
    { ...decision(), perks: [decision().perks[0], decision().perks[0]] },
    { ...decision(), mensaje_narrativo: '' },
    { ...decision(), defectos: Array(5).fill({ nombre: 'X', tipo: 'desventaja' }) } ]) {
    assert.throws(() => e.validateDecision(bad));
  }
});
test('Aprobación guarda rasgos ocultos y envía JSON mode/contexto', async () => {
  let request;
  const e = harness(async params => { request = params; return response(); });
  const { room, player } = roomFixture(e);
  const result = await e.evaluateCharacter(room, player, draft);
  assert.equal(player.character.status, 'approved');
  assert.equal(player.gm.perks[0].nombre, 'Buen Navegante');
  assert.equal(e.canStart(room), true);
  assert.equal(request.response_format.type, 'json_object');
  assert.equal(JSON.parse(request.messages[1].content).mundo.redLines, 'Prohibiciones');
  assert.equal(JSON.parse(request.messages[1].content).personaje.history, draft.history);
  const publicText = JSON.stringify(e.snapshot(room));
  assert.ok(!publicText.includes(draft.history));
  assert.ok(!publicText.includes('Buen Navegante'));
  assert.ok(!JSON.stringify(result).includes('perks'));
  assert.ok(!JSON.stringify(e.privateCharacter(player)).includes('defectos'));
});
test('Rechazo permite corregir y reenviar', async () => {
  let approved = false;
  const e = harness(async () => response(decision(approved)));
  const { room, player } = roomFixture(e);
  await e.evaluateCharacter(room, player, draft);
  assert.equal(player.character.status, 'rejected'); assert.equal(player.gm, null);
  assert.equal(e.canStart(room), false);
  approved = true;
  await e.evaluateCharacter(room, player, { ...draft, history: 'Historia corregida.' });
  assert.equal(player.character.status, 'approved');
});
test('Sin clave no muta personaje; JSON inválido no aprueba', async () => {
  const missing = harness(async () => response(), '');
  const a = roomFixture(missing);
  await assert.rejects(missing.evaluateCharacter(a.room, a.player, draft), /no configurada/);
  assert.equal(a.player.character, null);
  const invalid = harness(async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{mal JSON' } }] }));
  const b = roomFixture(invalid);
  await assert.rejects(invalid.evaluateCharacter(b.room, b.player, draft), /No se pudo/);
  assert.equal(b.player.character.status, 'draft'); assert.equal(b.player.gm, null);
});
test('No aprobar por salida truncada y no conservar aprobación de texto distinto', async () => {
  let malformed = false;
  const e = harness(async () => malformed ? { choices: [{ finish_reason: 'length', message: { content: '{}' } }] } : response());
  const { room, player } = roomFixture(e);
  await e.evaluateCharacter(room, player, draft); malformed = true;
  await assert.rejects(e.evaluateCharacter(room, player, { ...draft, history: 'Otro texto' }));
  assert.equal(player.character.status, 'draft'); assert.equal(player.gm, null);
});
test('Duplicado concurrente bloqueado; cierre descarta respuesta tardía', async () => {
  let release;
  const e = harness(() => new Promise(resolve => { release = resolve; }));
  const { room, player } = roomFixture(e);
  const pending = e.evaluateCharacter(room, player, draft);
  await assert.rejects(e.evaluateCharacter(room, player, draft), /ya está siendo/);
  e.closeRoom(room, 'Cierre'); release(response());
  await assert.rejects(pending, /cancelada/);
  assert.equal(e.rooms.has(room.code), false); assert.equal(player.gm, null);
});
test('Reconexión: terminar evaluación con jugador desconectado conserva resultado', async () => {
  let release;
  const e = harness(() => new Promise(resolve => { release = resolve; }));
  const { room, player } = roomFixture(e);
  const pending = e.evaluateCharacter(room, player, draft);
  player.socketId = null; release(response()); await pending;
  assert.equal(e.privateCharacter(player).status, 'approved');
  assert.equal(e.canStart(room), false); player.socketId = 's3'; assert.equal(e.canStart(room), true);
});
test('Inicio autorizado solo al host, al menos un jugador, fase sincronizada', async () => {
  const e = harness(async () => response());
  const { room, player, host } = roomFixture(e);
  function socket(member) {
    const handlers = {};
    const s = { id: member.socketId, data: { token: member.token }, on: (n, fn) => { handlers[n] = fn; },
      join() {}, leave() {} };
    e.sessions.set(member.token, { code: room.code, id: member.id });
    e.io.connection(s);
    return async event => { let result; await handlers[event]({}, value => { result = value; }); return result; };
  }
  const asPlayer = socket(player); const asHost = socket(host);
  assert.equal((await asHost('adventure:start')).ok, false);
  await e.evaluateCharacter(room, player, draft);
  assert.equal((await asPlayer('adventure:start')).ok, false);
  assert.equal((await asHost('adventure:start')).ok, true);
  assert.equal(room.phase, 'starting'); assert.equal(e.snapshot(room).phase, 'starting');
  assert.equal(e.canStart(room), false);
  room.members.delete(player.id); room.expiresAt = Date.now() + 60000; room.phase = 'lobby';
  assert.equal(e.canStart(room), false);
});

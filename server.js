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
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { generateJSON } = require('./gemini');

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
    'script-src': ["'self'", "'wasm-unsafe-eval'", 'https://cdn.socket.io'],
    'worker-src': ["'self'", 'blob:'],
    'connect-src': ["'self'", 'https:', 'wss:'],
    'upgrade-insecure-requests': production ? [] : null
  } },
  strictTransportSecurity: production ? undefined : false
}));
const allowed = origin => !origin || origins.has(origin);
app.use(cors({ origin(origin, callback) { callback(null, allowed(origin)); } }));
app.use(rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false }));
app.get('/health', (_req, res) => res.json({ ok: true, version: '1.6.0' }));
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

const { openDatabase, recover } = require('./db');
const { validateDecision, MASTER_PROMPT, APPROVAL_SCHEMA } = require('./approval');
const { validateEvaluation,validateRoll,adjustedDC,publicEvaluation,redact,narrative,
  EVALUATION_SCHEMA,RESOLUTION_SCHEMA,EVALUATION_PROMPT,RESOLUTION_PROMPT } = require('./mechanics');
const db = openDatabase();
recover(db); // Única instancia: presencia offline, trabajos interrumpidos recuperables.
const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const apiKey = process.env.GEMINI_API_KEY?.trim();
const ai = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const AI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
// Solo conexiones/trabajos y límites de transporte son efímeros; nunca estado de partida.
const jobs = new Map();
let stopping = false;
function fail(message) { throw new Error(message); }
function text(value, min, max, label) {
  if (typeof value !== 'string' || value.length > max || value.trim().length < min) fail(label + ': longitud inválida.');
  return value.trim();
}
function world(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Configuración inválida.');
  const keys = ['storyName','premise','redLines','magicLevel','adventureTone','mortality'];
  if (Object.keys(input).length !== keys.length || !keys.every(k => Object.hasOwn(input,k))) fail('Configuración inválida: solo reglas vigentes.');
  const result = {
    storyName: text(input.storyName,1,80,'Historia'), premise: text(input.premise,0,2000,'Premisa'),
    redLines: text(input.redLines,0,4000,'Líneas rojas')
  };
  for (const [key, values] of Object.entries({ magicLevel:['high','low','none'], adventureTone:['epic','dark','comic'], mortality:['story','relentless'] })) {
    if (!values.includes(input[key])) fail('Regla del mundo inválida.'); result[key] = input[key];
  }
  return result;
}
function config(room) {
  return { storyName:room.story_name, premise:room.premise, redLines:room.red_lines,
    magicLevel:room.magic_level, adventureTone:room.adventure_tone, mortality:room.mortality };
}
function members(code) {
  return all(`SELECT m.*, c.status AS character_status, c.name AS character_name FROM members m
    LEFT JOIN characters c ON c.member_id=m.id WHERE m.room_code=? ORDER BY m.joined_order`, code);
}
function canStart(room) {
  const players = members(room.code).filter(m => !m.is_host);
  return room.phase === 'lobby' && players.length > 0 && players.every(m => m.socket_id && m.character_status === 'approved');
}
function turn(room) {
  const order = all('SELECT member_id FROM turn_order WHERE room_code=? ORDER BY position',room.code).map(x=>x.member_id);
  const memberId = order.length ? order[room.turn_index % order.length] : null;
  const stored = one('SELECT * FROM actions WHERE room_code=? AND turn_version=?',room.code,room.turn_version);
  const action = stored ? {id:stored.id,status:stored.status,memberId:stored.member_id,stage:stored.stage,
    pendingRoll:stored.pending_roll ? publicEvaluation(JSON.parse(stored.pending_roll)) : null,
    rollResults:stored.roll_results ? JSON.parse(stored.roll_results) : null} : null;
  return { order, memberId, version:room.turn_version, action:action || null };
}
function messages(code, before) {
  return all(`SELECT id,author_name AS authorName,kind,text,created_at AS createdAt FROM messages
    WHERE room_code=? AND id<? ORDER BY id DESC LIMIT 100`,code,before || Number.MAX_SAFE_INTEGER).reverse();
}
function snapshot(room) {
  return { code:room.code,world:config(room),phase:room.phase,canStart:canStart(room),
    members:members(room.code).map(m=>({id:m.id,name:m.name,isHost:Boolean(m.is_host),connected:Boolean(m.socket_id),
      ready:m.character_status==='approved',characterStatus:m.character_status||'draft',characterName:m.character_name||null})),
    turn:turn(room),messages:messages(room.code) };
}
function broadcast(code) { const room=one('SELECT * FROM rooms WHERE code=?',code); if(room) io.to(code).emit('room:state',snapshot(room)); }
function current(socket) {
  const member = socket.data.tokenHash && one(`SELECT m.* FROM members m JOIN sessions s ON s.member_id=m.id
    WHERE s.token_hash=? AND m.socket_id=?`,socket.data.tokenHash,socket.id);
  if(!member) fail('No tienes una sesión activa.');
  const room=one('SELECT * FROM rooms WHERE code=?',member.room_code);
  if(!room) fail('La sala no existe.'); return {room,member};
}
function privateCharacter(id) { return one('SELECT name,history,status,narrative FROM characters WHERE member_id=?',id)||null; }
function unused(socket) { if(socket.data.tokenHash && one('SELECT 1 FROM sessions WHERE token_hash=?',socket.data.tokenHash)) fail('Sal de tu sala actual antes de crear o unirte.'); }
function newCode() {
  for(let n=0;n<100;n++) { let code=''; for(let i=0;i<6;i++) code+=String.fromCharCode(65+crypto.randomInt(26));
    if(!one('SELECT 1 FROM rooms WHERE code=?',code)) return code;
  } fail('No se pudo generar código.');
}
function insertMember(socket,code,name,isHost) {
  const id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');
  const position=one('SELECT COALESCE(MAX(joined_order),-1)+1 AS n FROM members WHERE room_code=?',code).n;
  run('INSERT INTO members(id,room_code,name,is_host,joined_order,socket_id) VALUES(?,?,?,?,?,?)',id,code,name,isHost?1:0,position,socket.id);
  run('INSERT INTO sessions VALUES(?,?,?)',hash(token),id,Date.now());
  return { token,memberId:id,isHost };
}
function attach(socket,data,code) {
  socket.data.tokenHash=hash(data.token); socket.join(code); broadcast(code);
  return {...data,room:snapshot(one('SELECT * FROM rooms WHERE code=?',code)),character:privateCharacter(data.memberId)};
}
function closeRoom(room) {
  for(const m of members(room.code)) jobs.get('character:'+m.id)?.abort();
  for(const a of all("SELECT id FROM actions WHERE room_code=? AND status='pending'",room.code)) jobs.get('action:'+a.id)?.abort();
  const connected=members(room.code).map(m=>m.socket_id);
  db.transaction(()=> {
    for(const m of members(room.code)) run('DELETE FROM rate_limits WHERE key=?','member:'+m.id);
    run('DELETE FROM rate_limits WHERE key=?','room:'+room.code);
    run('DELETE FROM rooms WHERE code=?',room.code);
  })();
  io.to(room.code).emit('room:closed',{reason:'El anfitrión ha cerrado la sala.'});
  for(const id of connected) { const s=io.sockets.sockets.get(id); if(s) { s.leave(room.code); delete s.data.tokenHash; } }
}
function budget(member,room) {
  if(!ai) fail('IA no configurada. Añade GEMINI_API_KEY al backend.');
  if(stopping) fail('Servidor reiniciándose.');
  if(jobs.size>=4) fail('El DM está ocupado. Reintenta en unos segundos.');
  const now=Date.now();
  for(const [key,limit] of [['member:'+member.id,3],['room:'+room.code,10]]) {
    const entry=one('SELECT * FROM rate_limits WHERE key=?',key);
    if(entry && now-entry.start<60000 && entry.count>=limit) fail('Límite de IA alcanzado. Espera un minuto.');
  }
  for(const key of ['member:'+member.id,'room:'+room.code]) {
    const e=one('SELECT * FROM rate_limits WHERE key=?',key);
    run('INSERT OR REPLACE INTO rate_limits VALUES(?,?,?)',key,e && now-e.start<60000 ? e.start:now,e && now-e.start<60000 ? e.count+1:1);
  }
}
async function jsonCompletion(prompt,data,controller,maxTokens=1800,schema=APPROVAL_SCHEMA) {
  return generateJSON(ai,AI_MODEL,prompt,data,controller,maxTokens,schema);
}
async function evaluateCharacter(room,member,draft) {
  const key='character:'+member.id;
  if(jobs.has(key)) fail('Tu personaje ya está siendo evaluado.');
  const previous=privateCharacter(member.id),traits=all('SELECT * FROM traits WHERE member_id=?',member.id);
  const revision=db.transaction(()=> {
    budget(member,room);
    run('UPDATE members SET revision=revision+1 WHERE id=?',member.id);
    run(`INSERT INTO characters VALUES(?,?,?,'evaluating','') ON CONFLICT(member_id) DO UPDATE
      SET name=excluded.name,history=excluded.history,status='evaluating',narrative=''`,member.id,draft.name,draft.history);
    run('DELETE FROM traits WHERE member_id=?',member.id);
    return one('SELECT revision FROM members WHERE id=?',member.id).revision;
  })();
  const controller=new AbortController(); jobs.set(key,controller); broadcast(room.code);
  const valid=()=> one(`SELECT 1 FROM members m JOIN rooms r ON r.code=m.room_code WHERE m.id=? AND m.revision=? AND r.phase='lobby'`,member.id,revision);
  try {
    const result=validateDecision(await jsonCompletion(MASTER_PROMPT,{mundo:config(room),personaje:draft},controller));
    db.transaction(()=> {
      if(!valid()||stopping) fail('Evaluación cancelada.');
      run('UPDATE characters SET status=?,narrative=? WHERE member_id=?',result.aprobado?'approved':'rejected',result.mensaje_narrativo,member.id);
      if(result.aprobado) for(const trait of [...result.perks,...result.defectos]) run('INSERT INTO traits VALUES(?,?,?)',member.id,trait.tipo,trait.nombre);
    })();
    broadcast(room.code); return {character:privateCharacter(member.id)};
  } catch(error) {
    if(valid()) db.transaction(()=> {
      const unchanged=previous && previous.name===draft.name && previous.history===draft.history;
      run('UPDATE characters SET status=?,narrative=? WHERE member_id=?',unchanged?previous.status:'draft',unchanged?previous.narrative:'',member.id);
      run('DELETE FROM traits WHERE member_id=?',member.id);
      if(unchanged) for(const t of traits) run('INSERT INTO traits VALUES(?,?,?)',member.id,t.kind,t.name);
    })();
    broadcast(room.code);
    console.warn('Evaluación IA fallida',{status:Number(error.status)||null});
    fail('No se pudo completar la evaluación. Reintenta; no es un rechazo de tu personaje.');
  } finally { if(jobs.get(key)===controller) jobs.delete(key); }
}
// Estado durable: evaluation -> awaiting_roll -> resolution -> done.
// status mantiene pending/failed/completed para compatibilidad con el motor 1.4.
async function processAction(id) {
  const action=one('SELECT * FROM actions WHERE id=?',id);
  if(!action||action.status!=='pending'||!['evaluation','resolution'].includes(action.stage)) return;
  const key='action:'+id;
  if(jobs.has(key)) return;
  const controller=new AbortController(); jobs.set(key,controller);
  try {
    const room=one('SELECT * FROM rooms WHERE code=?',action.room_code);
    if(!room) return;
    const member=one('SELECT * FROM members WHERE id=?',action.member_id);
    const traits=all('SELECT kind,name FROM traits WHERE member_id=? ORDER BY kind,name',member.id);
    const context=messages(room.code).slice(-20).map(m=>({autor:m.authorName,tipo:m.kind,texto:m.text}));
    let evaluation,narrativeText;
    if(action.stage==='evaluation') {
      const output=await jsonCompletion(EVALUATION_PROMPT,{mundo:config(room),registro:context,
        accion:action.text,es_director:Boolean(member.is_host),rasgos_ocultos:traits},controller,2600,EVALUATION_SCHEMA);
      evaluation=validateEvaluation(output,traits);
      evaluation.narrativa_previa=redact(evaluation.narrativa_previa,traits);
      if(!evaluation.requiere_dado) narrativeText=evaluation.narrativa_previa;
    } else {
      evaluation=JSON.parse(action.pending_roll);
      const roll=validateRoll(JSON.parse(action.roll_results),evaluation);
      const cd=adjustedDC(evaluation);
      const output=await jsonCompletion(RESOLUTION_PROMPT,{mundo:config(room),registro:context,
        accion:action.text,narrativa_previa:evaluation.narrativa_previa,
        tirada:roll,cd_base:evaluation.cd_base,cd_final:cd,
        modificadores:publicEvaluation(evaluation).modificadores,exito:roll.total>=cd},controller,2200,RESOLUTION_SCHEMA);
      if(!output||Array.isArray(output)||Object.keys(output).length!==1||!Object.hasOwn(output,'narrativa')) fail('JSON narrativo inválido.');
      narrativeText=redact(narrative(output.narrativa),traits);
      narrativeText=`Tirada: ${roll.resultados.map(r=>`d${r.caras}=${r.valor}`).join(', ')}. Total ${roll.total} contra CD ${cd}: ${roll.total>=cd?'éxito':'fallo'}.\n\n${narrativeText}`;
    }
    db.transaction(()=> {
      const r=one('SELECT * FROM rooms WHERE code=?',action.room_code),a=one('SELECT * FROM actions WHERE id=?',id);
      if(stopping||!r||!a||a.status!=='pending'||a.stage!==action.stage||r.turn_version!==a.turn_version||turn(r).memberId!==a.member_id) fail('Acción obsoleta.');
      if(action.stage==='evaluation' && evaluation.requiere_dado) {
        run("UPDATE actions SET stage='awaiting_roll',pending_roll=? WHERE id=?",JSON.stringify(evaluation),id);
        // Mensaje preparatorio distinto del mensaje final: no colisiona UNIQUE(action_id,kind).
        run("INSERT INTO messages(room_code,author_name,kind,text,action_id,created_at) VALUES(?,'Director IA','system',?,?,?)",
          r.code,evaluation.narrativa_previa,id,Date.now());
        return; // NO avanzar hasta la consecuencia final.
      }
      run("INSERT INTO messages(room_code,author_name,kind,text,action_id,created_at) VALUES(?,'Director IA','ai',?,?,?)",r.code,narrativeText,id,Date.now());
      run("UPDATE actions SET status='completed',stage='done' WHERE id=?",id);
      run('UPDATE rooms SET turn_index=turn_index+1,turn_version=turn_version+1 WHERE code=?',r.code);
    })();
  } catch(error) {
    run("UPDATE actions SET status='failed' WHERE id=? AND status='pending' AND stage=?",id,action.stage);
    console.warn('Mecánica/narrativa IA fallida',{status:Number(error.status)||null,stage:action.stage});
  } finally { if(jobs.get(key)===controller) jobs.delete(key); broadcast(action.room_code); }
}
io.on('connection',socket=> {
  let bucket={start:Date.now(),count:0};
  function handle(event,handler) {
    socket.on(event,async(payload,ack)=> {
      if(typeof ack!=='function') return;
      if(Date.now()-bucket.start>=60000) bucket={start:Date.now(),count:0};
      if(++bucket.count>40) return ack({ok:false,error:'Demasiadas solicitudes. Espera un minuto.'});
      try { if(stopping) fail('Servidor reiniciándose.'); ack({ok:true,data:await handler(payload)}); }
      catch(error) {
        const databaseError=String(error.code||'').startsWith('SQLITE_');
        if(databaseError) console.warn('Fallo SQLite',{code:error.code});
        ack({ok:false,error:databaseError?'No se pudo guardar. Reintenta más tarde.':error.message});
      }
    });
  }
  handle('room:create',payload=> {
    unused(socket); const w=world(payload?.world),name=text(payload?.playerName,1,40,'Host');
    const result=db.transaction(()=> {
      if(one('SELECT COUNT(*) AS n FROM rooms').n>=1000) fail('Servidor lleno.');
      const code=newCode();
      run('INSERT INTO rooms(code,story_name,premise,red_lines,magic_level,adventure_tone,mortality,created_at) VALUES(?,?,?,?,?,?,?,?)',code,w.storyName,w.premise,w.redLines,w.magicLevel,w.adventureTone,w.mortality,Date.now());
      return {code,data:insertMember(socket,code,name,true)};
    })();
    return attach(socket,result.data,result.code);
  });
  handle('room:join',payload=> {
    unused(socket); const code=text(payload?.code,6,6,'Código').toUpperCase(),name=text(payload?.playerName,1,40,'Jugador');
    if(!/^[A-Z]{6}$/.test(code)) fail('Código inválido.');
    const data=db.transaction(()=> {
      const room=one('SELECT * FROM rooms WHERE code=?',code); if(!room) fail('La sala no existe.');
      if(room.phase!=='lobby') fail('La partida ya ha empezado.');
      if(one('SELECT COUNT(*) AS n FROM members WHERE room_code=?',code).n>=9) fail('Sala llena.');
      return insertMember(socket,code,name,false);
    })(); return attach(socket,data,code);
  });
  handle('session:resume',payload=> {
    const token=payload?.token; if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)) fail('Sesión inválida.');
    const tokenHash=hash(token);
    if(socket.data.tokenHash && socket.data.tokenHash!==tokenHash) fail('Ya tienes otra sesión activa.');
    const m=one('SELECT m.* FROM members m JOIN sessions s ON s.member_id=m.id WHERE s.token_hash=?',tokenHash);
    if(!m) fail('Sesión inválida o sala cerrada.');
    const old=io.sockets.sockets.get(m.socket_id);
    run('UPDATE members SET socket_id=?,disconnected_at=NULL WHERE id=?',socket.id,m.id);
    if(old && old.id!==socket.id) { old.emit('session:replaced'); old.disconnect(true); }
    return attach(socket,{token,memberId:m.id,isHost:Boolean(m.is_host)},m.room_code);
  });
  handle('character:submit',payload=> {
    const {room,member}=current(socket);
    if(member.is_host) fail('Solo jugadores crean personajes.');
    if(room.phase!=='lobby') fail('No puedes editar después de empezar.');
    return evaluateCharacter(room,member,{name:text(payload?.name,1,60,'Personaje'),history:text(payload?.history,1,6000,'Historia')});
  });
  handle('adventure:start',()=> {
    const {room,member}=current(socket);
    if(!member.is_host) fail('Solo el anfitrión puede empezar.');
    db.transaction(()=> {
      const r=one('SELECT * FROM rooms WHERE code=?',room.code);
      if(!canStart(r)) fail('Necesitas al menos un jugador y todos conectados y aprobados.');
      const order=members(room.code).sort((a,b)=>b.is_host-a.is_host || a.joined_order-b.joined_order);
      for(let i=0;i<order.length;i++) run('INSERT INTO turn_order VALUES(?,?,?)',room.code,i,order[i].id);
      run("UPDATE rooms SET phase='playing',turn_index=0,turn_version=0 WHERE code=?",room.code);
      run("INSERT INTO messages(room_code,author_name,kind,text,created_at) VALUES(?,'Sistema','system',?,?)",room.code,
        'La aventura comienza. Cola estricta: Director y jugadores por orden de unión. No hay saltos automáticos.',Date.now());
    })();
    broadcast(room.code); return {room:snapshot(one('SELECT * FROM rooms WHERE code=?',room.code))};
  });
  handle('action:submit',payload=> {
    const {room,member}=current(socket);
    const id=payload?.id,version=payload?.turnVersion;
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)||!Number.isSafeInteger(version)||version<0) fail('Solicitud de acción inválida.');
    const actionText=text(payload?.text,1,2000,'Acción');
    let launch=false;
    const result=db.transaction(()=> {
      const prior=one('SELECT * FROM actions WHERE id=?',id);
      if(prior) {
        if(prior.room_code!==room.code||prior.member_id!==member.id||prior.text!==actionText||prior.turn_version!==version) fail('Identificador de acción reutilizado.');
        return {id:prior.id,status:prior.status};
      }
      const r=one('SELECT * FROM rooms WHERE code=?',room.code);
      if(r.phase!=='playing') fail('La aventura no ha comenzado.');
      if(r.turn_version!==version||turn(r).memberId!==member.id) fail('No es tu turno o tu vista está desactualizada.');
      if(turn(r).action) fail('Tu acción ya está registrada; reintenta su narración si falló.');
      budget(member,r);
      run("INSERT INTO actions(id,room_code,member_id,turn_version,text,status,created_at) VALUES(?,?,?,?,?,'pending',?)",id,r.code,member.id,version,actionText,Date.now());
      run("INSERT INTO messages(room_code,author_id,author_name,kind,text,action_id,created_at) VALUES(?,?,?,'action',?,?,?)",r.code,member.id,member.name,actionText,id,Date.now());
      launch=true; return {id,status:'pending'};
    })();
    if(launch) { broadcast(room.code); void processAction(id); }
    return result;
  });
  handle('action:retry',payload=> {
    const {room,member}=current(socket);
    const id=payload?.id;
    if(typeof id!=='string') fail('Acción inválida.');
    db.transaction(()=> {
      const r=one('SELECT * FROM rooms WHERE code=?',room.code),a=one('SELECT * FROM actions WHERE id=?',id);
      if(!a||a.room_code!==r.code||a.member_id!==member.id||a.turn_version!==r.turn_version||turn(r).memberId!==member.id) fail('No puedes reintentar esta acción.');
      if(a.status!=='failed') fail('La acción no está pendiente de reintento.');
      if(jobs.has('action:'+id)) fail('La solicitud anterior está terminando.');
      budget(member,r); run("UPDATE actions SET status='pending' WHERE id=?",id);
    })(); broadcast(room.code); void processAction(id); return {id,status:'pending'};
  });
  handle('roll:submit',payload=> {
    const {room,member}=current(socket);
    const id=payload?.id,version=payload?.turnVersion;
    if(!payload||Object.keys(payload).length!==4||typeof id!=='string'||!Number.isSafeInteger(version)) fail('Solicitud de tirada inválida.');
    let launch=false;
    const result=db.transaction(()=> {
      const r=one('SELECT * FROM rooms WHERE code=?',room.code),a=one('SELECT * FROM actions WHERE id=?',id);
      if(!a||a.room_code!==r.code||a.member_id!==member.id||a.turn_version!==version||!a.pending_roll) fail('Tirada no autorizada.');
      const accepted=validateRoll({resultados:payload.resultados,total:payload.total},JSON.parse(a.pending_roll));
      const serialized=JSON.stringify(accepted);
      if(a.roll_results) {
        if(a.roll_results!==serialized) fail('Esta acción ya tiene otra tirada guardada.');
        return {id,status:a.status,stage:a.stage}; // ACK perdido: sin API, sin avance extra.
      }
      if(r.phase!=='playing'||r.turn_version!==version||turn(r).memberId!==member.id||a.stage!=='awaiting_roll'||a.status!=='pending') fail('No se espera una tirada tuya.');
      if(jobs.has('action:'+id)) fail('La evaluación anterior está terminando.');
      budget(member,r);
      run("UPDATE actions SET stage='resolution',roll_results=? WHERE id=?",serialized,id);
      launch=true;
      return {id,status:'pending',stage:'resolution'};
    })();
    if(launch) {broadcast(room.code);void processAction(id);}
    return result;
  });
  handle('chat:history',payload=> {
    const {room}=current(socket); const before=payload?.before;
    if(!Number.isSafeInteger(before)||before<=0) fail('Cursor inválido.');
    return {messages:messages(room.code,before)};
  });
  handle('room:leave',()=> {
    const {room,member}=current(socket);
    if(member.is_host) { closeRoom(room); return {}; }
    if(room.phase==='playing') fail('La cola es fija: desconéctate para ausentarte; tu turno se conserva.');
    jobs.get('character:'+member.id)?.abort();
    db.transaction(()=> {
      run('DELETE FROM members WHERE id=?',member.id);
      run('DELETE FROM rate_limits WHERE key=?','member:'+member.id);
    })();
    socket.leave(room.code); delete socket.data.tokenHash; broadcast(room.code); return {};
  });
  socket.on('disconnect',()=> {
    const m=socket.data.tokenHash && one('SELECT m.* FROM members m JOIN sessions s ON s.member_id=m.id WHERE s.token_hash=?',socket.data.tokenHash);
    if(m && m.socket_id===socket.id) {
      run('UPDATE members SET socket_id=NULL,disconnected_at=? WHERE id=?',Date.now(),m.id); broadcast(m.room_code);
    }
  });
});
const maintenance=setInterval(()=> {
  const now=Date.now();
  for(const [key,value] of handshakes) if(now-value.start>60000) handshakes.delete(key);
  run('DELETE FROM rate_limits WHERE start<?',now-60000);
},30000);
maintenance.unref();
server.listen(PORT,()=>console.log(`Crónicas 1.5 escuchando en puerto ${PORT}; SQLite persistente`));
function shutdown() {
  if(stopping) return; stopping=true; clearInterval(maintenance);
  for(const controller of jobs.values()) controller.abort();
  // Nunca cerrar/eliminar salas al apagar. recover() recupera trabajos interrumpidos.
  io.close(()=> { db.close(); process.exit(0); });
  setTimeout(()=>process.exit(1),10000).unref();
}
process.once('SIGTERM',shutdown); process.once('SIGINT',shutdown);

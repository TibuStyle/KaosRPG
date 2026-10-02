'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort() {
  const s=net.createServer(); await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
  const port=s.address().port; await new Promise(resolve=>s.close(resolve)); return port;
}
function launch(port,file) {
  const proc=spawn(process.execPath,[path.join(__dirname,'mock-server.cjs')],{
    env:{...process.env,PORT:String(port),SQLITE_PATH:file,NODE_ENV:'development',POLLINATIONS_ENABLED:'false',GEMINI_API_KEY:'mock-only',
      FRONTEND_ORIGINS:`http://localhost:${port}`,TRUST_PROXY_HOPS:'0'},stdio:['ignore','pipe','pipe']
  });
  const ready=new Promise((resolve,reject)=> {
    let log=''; const timeout=setTimeout(()=>{proc.kill();reject(new Error('Inicio agotado: '+log));},10000);
    proc.stdout.on('data',buffer=> {log+=buffer; if(log.includes('Crónicas 1.8 escuchando')) {clearTimeout(timeout);resolve();}});
    proc.stderr.on('data',buffer=>{log+=buffer;});
    proc.once('exit',code=>{clearTimeout(timeout);reject(new Error('Servidor terminó: '+code+' '+log));});
  });
  return {proc,ready};
}
async function stop(proc) {
  if(proc.exitCode!==null) return;
  const ended=new Promise(resolve=>proc.once('exit',resolve)); proc.kill('SIGTERM'); await ended;
}
async function client(port) {
  const s=io(`http://127.0.0.1:${port}`,{autoConnect:false,reconnection:false});
  await new Promise((resolve,reject)=>{s.once('connect',resolve);s.once('connect_error',reject);s.connect();}); return s;
}
function req(s,event,payload={}) {
  return new Promise((resolve,reject)=>s.timeout(6000).emit(event,payload,(error,response)=> {
    if(error) reject(error); else resolve(response);
  }));
}
async function until(fn) {for(let i=0;i<100;i++){const result=await fn();if(result)return result;await delay(30);}throw new Error('Condición agotada');}


test('Kit GM: premisa real mock, rechazo persistente, permisos NPC, cola y wipe',async()=> {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cronicas-kit-')),file=path.join(dir,'game.sqlite'),port=await freePort();
 let server;const sockets=[];
 try {
  server=launch(port,file);await server.ready;
  const host=await client(port),p=await client(port),outsider=await client(port);sockets.push(host,p,outsider);
  const world={storyName:'Fortaleza',premise:'',redLines:'',magicLevel:'low',adventureTone:'dark',mortality:'story'};
  assert.equal((await req(host,'premise:generate',{world})).data.premise.split('\n\n').length,3);
  const h=(await req(host,'room:create',{playerName:'Director',world})).data;
  const a=(await req(p,'room:join',{playerName:'Jugador',code:h.room.code})).data;
  assert.equal((await req(p,'npc:add',{name:'Intruso',history:'Historia'})).ok,false);
  assert.equal((await req(outsider,'npc:add',{name:'Intruso',history:'Historia'})).ok,false);
  assert.equal((await req(p,'room:wipe',{confirmCode:h.room.code})).ok,false);
  assert.equal((await req(host,'room:wipe',{confirmCode:'BADBAD'})).ok,false);
  const rejected=await req(p,'character:submit',{name:'Jugador',history:'SIN_BALANCE',appearance:'',publicConsent:true,portraitConsent:true});
  assert.equal(rejected.data.character.status,'rejected');assert.ok(rejected.data.character.motivo_rechazo_narrativo.includes('arma extrema'));
  assert.equal((await req(p,'session:resume',{token:a.token})).data.character.motivo_rechazo_narrativo,rejected.data.character.motivo_rechazo_narrativo);
  assert.equal((await req(p,'character:submit',{name:'Jugador',history:'Historia equilibrada',appearance:'',publicConsent:true,portraitConsent:true})).ok,true);
  const n=(await req(host,'npc:add',{name:'Centinela',history:'Guarda la puerta.'})).data.memberId;
  assert.equal((await req(host,'adventure:start')).ok,true);
  assert.equal((await req(host,'action:submit',{id:crypto.randomUUID(),turnVersion:0,text:'Inicio'})).ok,true);
  await until(async()=> (await req(host,'session:resume',{token:h.token})).data.room.turn.version===1);
  assert.equal((await req(host,'action:submit',{id:crypto.randomUUID(),turnVersion:1,text:'Suplantar humano',memberId:a.memberId})).ok,false);
  assert.equal((await req(p,'action:submit',{id:crypto.randomUUID(),turnVersion:1,text:'Continúo'})).ok,true);
  await until(async()=> (await req(host,'session:resume',{token:h.token})).data.room.turn.memberId===n);
  assert.equal((await req(p,'action:submit',{id:crypto.randomUUID(),turnVersion:2,text:'Suplantar NPC',memberId:n})).ok,false);
  const id=crypto.randomUUID(),npcAction={id,turnVersion:2,text:'El centinela saluda.',memberId:n};
  assert.equal((await req(host,'action:submit',npcAction)).ok,true);
  await until(async()=> (await req(host,'session:resume',{token:h.token})).data.room.turn.version===3);
  assert.equal((await req(host,'action:submit',npcAction)).ok,true);
  // En segunda vuelta, añadir NPC no cambia al dueño actual ni la versión.
  await req(host,'action:submit',{id:crypto.randomUUID(),turnVersion:3,text:'Segunda vuelta'});
  await until(async()=> (await req(host,'session:resume',{token:h.token})).data.room.turn.version===4);
  const n2=(await req(host,'npc:add',{name:'Viajero',history:'Busca ayuda.'})).data.memberId;
  const room=(await req(host,'session:resume',{token:h.token})).data.room;
  assert.equal(room.turn.memberId,a.memberId);assert.equal(room.turn.version,4);assert.deepEqual(room.turn.order,[h.memberId,a.memberId,n,n2]);
  for(const s of sockets)s.disconnect();await stop(server.proc);
  server=launch(port,file);await server.ready;
  const host2=await client(port),p2=await client(port);sockets.push(host2,p2);
  const resumed=(await req(host2,'session:resume',{token:h.token})).data;
  assert.equal(resumed.room.turn.memberId,a.memberId);assert.ok(resumed.room.members.find(x=>x.id===n).isNPC);
  assert.equal((await req(p2,'session:resume',{token:a.token})).ok,true);
  const closed=new Promise(resolve=>p2.once('room:closed',resolve));
  assert.equal((await req(host2,'room:wipe',{confirmCode:h.room.code})).ok,true);await closed;
  assert.equal((await req(p2,'session:resume',{token:a.token})).ok,false);
  const Database=require('better-sqlite3'),db=new Database(file);
  try {for(const table of ['rooms','members','characters','traits','sessions','actions','messages','turn_order','social_messages','character_states'])assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0);}
  finally{db.close();}
 }finally{for(const s of sockets)s.disconnect();if(server)await stop(server.proc);fs.rmSync(dir,{recursive:true,force:true});}
});

test('NPC arriesgado: tirada, fallo recuperable, retry Host e idempotencia',async()=> {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cronicas-npc-roll-')),file=path.join(dir,'game.sqlite'),port=await freePort();
 let server;const sockets=[];
 try {
  server=launch(port,file);await server.ready;
  const host=await client(port),other=await client(port);sockets.push(host,other);
  const world={storyName:'Prueba',premise:'',redLines:'',magicLevel:'low',adventureTone:'dark',mortality:'story'};
  const h=(await req(host,'room:create',{playerName:'Director',world})).data;
  const o=(await req(other,'room:create',{playerName:'Otro Director',world})).data;
  const n=(await req(host,'npc:add',{name:'Guardia',history:'Protege el puente.'})).data.memberId;
  assert.equal((await req(host,'adventure:start')).ok,true);
  await req(host,'action:submit',{id:crypto.randomUUID(),turnVersion:0,text:'Inicio'});
  await until(async()=> (await req(host,'session:resume',{token:h.token})).data.room.turn.version===1);
  const id=crypto.randomUUID();
  assert.equal((await req(host,'action:submit',{id,turnVersion:1,text:'ARRIESGADA',memberId:n})).ok,true);
  await until(async()=> (await req(host,'session:resume',{token:h.token})).data.room.turn.action?.stage==='awaiting_roll');
  const roll={id,turnVersion:1,memberId:n,resultados:[{caras:20,valor:12},{caras:6,valor:3},{caras:6,valor:4}],total:19};
  assert.equal((await req(other,'roll:submit',roll)).ok,false);
  assert.equal((await req(host,'roll:submit',roll)).ok,true);
  await until(async()=> (await req(host,'session:resume',{token:h.token})).data.room.turn.action?.status==='failed');
  assert.equal((await req(other,'action:retry',{id,memberId:n})).ok,false);
  // Simula el minuto siguiente SOLO en el fixture para probar retry sin esperar 60s.
  const Database=require('better-sqlite3'),db=new Database(file);db.prepare('UPDATE rate_limits SET start=0').run();db.close();
  assert.equal((await req(host,'action:retry',{id,memberId:n})).ok,true);
  await until(async()=> (await req(host,'session:resume',{token:h.token})).data.room.turn.version===2);
  assert.equal((await req(host,'roll:submit',roll)).ok,true);
  assert.equal((await req(host,'session:resume',{token:h.token})).data.room.turn.version,2);
 }finally{for(const s of sockets)s.disconnect();if(server)await stop(server.proc);fs.rmSync(dir,{recursive:true,force:true});}
});

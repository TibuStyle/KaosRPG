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
    env:{...process.env,PORT:String(port),SQLITE_PATH:file,NODE_ENV:'development',OPENAI_API_KEY:'mock-only',
      FRONTEND_ORIGINS:`http://localhost:${port}`,TRUST_PROXY_HOPS:'0'},stdio:['ignore','pipe','pipe']
  });
  const ready=new Promise((resolve,reject)=> {
    let log=''; const timeout=setTimeout(()=>{proc.kill();reject(new Error('Inicio agotado: '+log));},10000);
    proc.stdout.on('data',buffer=> {log+=buffer; if(log.includes('Crónicas 1.5 escuchando')) {clearTimeout(timeout);resolve();}});
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
test('Socket real + SQLite + IA mock: autorización, idempotencia, espera offline y reinicio', {timeout:30000}, async()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cronicas-socket-')),file=path.join(dir,'game.sqlite'),port=await freePort();
  let server;const sockets=[];
  try {
    server=launch(port,file);await server.ready;
    const host=await client(port),player=await client(port);sockets.push(host,player);
    const world={storyName:'Prueba',premise:'Ruinas',redLines:'',magicLevel:'none',adventureTone:'epic',mortality:'story'};
    const h=(await req(host,'room:create',{playerName:'Director',world})).data;
    const p=(await req(player,'room:join',{playerName:'Jack',code:h.room.code})).data;
    const approved=await req(player,'character:submit',{name:'Jack',history:'SECRETO_HISTORIA'});
    assert.equal(approved.ok,true);assert.equal(approved.data.character.status,'approved');
    assert.ok(!JSON.stringify(approved).includes('SECRETO_RASGO'));
    assert.equal((await req(player,'adventure:start')).ok,false);
    const started=await req(host,'adventure:start');assert.equal(started.ok,true);
    const publicText=JSON.stringify(started.data.room);
    for(const secret of ['SECRETO_HISTORIA','SECRETO_RASGO',p.token,h.token]) assert.ok(!publicText.includes(secret));
    assert.equal(started.data.room.turn.memberId,h.memberId);
    assert.equal((await req(player,'action:submit',{id:crypto.randomUUID(),turnVersion:0,text:'Intrusión'})).ok,false);
    const action={id:crypto.randomUUID(),turnVersion:0,text:'Abro la puerta'};
    assert.equal((await req(host,'action:submit',action)).ok,true);
    assert.equal((await req(host,'action:submit',action)).ok,true);
    await until(async()=>{const r=await req(host,'session:resume',{token:h.token});return r.data?.room.turn.version===1;});
    player.disconnect();
    const offline=(await req(host,'session:resume',{token:h.token})).data.room;
    assert.equal(offline.turn.memberId,p.memberId);
    assert.equal(offline.members.find(m=>m.id===p.memberId).connected,false);
    assert.equal((await req(host,'action:submit',{id:crypto.randomUUID(),turnVersion:1,text:'Intento saltar'})).ok,false);
    await stop(server.proc);server=launch(port,file);await server.ready;
    const host2=await client(port),player2=await client(port);sockets.push(host2,player2);
    const rh=await req(host2,'session:resume',{token:h.token});
    const rp=await req(player2,'session:resume',{token:p.token});
    assert.equal(rh.data.room.phase,'playing');assert.equal(rp.data.room.turn.version,1);
    assert.equal(rp.data.room.turn.memberId,p.memberId);assert.equal(rp.data.character.history,'SECRETO_HISTORIA');
    assert.equal(rp.data.room.messages.filter(m=>m.kind==='action').length,1);
    assert.equal(rp.data.room.messages.filter(m=>m.kind==='ai').length,1);
    assert.equal((await req(player2,'room:leave')).ok,false);
    const risk={id:crypto.randomUUID(),turnVersion:1,text:'ARRIESGADA'};
    assert.equal((await req(player2,'action:submit',risk)).ok,true);
    const waiting=await until(async()=>{const r=await req(player2,'session:resume',{token:p.token});return r.data?.room.turn.action?.stage==='awaiting_roll' && r.data;});
    assert.equal(waiting.room.turn.version,1);
    assert.equal(waiting.room.turn.action.pendingRoll.cd_final,12);
    assert.ok(!JSON.stringify(waiting).includes('SECRETO_RASGO'));
    const roll={id:risk.id,turnVersion:1,resultados:[{caras:20,valor:13},{caras:6,valor:2},{caras:6,valor:4}],total:19};
    assert.equal((await req(host2,'roll:submit',roll)).ok,false);
    assert.equal((await req(player2,'roll:submit',{...roll,total:200})).ok,false);
    await stop(server.proc);server=launch(port,file);await server.ready;
    const player3=await client(port),host3=await client(port);sockets.push(player3,host3);
    const restored=await req(player3,'session:resume',{token:p.token});
    await req(host3,'session:resume',{token:h.token});
    assert.equal(restored.data.room.turn.action.stage,'awaiting_roll');
    assert.deepEqual(restored.data.room.turn.action.pendingRoll,waiting.room.turn.action.pendingRoll);
    assert.equal((await req(player3,'roll:submit',roll)).ok,true);
    assert.equal((await req(player3,'roll:submit',roll)).ok,true);
    assert.equal((await req(player3,'roll:submit',{...roll,total:20,resultados:[{caras:20,valor:14},{caras:6,valor:2},{caras:6,valor:4}]})).ok,false);
    const failed=await until(async()=>{const r=await req(player3,'session:resume',{token:p.token});return r.data?.room.turn.action?.status==='failed' && r.data.room;});
    assert.equal(failed.turn.version,1);assert.equal(failed.turn.action.stage,'resolution');
    assert.deepEqual(failed.turn.action.rollResults,{resultados:roll.resultados,total:roll.total});
    // Cuota agotada: ni el reintento fallido altera resultados ni consume avance.
    assert.equal((await req(player3,'action:retry',{id:risk.id})).ok,false);
    // Simular ventana de cuota vencida directamente en DB de test, sin bypass de producción.
    const testDb=require('better-sqlite3')(file);
    testDb.prepare('DELETE FROM rate_limits').run();testDb.close();
    assert.equal((await req(player3,'action:retry',{id:risk.id})).ok,true);
    await until(async()=>{const r=await req(host3,'session:resume',{token:h.token});return r.data?.room.turn.version===2;});
    assert.equal((await req(player3,'roll:submit',roll)).ok,true); // completed idempotente
    assert.equal((await req(host3,'room:leave')).ok,true);
    assert.equal((await req(player3,'session:resume',{token:p.token})).ok,false);
  } finally {
    for(const s of sockets)s.disconnect();if(server)await stop(server.proc);
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

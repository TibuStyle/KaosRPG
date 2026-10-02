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

test('Socket real: entrega selectiva, aislamiento de sala, mochila dueña, idempotencia y persistencia',async()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cronicas-social-')),file=path.join(dir,'game.sqlite'),port=await freePort();
  let server;const sockets=[];
  try {
    server=launch(port,file);await server.ready;
    const host=await client(port),p=await client(port),q=await client(port),outsider=await client(port),anon=await client(port);
    sockets.push(host,p,q,outsider,anon);
    const world={storyName:'Taberna',premise:'',redLines:'',magicLevel:'low',adventureTone:'dark',mortality:'story'};
    const h=(await req(host,'room:create',{playerName:'Director',world})).data;
    const a=(await req(p,'room:join',{playerName:'A',code:h.room.code})).data;
    const b=(await req(q,'room:join',{playerName:'B',code:h.room.code})).data;
    const other=(await req(outsider,'room:create',{playerName:'Otra sala',world})).data;
    assert.equal((await req(anon,'social:history')).ok,false);
    assert.equal((await req(p,'character:submit',{name:'A',history:'Historia pública'})).ok,false);
    assert.equal((await req(p,'character:submit',{name:'A',history:'Historia pública',appearance:'Pelo gris',publicConsent:true,portraitConsent:true})).ok,true);
    assert.equal((await req(q,'character:submit',{name:'B',history:'Otra historia',appearance:'',publicConsent:true,portraitConsent:true})).ok,true);
    assert.equal((await req(p,'inventory:save',{items:['BACKPACK_SECRET_MARKER']})).ok,true);
    assert.deepEqual((await req(p,'inventory:get',{memberId:b.memberId})).data.items,['BACKPACK_SECRET_MARKER']);
    assert.deepEqual((await req(q,'inventory:get',{memberId:a.memberId})).data.items,[]);
    assert.equal((await req(host,'inventory:get',{memberId:a.memberId})).ok,false);
    const sheet=(await req(q,'character:public',{memberId:a.memberId})).data.character;
    assert.equal(sheet.history,'Historia pública');assert.ok(!JSON.stringify(sheet).includes('BACKPACK_SECRET_MARKER'));
    assert.equal((await req(outsider,'character:public',{memberId:a.memberId})).ok,false);
    const seen={host:[],p:[],q:[],outsider:[]};
    for(const [name,socket] of Object.entries({host,p,q,outsider}))socket.on('social:message',m=>seen[name].push(m));
    const whisper={id:crypto.randomUUID(),kind:'whisper',recipientId:b.memberId,text:'SOCIAL_SECRET_MARKER'};
    assert.equal((await req(p,'social:send',whisper)).ok,true);
    assert.equal((await req(p,'social:send',whisper)).ok,true);
    await delay(80);
    assert.equal(seen.host.length,0);assert.equal(seen.outsider.length,0);assert.equal(seen.p.length,1);assert.equal(seen.q.length,1);
    assert.equal((await req(p,'social:send',{...whisper,text:'Otro texto'})).ok,false);
    assert.equal((await req(p,'social:send',{...whisper,id:crypto.randomUUID(),recipientId:other.memberId})).ok,false);
    assert.equal((await req(host,'social:history')).data.messages.length,0);
    assert.equal((await req(outsider,'social:history')).data.messages.length,0);
    assert.equal((await req(q,'social:history')).data.messages.length,1);
    assert.equal((await req(p,'social:send',{id:crypto.randomUUID(),kind:'global',recipientId:null,text:'Saludos globales'})).ok,true);
    await delay(80);assert.equal(seen.host.length,1);assert.equal(seen.outsider.length,0);
    assert.equal((await req(host,'adventure:start')).ok,true);
    // El mock falla si chat o mochila alcanzan cualquier prompt de Gemini.
    assert.equal((await req(host,'action:submit',{id:crypto.randomUUID(),turnVersion:0,text:'Abro la puerta'})).ok,true);
    await until(async()=>{const x=await req(host,'session:resume',{token:h.token});return x.data?.room.turn.version===1;});
    const snapshot=(await req(q,'session:resume',{token:b.token})).data.room;
    assert.ok(!JSON.stringify(snapshot).includes('SOCIAL_SECRET_MARKER'));assert.ok(!JSON.stringify(snapshot).includes('BACKPACK_SECRET_MARKER'));
    for(const socket of sockets)socket.disconnect();await stop(server.proc);
    server=launch(port,file);await server.ready;
    const resumed=await client(port);sockets.push(resumed);await req(resumed,'session:resume',{token:a.token});
    assert.equal((await req(resumed,'social:history')).data.messages.length,2);
    assert.deepEqual((await req(resumed,'inventory:get')).data.items,['BACKPACK_SECRET_MARKER']);
  } finally {for(const s of sockets)s.disconnect();if(server)await stop(server.proc);fs.rmSync(dir,{recursive:true,force:true});}
});


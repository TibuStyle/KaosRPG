'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {portraitPrompt,createPortrait,BASE}=require('../portraits');
const world={adventure_tone:'dark',magic_level:'low',mortality:'story'};
test('Prompt inglés: estructura fija y URL codificada sin datos privados',async()=> {
  const description='silver hair, amber eyes & green cloak';
  const prompt=portraitPrompt(world,description);
  assert.equal(prompt,'detailed pixel art character portrait, 2d game art, no weapons, dark fantasy low magic world story-driven atmosphere, '+description);
  let called;
  const result=await createPortrait(world,description,{enabled:true,fetcher:async(url,options)=> {
    called=url;assert.equal(options.redirect,'error');assert.ok(options.signal);
    return new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png'}});
  }});
  assert.equal(called,BASE+encodeURIComponent(prompt));assert.equal(result.status,'ready');assert.equal(result.url,called);
});
test('Servicio no disponible no bloquea personaje; sin fallback engañoso',async()=> {
  for(const response of [new Response('no',{status:401}),new Response('html',{headers:{'content-type':'text/html'}}),new Response('',{headers:{'content-type':'image/png'}})]) {
    assert.equal((await createPortrait(world,'traveler',{enabled:true,fetcher:async()=>response})).status,'unavailable');
  }
  assert.equal((await createPortrait(world,'traveler',{enabled:true,fetcher:async()=>{throw new Error('offline');}})).url,null);
  assert.equal((await createPortrait(world,'traveler',{enabled:false,fetcher:()=>{throw new Error('No debería llamarse');}})).status,'disabled');
  const controller=new AbortController();controller.abort();
  assert.equal((await createPortrait(world,'traveler',{enabled:true,signal:controller.signal,fetcher:async()=>{throw new Error('abort');}})).status,'cancelled');
});

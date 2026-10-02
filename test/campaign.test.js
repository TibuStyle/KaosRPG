'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateDecision}=require('../approval');
const {validatePremise,controlledMember}=require('../campaign');
const {openDatabase}=require('../db');
test('Rechazo transparente exige motivo y aprobación exige motivo vacío',()=> {
 const v={aprobado:false,mensaje_narrativo:'Revisa tu historia.',motivo_rechazo_narrativo:'Un arma extrema requiere un defecto relevante.',perks:[],defectos:[]};
 assert.equal(validateDecision(v).motivo_rechazo_narrativo,v.motivo_rechazo_narrativo);
 assert.throws(()=>validateDecision({...v,motivo_rechazo_narrativo:''}));
 assert.throws(()=>validateDecision({...v,aprobado:true}));
 assert.equal(validateDecision({...v,aprobado:true,motivo_rechazo_narrativo:''}).aprobado,true);
});
test('Premisa: 3–4 párrafos, formato exacto y longitud',()=> {
 const p='Una ciudad espera al grupo mientras las campanas anuncian un peligro antiguo.';
 assert.equal(validatePremise({parrafos:[p,p,p]}).split('\n\n').length,3);
 assert.throws(()=>validatePremise({parrafos:[p,p]}));
 assert.throws(()=>validatePremise({parrafos:[p,p,p],extra:true}));
 assert.throws(()=>validatePremise({parrafos:[p+'\nSalto',p,p]}));
 assert.throws(()=>validatePremise({parrafos:['x'.repeat(900),p,'x'.repeat(1100)]}));
});
test('Control NPC únicamente por Host autenticado y misma sala',()=> {
 const db=openDatabase(':memory:');
 try {
  assert.equal(db.pragma('user_version',{simple:true}),4);
  db.prepare("INSERT INTO rooms(code,story_name,premise,red_lines,magic_level,adventure_tone,mortality,created_at) VALUES('ABCDEF','Mundo','','','low','dark','story',0),('UVWXYZ','Otro','','','low','dark','story',0)").run();
  db.prepare("INSERT INTO members(id,room_code,name,is_host,joined_order,is_npc) VALUES('h','ABCDEF','Host',1,0,0),('p','ABCDEF','Jugador',0,1,0),('n','ABCDEF','NPC',0,2,1),('x','UVWXYZ','Ajeno',0,0,1)").run();
  const host=db.prepare("SELECT * FROM members WHERE id='h'").get(),player=db.prepare("SELECT * FROM members WHERE id='p'").get(),room={code:'ABCDEF'};
  assert.equal(controlledMember(db,room,host,'n').id,'n');
  assert.throws(()=>controlledMember(db,room,player,'n'));
  assert.throws(()=>controlledMember(db,room,host,'p'));
  assert.throws(()=>controlledMember(db,room,host,'x'));
  assert.equal(controlledMember(db,room,player).id,'p');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);
 }finally {db.close();}
});

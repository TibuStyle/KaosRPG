'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {expandDice,validateEvaluation,validateRoll,adjustedDC,publicEvaluation,redact}=require('../mechanics');
const {openDatabase,recover}=require('../db');
const traits=[{kind:'ventaja',name:'Furia Berserker'},{kind:'desventaja',name:'Vértigo'}];
const evaluation=()=>({requiere_dado:true,narrativa_previa:'Preparas el salto.',dados_a_lanzar:['1d20','2d6'],cd_base:15,
  modificadores:[{nombre:'Furia Berserker',valor:3,tipo:'ventaja'},{nombre:'Vértigo',valor:-2,tipo:'desventaja'}]});
test('CD, dados dinámicos y privacidad de ajustes',()=> {
  const e=validateEvaluation(evaluation(),traits);
  assert.deepEqual(expandDice(e.dados_a_lanzar),[20,6,6]);
  assert.equal(adjustedDC(e),14);
  assert.equal(publicEvaluation(e).modificadores[0].nombre,'Ajuste 1');
  assert.ok(!JSON.stringify(publicEvaluation(e)).includes('Furia Berserker'));
  assert.equal(redact('Furia Berserker y VÉRTIGO',traits),'[rasgo oculto] y [rasgo oculto]');
  assert.throws(()=>validateEvaluation(e,[]));
  for(const n of [['0d20'],['1d7'],['13d6'],['12d6','1d4'],['1d20+5']]) assert.throws(()=>expandDice(n));
  for(const bad of [{...e,extra:0},{...e,cd_base:0},{...e,requiere_dado:false},
    {...e,modificadores:[{nombre:'Vértigo',valor:2,tipo:'desventaja'}]}]) assert.throws(()=>validateEvaluation(bad,traits));
  assert.equal(validateEvaluation({requiere_dado:false,narrativa_previa:'Caminas.',dados_a_lanzar:[],cd_base:0,modificadores:[]}).requiere_dado,false);
});
test('Validación estricta de caras, cantidades y suma; no afirma antitrampas',()=> {
  const e=validateEvaluation(evaluation(),traits);
  const roll={resultados:[{caras:20,valor:10},{caras:6,valor:3},{caras:6,valor:4}],total:17};
  assert.deepEqual(validateRoll(roll,e),roll);
  for(const bad of [{...roll,total:18},{...roll,extra:true},{...roll,resultados:roll.resultados.slice(1)},
    {...roll,resultados:[{caras:20,valor:21},...roll.resultados.slice(1)]},
    {...roll,resultados:[{caras:6,valor:10},...roll.resultados.slice(1)]}]) assert.throws(()=>validateRoll(bad,e));
});
test('Recuperación conserva espera, configuración y tirada; resolución interrumpida se reintenta',()=> {
  const db=openDatabase(':memory:');
  try {
    db.prepare("INSERT INTO rooms(code,story_name,premise,red_lines,magic_level,adventure_tone,mortality,created_at) VALUES('ABCDEF','T','','','none','epic','story',0)").run();
    db.prepare("INSERT INTO members(id,room_code,name,is_host,joined_order) VALUES('p','ABCDEF','P',1,0)").run();
    db.prepare("INSERT INTO actions(id,room_code,member_id,turn_version,text,status,created_at,stage,pending_roll) VALUES('a','ABCDEF','p',0,'Salto','pending',0,'awaiting_roll',?)").run(JSON.stringify(evaluation()));
    recover(db);
    assert.equal(db.pragma('user_version',{simple:true}),3);
    assert.equal(db.prepare('SELECT stage FROM actions').get().stage,'awaiting_roll');
    assert.equal(db.prepare('SELECT status FROM actions').get().status,'pending');
    db.prepare("UPDATE actions SET stage='resolution',roll_results=?").run('{"resultados":[],"total":0}');
    recover(db);
    const a=db.prepare('SELECT * FROM actions').get();
    assert.equal(a.status,'failed');assert.equal(a.stage,'resolution');
    assert.ok(a.roll_results);assert.ok(a.pending_roll);
  } finally {db.close();}
});

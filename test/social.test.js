'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateCharacter,validateFinal,validateInventory,publicSheet,socialHistory,validateChat}=require('../social');
const {openDatabase}=require('../db');
const character=()=>({aprobado:true,mensaje_narrativo:'Bienvenido',perks:[],defectos:[],
  descripcion_visual_ingles:'a traveler in a red cloak',equipo_publico:[{tipo:'defensa',nombre:'Abrigo'}],inventario_privado:[]});
const sheets=[{memberId:'p',states:['Herido']}];
test('Ficha y mochila: límites, contrato exacto y apariencia sin inventario IA',()=> {
  assert.equal(validateCharacter(character()).equipment[0].nombre,'Abrigo');
  assert.throws(()=>validateCharacter({...character(),inventario_privado:['Llave']}));
  assert.throws(()=>validateCharacter({...character(),equipo_publico:[{tipo:'defensa',nombre:'X',valor:5}]}));
  assert.throws(()=>validateCharacter({...character(),descripcion_visual_ingles:'x'.repeat(1001)}));
  assert.throws(()=>validateCharacter({...character(),extra:1}));
  assert.deepEqual(validateInventory([' Llave ']),['Llave']);
  assert.throws(()=>validateInventory(Array(31).fill('Llave')));
  assert.throws(()=>validateInventory(['Llave','Llave']));
  assert.throws(()=>validateInventory(['x'.repeat(121)]));
});
test('Estados: participantes autorizados, duplicados, retiro válido y límite',()=> {
  const v={narrativa:'Te recuperas.',estados:[{member_id:'p',operacion:'retirar',etiqueta:'Herido'}]};
  assert.equal(validateFinal(v,sheets).states[0].operation,'retirar');
  assert.throws(()=>validateFinal({...v,estados:[{...v.estados[0],member_id:'otra-sala'}]},sheets));
  assert.throws(()=>validateFinal({...v,estados:[{...v.estados[0],etiqueta:'Inexistente'}]},sheets));
  assert.throws(()=>validateFinal({...v,estados:[v.estados[0],v.estados[0]]},sheets));
  assert.throws(()=>validateFinal({...v,extra:true},sheets));
  assert.throws(()=>validateFinal({narrativa:'Hecho',estados:[{member_id:'p',operacion:'poner',etiqueta:'Nuevo'}]},
    [{memberId:'p',states:Array.from({length:16},(_,i)=>'Estado '+i)}]));
});
test('SQL: ficha pública por whitelist, separación narrativa/social, susurros filtrados y cascadas',()=> {
  const db=openDatabase(':memory:');
  try {
    db.prepare("INSERT INTO rooms(code,story_name,premise,red_lines,magic_level,adventure_tone,mortality,created_at) VALUES('ABCDEF','Mundo','','','high','dark','story',0)").run();
    for(const [i,id] of ['p','q','r'].entries())db.prepare('INSERT INTO members(id,room_code,name,is_host,joined_order) VALUES(?,?,?,?,?)').run(id,'ABCDEF',id,i===0?1:0,i);
    db.prepare("INSERT INTO characters(member_id,name,history,status,narrative,public_history,inventory) VALUES('p','P','HISTORIA_PRIVADA','approved','','Historia pública',?)").run('["BACKPACK_SECRET_MARKER"]');
    db.prepare("INSERT INTO traits VALUES('p','ventaja','RASGO_PRIVADO')").run();
    const json=JSON.stringify(publicSheet(db,'p'));
    assert.ok(!json.includes('HISTORIA_PRIVADA'));assert.ok(!json.includes('BACKPACK_SECRET_MARKER'));assert.ok(!json.includes('RASGO_PRIVADO'));
    for(const [kind,to,text] of [['global',null,'Saludos'],['whisper','q','SOCIAL_SECRET_MARKER']]) {
      db.prepare('INSERT INTO social_messages(room_code,sender_id,recipient_id,sender_name,recipient_name,kind,text,client_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('ABCDEF','p',to,'P',to,kind,text,text,0);
    }
    assert.equal(socialHistory(db,'ABCDEF','p').length,2);
    assert.equal(socialHistory(db,'ABCDEF','q').length,2);
    assert.equal(socialHistory(db,'ABCDEF','r').length,1);
    assert.equal(socialHistory(db,'OTHERR','q').length,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
    db.prepare("INSERT INTO character_states VALUES('p','Inspirado')").run();
    db.prepare("DELETE FROM rooms WHERE code='ABCDEF'").run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_states').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM social_messages').get().n,0);
  } finally{db.close();}
});
test('Chat: contrato y tamaño',()=> {
  const v={id:'00000000-0000-4000-8000-000000000001',kind:'global',recipientId:null,text:' Hola '};
  assert.equal(validateChat(v).text,'Hola');
  assert.throws(()=>validateChat({...v,recipientId:'p'}));assert.throws(()=>validateChat({...v,text:'x'.repeat(1001)}));
  assert.throws(()=>validateChat({...v,kind:'whisper'}));assert.throws(()=>validateChat({...v,extra:1}));
});

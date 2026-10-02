'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDecision } = require('../approval');
const { openDatabase, recover } = require('../db');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
function decision() { return {aprobado:true,mensaje_narrativo:'Bienvenido.',perks:[{nombre:'Navegante',tipo:'ventaja'}],defectos:[]}; }
test('Esquema de aprobación exacto, sin rasgos duplicados ni rechazo con rasgos',()=> {
  assert.equal(validateDecision(decision()).aprobado,true);
  for(const bad of [{...decision(),extra:true},{...decision(),aprobado:'true'},
    {...decision(),perks:[{nombre:'X',tipo:'desventaja'}]},
    {...decision(),perks:[decision().perks[0],decision().perks[0]]},
    {...decision(),aprobado:false},{...decision(),mensaje_narrativo:''}]) assert.throws(()=>validateDecision(bad));
});
test('SQLite real: reinicio, rasgos, sesión hash, cola, chat y recuperación de trabajo interrumpido',()=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cronicas-db-')),file=path.join(dir,'game.sqlite');
  let db;
  try {
    db=openDatabase(file);
    db.prepare("INSERT INTO rooms(code,story_name,premise,red_lines,magic_level,adventure_tone,mortality,created_at) VALUES('ABCDEF','Historia','','','none','epic','story',0)").run();
    db.prepare("INSERT INTO members(id,room_code,name,is_host,joined_order,socket_id) VALUES('host','ABCDEF','Director',1,0,'connected')").run();
    db.prepare("INSERT INTO members(id,room_code,name,is_host,joined_order,socket_id) VALUES('jack','ABCDEF','Jack',0,1,'connected')").run();
    db.prepare("INSERT INTO sessions VALUES('hash-token','jack',0)").run();
    db.prepare("INSERT INTO characters(member_id,name,history,status,narrative) VALUES('jack','Jack','Marinero','approved','Bienvenido')").run();
    db.prepare("INSERT INTO traits VALUES('jack','ventaja','Navegante')").run();
    db.prepare("INSERT INTO turn_order VALUES('ABCDEF',0,'host'),('ABCDEF',1,'jack')").run();
    db.prepare("UPDATE rooms SET phase='playing',turn_index=1,turn_version=3").run();
    db.prepare("INSERT INTO actions(id,room_code,member_id,turn_version,text,status,created_at) VALUES('action','ABCDEF','jack',3,'Exploro','pending',0)").run();
    db.prepare("INSERT INTO messages(room_code,author_name,kind,text,action_id,created_at) VALUES('ABCDEF','Jack','action','Exploro','action',0)").run();
    db.close(); db=openDatabase(file); recover(db);
    assert.equal(db.prepare('SELECT turn_version FROM rooms').get().turn_version,3);
    assert.equal(db.prepare('SELECT turn_index FROM rooms').get().turn_index,1);
    assert.equal(db.prepare('SELECT status FROM actions').get().status,'failed');
    assert.equal(db.prepare('SELECT socket_id FROM members WHERE id=?').get('jack').socket_id,null);
    assert.equal(db.prepare('SELECT status FROM characters').get().status,'approved');
    assert.equal(db.prepare('SELECT name FROM traits').get().name,'Navegante');
    assert.equal(db.prepare('SELECT member_id FROM sessions WHERE token_hash=?').get('hash-token').member_id,'jack');
    assert.equal(db.prepare('SELECT text FROM messages').get().text,'Exploro');
    assert.throws(()=>db.prepare("INSERT INTO actions(id,room_code,member_id,turn_version,text,status,created_at) VALUES('duplicate','ABCDEF','jack',3,'Otra','pending',0)").run());
    assert.throws(()=>db.prepare("INSERT INTO turn_order VALUES('ABCDEF',2,'intruso')").run());
    db.prepare("DELETE FROM rooms WHERE code='ABCDEF'").run();
    for(const table of ['members','sessions','characters','traits','turn_order','actions','messages']) {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0);
    }
  } finally { if(db?.open) db.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

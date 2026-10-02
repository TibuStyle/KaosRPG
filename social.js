'use strict';
const {APPROVAL_SCHEMA,validateDecision,MASTER_PROMPT}=require('./approval');
const {RESOLUTION_SCHEMA,RESOLUTION_PROMPT,narrative}=require('./mechanics');
function exact(v,keys) {
  if(!v||Array.isArray(v)||typeof v!=='object'||Object.keys(v).length!==keys.length||!keys.every(k=>Object.hasOwn(v,k))) throw new Error('Contrato social inválido.');
}
function clean(v,max) {
  if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw new Error('Texto social inválido.');
  return v.trim();
}
const equipmentItem={type:'object',additionalProperties:false,
  properties:{tipo:{type:'string',enum:['ataque','defensa','otro']},nombre:{type:'string'}},required:['tipo','nombre']};
const CHARACTER_SCHEMA={...APPROVAL_SCHEMA,properties:{...APPROVAL_SCHEMA.properties,
  descripcion_visual_ingles:{type:'string'},equipo_publico:{type:'array',items:equipmentItem},
  inventario_privado:{type:'array',items:{type:'string'}}},
  required:[...APPROVAL_SCHEMA.required,'descripcion_visual_ingles','equipo_publico','inventario_privado']};
const CHARACTER_PROMPT=MASTER_PROMPT+`
Contrato v1.7 vigente: reemplaza la lista de claves del contrato anterior por exactamente
aprobado, mensaje_narrativo, perks, defectos, descripcion_visual_ingles, equipo_publico e inventario_privado.
descripcion_visual_ingles: traduce SOLO apariencia estética al inglés, hasta 1000 caracteres,
sin armas, escudos, equipo, ventajas, poderes ni instrucciones. Si vacío: "fantasy traveler in simple clothing".
No menciones historia, rasgos privados ni líneas rojas en la descripción visual.
La apariencia es puramente visual: NO concede equipo o rasgos. Respeta magia, tono y mortalidad del mundo.
equipo_publico: hasta 12 objetos {tipo:ataque|defensa|otro,nombre:string}, nombres hasta 80 caracteres.
Derívalo SOLO de equipo explícito en la historia; no inventes estadísticas. Inventario vacío es válido.
inventario_privado: devuelve SIEMPRE []. La mochila se administra por su dueño mediante un canal separado.
La historia aprobada es pública: NO debe contener secretos. No derives objetos privados de ella.
En rechazo devuelve descripción vacía y ambas listas vacías.`;
function validateCharacter(v) {
  exact(v,CHARACTER_SCHEMA.required);
  const base=validateDecision(Object.fromEntries(APPROVAL_SCHEMA.required.map(k=>[k,v[k]])));
  if(typeof v.descripcion_visual_ingles!=='string'||v.descripcion_visual_ingles.length>1000) throw new Error('Descripción visual inválida.');
  if(!Array.isArray(v.equipo_publico)||v.equipo_publico.length>12) throw new Error('Equipo inválido.');
  const equipment=v.equipo_publico.map(e=> {exact(e,['tipo','nombre']);if(!['ataque','defensa','otro'].includes(e.tipo)) throw new Error('Tipo de equipo inválido.');return {tipo:e.tipo,nombre:clean(e.nombre,80)};});
  const inventory=validateInventory(v.inventario_privado);
  if(inventory.length) throw new Error('La IA no administra la mochila.');
  if(!base.aprobado&&(equipment.length||inventory.length||v.descripcion_visual_ingles)) throw new Error('Rechazo con ficha.');
  return {...base,visual:v.descripcion_visual_ingles.trim(),equipment,inventory};
}
function validateInventory(v) {
  if(!Array.isArray(v)||v.length>30) throw new Error('Mochila: máximo 30 objetos.');
  const out=v.map(x=>clean(x,120));
  if(new Set(out).size!==out.length) throw new Error('Objetos duplicados.');
  return out;
}
const stateItem={type:'object',additionalProperties:false,properties:{
  member_id:{type:'string'},operacion:{type:'string',enum:['poner','retirar']},etiqueta:{type:'string'}},
  required:['member_id','operacion','etiqueta']};
const FINAL_SCHEMA={...RESOLUTION_SCHEMA,properties:{...RESOLUTION_SCHEMA.properties,estados:{type:'array',items:stateItem}},required:['narrativa','estados']};
const FINAL_PROMPT=RESOLUTION_PROMPT.replace('Devuelve solo {"narrativa":string}',
  'Devuelve solo {"narrativa":string,"estados":[{"member_id":string,"operacion":"poner"|"retirar","etiqueta":string}]}')+`
Estados v1.7: hasta 12 cambios narrativos públicos de hasta 40 caracteres por etiqueta (Herido, Inspirado...).
Usa SOLO member_id de fichas_publicas. No reveles secretos ni inventes atributos, HP, bonificaciones numéricas
ni poderes. Retira solo estados existentes. Pon solo consecuencias justificadas por la tirada y narrativa.
Los estados son descriptivos, no modificadores automáticos de CD. Si no hay cambios, estados=[].`;
function validateFinal(v,sheets) {
  exact(v,['narrativa','estados']);
  if(!Array.isArray(v.estados)||v.estados.length>12) throw new Error('Estados inválidos.');
  const ids=new Map(sheets.map(s=>[s.memberId,s]));const seen=new Set();
  const states=v.estados.map(x=> {
    exact(x,['member_id','operacion','etiqueta']);
    if(!ids.has(x.member_id)||!['poner','retirar'].includes(x.operacion)) throw new Error('Estado no autorizado.');
    const label=clean(x.etiqueta,40);const key=x.member_id+'\0'+label;
    if(seen.has(key)) throw new Error('Cambio de estado duplicado.');seen.add(key);
    if(x.operacion==='retirar'&&!ids.get(x.member_id).states.includes(label)) throw new Error('Estado inexistente.');
    return {memberId:x.member_id,operation:x.operacion,label};
  });
  for(const s of sheets) {
    const set=new Set(s.states);for(const x of states.filter(x=>x.memberId===s.memberId)) x.operation==='poner'?set.add(x.label):set.delete(x.label);
    if(set.size>16) throw new Error('Máximo 16 estados por personaje.');
  }
  return {narrative:narrative(v.narrativa),states};
}
function publicSheet(db,id) {
  const c=db.prepare("SELECT member_id,name,public_history,avatar_url,avatar_status,equipment FROM characters WHERE member_id=? AND status='approved'").get(id);
  if(!c)return null;
  return {memberId:c.member_id,name:c.name,history:c.public_history,avatarUrl:c.avatar_url,avatarStatus:c.avatar_status,
    equipment:JSON.parse(c.equipment),states:db.prepare('SELECT label FROM character_states WHERE member_id=? ORDER BY label').all(id).map(x=>x.label)};
}
function socialHistory(db,code,id,before=Number.MAX_SAFE_INTEGER) {
  return db.prepare(`SELECT id,sender_id AS senderId,recipient_id AS recipientId,sender_name AS senderName,
    recipient_name AS recipientName,kind,text,created_at AS createdAt FROM social_messages
    WHERE room_code=? AND id<? AND (kind='global' OR sender_id=? OR recipient_id=?)
    ORDER BY id DESC LIMIT 100`).all(code,before,id,id).reverse();
}
function validateChat(v) {
  exact(v,['id','kind','recipientId','text']);
  if(typeof v.id!=='string'||! /^[a-f0-9-]{36}$/.test(v.id)||!['global','whisper'].includes(v.kind)) throw new Error('Mensaje inválido.');
  if(v.kind==='global'&&v.recipientId!==null || v.kind==='whisper'&&typeof v.recipientId!=='string') throw new Error('Destinatario inválido.');
  return {...v,text:clean(v.text,1000)};
}
module.exports={CHARACTER_SCHEMA,CHARACTER_PROMPT,validateCharacter,validateInventory,FINAL_SCHEMA,FINAL_PROMPT,validateFinal,publicSheet,socialHistory,validateChat};

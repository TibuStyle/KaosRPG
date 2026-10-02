'use strict';
// Datos privados solo en memoria DOM; nunca en el snapshot público.
const socialMessages=new Map();
let socialPending=null,socialLoading=false,socialSending=false,sheetMember=null,sheetSequence=0,inventoryBusy=false;
function initSocial() {
  byId('sheet-avatar').addEventListener('error',()=> {
    byId('sheet-avatar').hidden=true;byId('sheet-avatar-status').textContent='Retrato externo no disponible.';
  });
  byId('sheet-dialog').addEventListener('close',()=>{sheetMember=null;sheetSequence++;byId('sheet-content').hidden=true;byId('sheet-avatar').removeAttribute('src');});
  byId('inventory-dialog').addEventListener('close',()=>{byId('inventory-form').reset();byId('inventory-status').textContent='';});
  byId('social-history').addEventListener('click',()=>void loadSocial(true));
  byId('social-form').addEventListener('submit',async event=> {
    event.preventDefault();if(!session||socialSending)return;
    const expected=token,recipientId=byId('social-target').value||null;
    const value={kind:recipientId?'whisper':'global',recipientId,text:byId('social-text').value.trim()};
    if(!socialPending||JSON.stringify(value)!==JSON.stringify({kind:socialPending.kind,recipientId:socialPending.recipientId,text:socialPending.text})) socialPending={id:crypto.randomUUID(),...value};
    socialSending=true;byId('social-send').disabled=true;
    try {
      const data=await request('social:send',socialPending);
      if(token!==expected||!session)return;
      addSocial(data.message);socialPending=null;byId('social-text').value='';byId('social-status').textContent='Mensaje guardado.';
    } catch(error){if(token===expected)byId('social-status').textContent=error.message+' Reenvía el mismo texto para recuperar el ACK.';}
    finally {socialSending=false;byId('social-send').disabled=!socket?.connected;}
  });
  byId('inventory-open').addEventListener('click',async()=> {
    if(!session||sheetMember!==session.memberId)return;
    const expected=token;byId('inventory-form').reset();byId('inventory-status').textContent='Cargando…';
    if(!byId('inventory-dialog').open)byId('inventory-dialog').showModal();
    inventoryBusy=true;byId('inventory-form').querySelector('button').disabled=true;
    try {const data=await request('inventory:get',{});if(token===expected&&session&&byId('inventory-dialog').open){byId('inventory-items').value=data.items.join('\n');byId('inventory-status').textContent='';}}
    catch(error){if(token===expected)byId('inventory-status').textContent=error.message;}
    finally {inventoryBusy=false;byId('inventory-form').querySelector('button').disabled=false;}
  });
  byId('inventory-form').addEventListener('submit',async event=> {
    event.preventDefault();if(inventoryBusy||!session)return;
    inventoryBusy=true;const expected=token;byId('inventory-form').querySelector('button').disabled=true;
    try {
      const items=byId('inventory-items').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
      await request('inventory:save',{items});if(token===expected)byId('inventory-status').textContent='Mochila privada guardada.';
    } catch(error){if(token===expected)byId('inventory-status').textContent=error.message;}
    finally {inventoryBusy=false;byId('inventory-form').querySelector('button').disabled=false;}
  });
  byId('publish-history').addEventListener('click',async()=> {
    if(!session||sheetMember!==session.memberId||!confirm('Tu historia completa será visible para todos en la sala. ¿Confirmas que no contiene secretos?'))return;
    const expected=token;
    try {await request('character:publish-history',{});if(token===expected&&sheetMember)void openSheet(sheetMember,false);}
    catch(error){if(token===expected)byId('sheet-status').textContent=error.message;}
  });
}
function safeAvatar(url) {
  try {const u=new URL(url);return u.protocol==='https:'&&u.hostname==='image.pollinations.ai'&&u.pathname.startsWith('/prompt/')?u.href:null;}catch{return null;}
}
function decorateMembers(list,members) {
  [...list.children].forEach((li,index)=> {
    const member=members[index];if(!member)return;
    const label=li.textContent;li.textContent='';
    const button=document.createElement('button');button.type='button';button.className='member-button';
    button.setAttribute('aria-label','Abrir ficha de '+member.name);
    const url=safeAvatar(member.avatarUrl);
    if(url) {const img=document.createElement('img');img.src=url;img.className='avatar-thumb';img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.addEventListener('error',()=>{img.hidden=true;},{once:true});button.append(img);}
    const span=document.createElement('span');span.textContent=label;button.append(span);
    button.addEventListener('click',()=>void openSheet(member.id));li.append(button);
  });
}
async function openSheet(id,show=true) {
  if(!session)return;
  sheetMember=id;const seq=++sheetSequence,expected=token;
  if(show&&!byId('sheet-dialog').open)byId('sheet-dialog').showModal();
  byId('sheet-title').textContent='Ficha pública';byId('sheet-status').textContent='Cargando…';byId('sheet-content').hidden=true;
  try {
    const data=await request('character:public',{memberId:id});
    if(seq!==sheetSequence||token!==expected||!session||!byId('sheet-dialog').open)return;
    const c=data.character;if(!c){byId('sheet-status').textContent='Este participante no tiene personaje aprobado.';return;}
    byId('sheet-status').textContent='';byId('sheet-title').textContent=c.name;byId('sheet-content').hidden=false;
    const url=safeAvatar(c.avatarUrl);byId('sheet-avatar').hidden=!url;
    if(url)byId('sheet-avatar').src=url;else byId('sheet-avatar').removeAttribute('src');
    byId('sheet-avatar-status').textContent=url?'Pixel art generado por un servicio externo.':c.avatarStatus==='disabled'?'Retratos desactivados.':'Sin retrato disponible; tu personaje sigue aprobado.';
    byId('sheet-history').textContent=c.history||'Historia todavía no publicada por su dueño.';
    byId('sheet-equipment').replaceChildren(...listText(c.equipment.map(e=>e.tipo.toUpperCase()+': '+e.nombre),'Sin equipo declarado.'));
    byId('sheet-states').replaceChildren(...listText(c.states,'Sin estados activos.'));
    byId('inventory-open').hidden=id!==session.memberId;byId('publish-history').hidden=id!==session.memberId||Boolean(c.history);
  } catch(error){if(seq===sheetSequence&&token===expected)byId('sheet-status').textContent=error.message;}
}
function listText(items,empty) {return (items.length?items:[empty]).map(text=>{const li=document.createElement('li');li.textContent=text;return li;});}
function renderSocial(room) {
  const target=byId('social-target'),prior=target.value;
  const options=[new Option('Global (Off-Rol)',''),...room.members.filter(m=>m.id!==session.memberId).map(m=>new Option('Susurro → '+m.name,m.id))];
  target.replaceChildren(...options);if(options.some(o=>o.value===prior))target.value=prior;
  byId('social-send').disabled=socialSending||!socket?.connected;
  if(sheetMember&&byId('sheet-dialog').open)void openSheet(sheetMember,false);
}
function addSocial(message) {
  if(!message||!Number.isSafeInteger(message.id)||!session)return;
  // Defensa adicional UI; el control real está en servidor/consulta SQL.
  if(message.kind==='whisper'&&![message.senderId,message.recipientId].includes(session.memberId))return;
  socialMessages.set(message.id,message);drawSocial();
}
function drawSocial() {
  const log=byId('social-log'),nearBottom=log.scrollHeight-log.scrollTop-log.clientHeight<60;
  const nodes=[...socialMessages.values()].sort((a,b)=>a.id-b.id).map(m=> {
    const article=document.createElement('article');article.className='social-message '+m.kind;
    const name=document.createElement('button');name.type='button';name.className='chat-name';name.textContent=m.senderName;
    name.disabled=m.senderId===session?.memberId||!session?.room.members.some(x=>x.id===m.senderId);
    name.addEventListener('click',()=>{byId('social-target').value=m.senderId;byId('social-text').focus();});
    const meta=document.createElement('span');meta.textContent=m.kind==='whisper'?' · Susurro → '+m.recipientName:' · Global (Off-Rol)';
    const p=document.createElement('p');p.textContent=m.text;article.append(name,meta,p);return article;
  });
  log.replaceChildren(...nodes);if(nearBottom)log.scrollTop=log.scrollHeight;
}
async function loadSocial(older=false) {
  if(!session||socialLoading)return;socialLoading=true;const expected=token;
  try {
    const before=older&&socialMessages.size?Math.min(...socialMessages.keys()):undefined;
    const data=await request('social:history',before?{before}:{});
    if(token!==expected||!session)return;
    for(const m of data.messages)socialMessages.set(m.id,m);drawSocial();
    byId('social-status').textContent=older&&!data.messages.length?'No hay mensajes anteriores.':'';
  } catch(error){if(token===expected)byId('social-status').textContent=error.message;}
  finally {socialLoading=false;}
}
function resetSocial() {
  socialMessages.clear();socialPending=null;sheetMember=null;sheetSequence++;
  byId('social-log').replaceChildren();byId('social-form').reset();byId('social-status').textContent='';
  byId('inventory-form').reset();byId('inventory-status').textContent='';
  for(const id of ['inventory-dialog','sheet-dialog'])if(byId(id).open)byId(id).close();
  byId('sheet-avatar').removeAttribute('src');byId('sheet-history').textContent='';
}

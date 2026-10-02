'use strict';
const diceModuleURL = new URL('./dice-ui.mjs', document.currentScript.src).href;
const byId = id => document.getElementById(id);
const panels = { create: byId('panel-create'), join: byId('panel-join') };
const storage = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* Sin recuperación tras recarga. */ } },
  remove(key) { try { sessionStorage.removeItem(key); } catch { /* Almacenamiento no disponible. */ } }
};

// v1.9 — Audio (Tramo 1: audio.js). Todo protegido: sin audio, el juego sigue.
const audio = window.CronicasAudio || null;
const SFX = { turn:'turn', whisper:'whisper', message:'message', reject:'reject', approve:'approve',
  error:'error', success:'success', fail:'failure', type:'type' };
function sfx(key) { try { audio?.play?.(SFX[key] || key); } catch { /* Audio opcional. */ } }
let currentMusic = null;
function music(name) {
  if (name === currentMusic) return;
  currentMusic = name;
  try { audio?.setMusic?.(name); } catch { /* Audio opcional. */ }
}
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let rollSoundId = null;

const fallback = /^https?:$/.test(location.protocol) && !location.hostname.endsWith('.github.io')
  ? location.origin : '';
let backend = storage.get('cronicas.backend') || fallback;
let token = storage.get('cronicas.token');
let socket = null;
let session = null;
let activePanel = null;
let busy = false;
let resuming = false;
let generation = 0;
const forms = ['create-form', 'join-form', 'character-form'];

function status(name, message, error = false, silent = false) {
  const element = byId(`${name}-status`);
  element.textContent = message;
  element.dataset.error = String(error);
  if (error && message && !silent) sfx('error');
}
function connection(message) { byId('connection-status').textContent = message; }
function closePanels(restore = false) {
  const previous = activePanel;
  for (const [name, panel] of Object.entries(panels)) {
    panel.hidden = true;
    byId(`${name}-button`).setAttribute('aria-expanded', 'false');
  }
  activePanel = null;
  if (restore && previous) byId(`${previous}-button`).focus();
}
function showScreen(name) {
  closePanels();
  for (const screen of ['home', 'lobby', 'session']) byId(`screen-${screen}`).hidden = screen !== name;
  byId(`${name === 'session' ? 'session' : name}-title`).focus();
  if (name !== 'session') music('tavern');
}
function openPanel(name) {
  closePanels();
  panels[name].hidden = false;
  activePanel = name;
  byId(`${name}-button`).setAttribute('aria-expanded', 'true');
  status(name, '');
  panels[name].querySelector('input').focus();
}
function controls() {
  const evaluating = ownMember()?.characterStatus === 'evaluating';
  const disabled = busy || resuming || !socket?.connected;
  for (const id of forms) {
    byId(id).querySelector('[type="submit"]').disabled = disabled ||
      (id === 'character-form' && (evaluating || session?.room.phase !== 'lobby'));
    byId(id).setAttribute('aria-busy', String(busy || resuming));
  }
  byId('leave-button').disabled = disabled;
  byId('wipe-button').disabled=disabled;
  byId('npc-button').disabled=disabled;
  byId('npc-save').disabled=disabled;
  byId('random-premise-button').disabled=disabled;
  byId('start-button').disabled = disabled || !session?.room.canStart;
  gameControls(disabled);
  byId('social-send').disabled=socialSending||!session||!socket?.connected||resuming;
}
function ownMember() { return session?.room.members.find(m => m.id === session.memberId); }
function request(event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error('Sin conexión con el servidor.'));
    const requestSocket = socket;
    const version = generation;
    requestSocket.timeout(['character:submit','premise:generate'].includes(event) ? 60000 : 10000).emit(event, payload, (error, response) => {
      if (version !== generation || requestSocket !== socket) return reject(new Error('Conexión sustituida.'));
      if (event === 'character:submit' && !session) return reject(new Error('La sala ya no está activa.'));
      if (error) return reject(new Error('Sin confirmación del servidor. Comprueba la conexión antes de reintentar.'));
      if (!response?.ok) return reject(new Error(response?.error || 'Respuesta inválida.'));
      resolve(response.data);
    });
  });
}
function clearSession() {
  token = null; session = null;
  byId('npc-dialog').close();
  byId('npc-form').reset();
  chatMessages.clear(); pendingAction = null;
  skipTyping(); chatNodes.clear(); chatPrimed = false; newestSeen = 0;
  typeQueue = Promise.resolve(); rollSoundId = null;
  resetSocial();
  byId('action-form').reset();
  byId('narrative-chat').replaceChildren();
  storage.remove('cronicas.token');
  byId('character-form').reset();
  status('character', '');
  status('session', '');
  byId('member-list').replaceChildren();
  byId('session-code').textContent = '';
  byId('world-summary').textContent = '';
  byId('roll-panel').hidden = true;
  byId('starting-panel').hidden = true; byId('start-button').hidden = true;
}
const labels = {
  high: 'Alta Magia', low: 'Baja Magia', none: 'Sin Magia',
  epic: 'Épico', dark: 'Oscuro/Letal', comic: 'Cómico',
  story: 'Modo Historia', relentless: 'Modo Implacable'
};
function render(room) {
  if (!session) return;
  const prevPhase = session.room?.phase;
  const prevTurn = session.room?.turn;
  session.room = room;
  byId('session-code').textContent = room.code;
  byId('session-role').textContent = session.isHost ? 'Anfitrión' : 'Jugador';
  const starting = room.phase === 'playing';
  byId('session-title').textContent = starting ? 'Vista de Partida' :
    (session.isHost ? 'Sala de Espera' : 'Creación de Personaje');
  byId('character-panel').hidden = session.isHost || starting;
  byId('starting-panel').hidden = !starting;
  byId('start-button').hidden = !session.isHost || starting;
  byId('wipe-button').hidden=!session.isHost;
  byId('npc-button').hidden=!session.isHost;
  byId('leave-button').textContent = session.isHost ? 'Cerrar sala para todos' : 'Salir de la sala';
  byId('leave-button').hidden = starting && !session.isHost;
  const w = room.world;
  byId('world-summary').textContent = `${w.storyName}\n${[w.magicLevel, w.adventureTone, w.mortality].map(v => labels[v] || v).join(' · ')}\nPremisa: ${w.premise || 'No especificada'}\nLíneas rojas: ${w.redLines || 'No especificadas'}\nMotor asíncrono estricto · sin caducidad automática`;
  const nodes = room.members.map(member => {
    const item = document.createElement('li');
    item.textContent = `${member.name}${member.isNPC ? ' · NPC (controlado por Director)' : ''}${member.isHost ? ' · Anfitrión' : ''}${member.id === session.memberId ? ' · Tú' : ''} — ${member.connected ? 'Conectado' : 'Desconectado (turno conservado)'}${!member.isHost ? ` · ${{ draft: 'Creando personaje', evaluating: 'Evaluando con el DM...', rejected: 'Rechazado: requiere cambios', approved: 'Aprobado' }[member.characterStatus] \vert{}\vert{} 'Creando personaje'}${member.characterName ? ': ' + member.characterName : ''}` : ''}`;
    return item;
  });
  byId('member-list').replaceChildren(...nodes);
  byId('member-list').parentElement.hidden = starting;
  decorateMembers(byId('member-list'),room.members);
  renderSocial(room);
  
  renderGame(room);
  const t = room.turn;
  music(room.phase === 'playing' && t?.action?.stage === 'awaiting_roll' ? 'tension' : 'tavern');
  if (room.phase === 'playing' && prevTurn !== t) {
    if (ownsTurn() && !t.action && (prevPhase !== 'playing' || prevTurn?.version !== t.version)) sfx('turn');
    const a = t.action;
    if (a?.rollResults && a.pendingRoll && rollSoundId !== a.id && prevTurn) {
      rollSoundId = a.id;
      sfx(a.rollResults.total >= a.pendingRoll.cd_final ? 'success' : 'fail');
    }
  }

  if (ownMember()?.characterStatus === 'evaluating') status('character', 'El DM está evaluando tu personaje...');
  controls();
}
function accept(data) {
  token = data.token;
  storage.set('cronicas.token', token);
  session = data;
  render(data.room);
  if (data.character) {
    byId('character-name').value = data.character.name;
    byId('character-history').value = data.character.history;
    byId('character-appearance').value = data.character.appearance || '';
    showCharacterDecision(data.character);
  }
  showScreen('session');
  void loadSocial();
}
function connect() {
  if (typeof window.io !== 'function') {
    connection('No se cargó Socket.io. Revisa el acceso al CDN y recarga.'); controls(); return;
  }
  if (!backend) { connection('Configura la URL del backend en Opciones / Servidor.'); controls(); return; }
  generation++;
  const version = generation;
  if (socket) { socket.removeAllListeners(); socket.disconnect(); }
  connection('Conectando al servidor…');
  socket = window.io(backend, { autoConnect: false, reconnection: true, timeout: 10000 });
  socket.on('connect', async () => {
    connection('Conectado al servidor.');
    resuming = Boolean(token); controls();
    if (!token) return;
    try {
      const data = await request('session:resume', { token });
      if (version === generation) accept(data);
    } catch (error) {
      if (version !== generation) return;
      if (!socket.connected || error.message.startsWith('Sin confirmación')) {
        connection('No se pudo recuperar aún. Se reintentará al reconectar.');
        socket.disconnect(); socket.connect();
      } else {
        clearSession(); showScreen('lobby'); connection(error.message);
      }
    } finally { if (version === generation) { resuming = false; controls(); } }
  });
  socket.on('connect_error', () => {
    connection('No se puede conectar: revisa URL, HTTPS y FRONTEND_ORIGINS del servidor.'); controls();
  });
  socket.on('disconnect', () => {
    connection('Sin conexión. Reconexión automática; partida y turno conservados en SQLite.'); controls();
    sfx('error');
  });
  socket.on('room:state', room => {
    if (session && room.code === session.room.code) {
      const wasEvaluating = ownMember()?.characterStatus === 'evaluating';
      render(room);
      if (wasEvaluating && ownMember()?.characterStatus !== 'evaluating' && !busy) recoverDecision();
    }
  });
  socket.on('social:message', message => {
    if (!session) return;
    addSocial(message);
    if (message.authorId === session.memberId) return;
    const whisper = Boolean(message.targetId || message.whisper || message.kind === 'whisper');
    sfx(whisper ? 'whisper' : 'message');
  });
  socket.on('room:closed', data => {
    clearSession(); showScreen('lobby'); connection(data.reason); controls();
  });
  socket.on('session:replaced', () => {
    clearSession(); socket.disconnect(); showScreen('lobby');
    connection('Esta sesión se abrió en otra conexión. Recarga para iniciar una nueva.'); controls();
  });
  socket.connect(); controls();
}

function showCharacterDecision(character, withSound = false) {
  const messages = {
    approved: 'El DM aprueba tu personaje: ', rejected: 'El DM rechaza tu personaje: ',
    evaluating: 'El DM sigue evaluando tu personaje...', draft: 'Borrador pendiente de evaluación. '
  };
  const rejected = character.status === 'rejected';
  status('character', rejected
    ? 'Rechazado: ' + (character.motivo_rechazo_narrativo || character.narrative || 'Revisa tu historia.')
    : (messages[character.status] || '') + (character.narrative || ''), rejected, true);
  if (withSound && rejected) sfx('reject');
  if (withSound && character.status === 'approved') sfx('approve');
}

async function recoverDecision() {
  if (!token || !socket?.connected) return;
  const expectedToken = token;
  try {
    const data = await request('session:resume', { token: expectedToken });
    if (token !== expectedToken || !session) return;
    session.character = data.character;
    render(data.room);
    if (data.character) showCharacterDecision(data.character, true);
  } catch { /* Reconectar permite recuperar el resultado guardado. */ }
}

async function submit(formId, target, action) {
  if (busy || resuming) return;
  if (!byId(formId).reportValidity()) return;
  busy = true; controls(); status(target, 'Enviando…');
  try { await action(); }
  catch (error) { status(target, error.message, true); }
  finally { busy = false; controls(); }
}
byId('play-button').addEventListener('click', () => showScreen('lobby'));
byId('back-button').addEventListener('click', () => showScreen('home'));
byId('create-button').addEventListener('click', () => openPanel('create'));
byId('join-button').addEventListener('click', () => openPanel('join'));
document.querySelectorAll('[data-close-panel]').forEach(button => button.addEventListener('click', () => closePanels(true)));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && activePanel && !byId('options-dialog').open) closePanels(true);
});
byId('options-button').addEventListener('click', () => {
  byId('backend-url').value = backend;
  byId('options-dialog').showModal();
});
byId('server-form').addEventListener('submit', event => {
  event.preventDefault();
  if (token || session || busy || resuming) return status('server', 'Sal de la sala antes de cambiar el servidor.', true);
  try {
    const url = new URL(byId('backend-url').value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('Usa una URL base HTTP(S), sin ruta, credenciales ni parámetros.');
    if (location.protocol === 'https:' && url.protocol !== 'https:') throw new Error('Desde HTTPS necesitas un backend HTTPS.');
    backend = url.origin; storage.set('cronicas.backend', backend);
    status('server', ''); byId('options-dialog').close(); connect();
  } catch (error) { status('server', error.message, true); }
});
byId('random-premise-button').addEventListener('click',async () => {
  if(busy||resuming||session)return;
  if(!window.confirm('¿Enviar la configuración de campaña a Gemini para generar una premisa? Consume API y sustituirá el texto si no lo editas mientras tanto.'))return;
  const original=byId('story-premise').value;
  busy=true;controls();status('random','El escriba está forjando tu campaña…');
  try {
    const world={storyName:byId('story-name').value.trim()||'Nueva campaña',premise:original,
      redLines:byId('red-lines').value,magicLevel:byId('magic-level').value,
      adventureTone:byId('adventure-tone').value,mortality:byId('mortality').value};
    const data=await request('premise:generate',{world});
    if(session)throw new Error('La sesión cambió; no se insertó la premisa.');
    if(byId('story-premise').value!==original)throw new Error('Editaste el texto durante la generación; no se sobrescribió.');
    byId('story-premise').value=data.premise;
    status('random','Premisa generada por Gemini. Revísala antes de crear la sala.');
  } catch(error) {status('random',error.message,true);}
  finally {busy=false;controls();}
});
byId('wipe-button').addEventListener('click',async()=> {
  if(busy||resuming||!session?.isHost)return;
  const code=window.prompt('BORRADO IRREVERSIBLE: se eliminarán sala, personajes, NPCs, sesiones, chat, acciones y tiradas. Escribe el código '+session.room.code+' para confirmar.');
  if(code!==session.room.code)return;
  busy=true;controls();
  try {await request('room:wipe',{confirmCode:code});clearSession();showScreen('lobby');status('join','Sala borrada.');}
  catch(error){if(session)status('session',error.message,true);}
  finally {busy=false;controls();}
});
byId('npc-button').addEventListener('click',()=> {
  if(!session?.isHost||busy||resuming)return;
  status('npc','');byId('npc-dialog').showModal();byId('npc-name').focus();
});
byId('npc-close').addEventListener('click',()=>byId('npc-dialog').close());
byId('npc-form').addEventListener('submit',async event=> {
  event.preventDefault();if(busy||resuming||!session?.isHost)return;
  busy=true;controls();status('npc','Añadiendo NPC…');
  try {
    await request('npc:add',{name:byId('npc-name').value,history:byId('npc-history').value});
    byId('npc-form').reset();byId('npc-dialog').close();status('session','NPC añadido al final de la cola.');
  }catch(error){status('npc',error.message,true);}
  finally{busy=false;controls();}
});
for (const [id, target] of [['create-form', 'create'], ['join-form', 'join'], ['character-form', 'character']]) {
  byId(id).addEventListener('input', event => {
    if (!busy) status(target, '');
    if (event.target.id === 'story-premise') status('random', '');
  });
}
byId('create-form').addEventListener('submit', event => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  submit('create-form', 'create', async () => {
    const { playerName, ...world } = fields;
    accept(await request('room:create', { playerName, world }));
    status('create', '');
  });
});
byId('join-form').addEventListener('submit', event => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  fields.code = fields.code.toUpperCase();
  byId('room-code').value = fields.code;
  submit('join-form', 'join', async () => {
    accept(await request('room:join', fields));
    status('join', '');
  });
});
byId('character-form').addEventListener('submit', event => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  fields.publicConsent=byId('public-consent').checked;
  fields.portraitConsent=byId('portrait-consent').checked;
  submit('character-form', 'character', async () => {
    const expectedToken = token;
    try {
      const data = await request('character:submit', fields);
      if (token !== expectedToken || !session) return;
      session.character = data.character;
      showCharacterDecision(data.character, true);
    } catch (error) {
      if (token === expectedToken && session) await recoverDecision();
      throw error;
    }
  });
});
byId('start-button').addEventListener('click', async () => {
  if (busy || resuming || !session?.isHost || !session.room.canStart) return;
  busy = true; controls();
  try {
    const data = await request('adventure:start', {});
    if (session) render(data.room);
  } catch (error) { status('session', error.message, true); }
  finally { busy = false; controls(); }
});
byId('copy-code').addEventListener('click', async () => {
  if (!session) return;
  try {
    await navigator.clipboard.writeText(session.room.code);
    status('session', 'Código copiado.');
  } catch { status('session', 'No se pudo copiar. Selecciona el código y cópialo manualmente.', true); }
});
byId('leave-button').addEventListener('click', async () => {
  if (busy || resuming || !session) return;
  if (!window.confirm(session.isHost ? '¿Cerrar la sala para todo el grupo?' : '¿Salir y eliminar tu personaje de esta sala?')) return;
  busy = true; controls();
  try {
    await request('room:leave', {});
    clearSession(); showScreen('lobby');
  } catch (error) { status('session', error.message, true); }
  finally { busy = false; controls(); }
});

const chatMessages = new Map();
let pendingAction = null;
function ownsTurn() {
  const t=session?.room.turn;
  return Boolean(session&&(t?.memberId===session.memberId || session.isHost&&session.room.members.some(m=>m.id===t?.memberId&&m.isNPC)));
}
function turnTarget() {
  return ownsTurn()&&session.room.turn.memberId!==session.memberId ? {memberId:session.room.turn.memberId} : {};
}
function gameControls(disabled) {
  const t = session?.room.turn;
  const mine = session?.room.phase === 'playing' && ownsTurn();
  byId('action-text').disabled = disabled || !mine || Boolean(t?.action);
  byId('action-send').disabled = disabled || !mine || Boolean(t?.action);
  byId('action-retry').hidden = !mine || t?.action?.status !== 'failed';
  byId('action-retry').disabled = disabled;
  byId('history-button').disabled = disabled || !chatMessages.size;
  byId('roll-button').hidden = !mine || t?.action?.stage !== 'awaiting_roll';
  byId('roll-button').disabled = disabled || rolling;
  byId('roll-button').textContent = rolling ? 'Dados en movimiento…' : cachedRoll(t?.action?.id) ? 'Enviar tirada guardada' : 'Lanzar Dados';
}

const chatNodes = new Map();
const typing = new Set();
let chatPrimed = false, newestSeen = 0, skipEpoch = 0, followChat = true;
let typeQueue = Promise.resolve();
function stickBottom() {
  const c = byId('narrative-chat');
  if (followChat) c.scrollTop = c.scrollHeight;
}
function skipTyping() { skipEpoch++; for (const finish of [...typing]) finish(); }
function typewrite(el, text, epoch) {
  return new Promise(resolve => {
    const done = () => { el.textContent = text; el.classList.remove('typing'); stickBottom(); resolve(); };
    if (reducedMotion.matches || epoch !== skipEpoch || !el.isConnected) return done();
    const step = Math.max(1, Math.ceil(text.length / 700)); 
    let i = 0, ticks = 0;
    const finish = () => { clearInterval(timer); typing.delete(finish); done(); };
    const timer = setInterval(() => {
      if (!el.isConnected) return finish();
      i = Math.min(text.length, i + step);
      el.textContent = text.slice(0, i);
      if (ticks++ % 3 === 0 && !/\s/.test(text[i - 1] || ' ')) sfx('type');
      stickBottom();
      if (i >= text.length) finish();
    }, 22);
    typing.add(finish);
  });
}
function buildMessage(message, animate) {
  const item = document.createElement('article'); item.className = 'chat-message'; item.dataset.kind = message.kind;
  const title = document.createElement('strong');
  title.textContent = message.authorName + ' · ' + new Date(message.createdAt).toLocaleString();
  const body = document.createElement('p');
  if (!animate) body.textContent = message.text;
  else {
    const sr = document.createElement('span'); sr.className = 'sr-only'; sr.textContent = message.text;
    const visual = document.createElement('span'); visual.className = 'typing'; visual.setAttribute('aria-hidden', 'true');
    body.append(sr, visual); item.classList.add('is-new');
    const epoch = skipEpoch;
    typeQueue = typeQueue.then(() => typewrite(visual, message.text, epoch));
  }
  item.append(title, body);
  return item;
}
function drawChat() {
  const container = byId('narrative-chat');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
  let maxId = newestSeen;
  const nodes = [...chatMessages.values()].sort((a, b) => a.id - b.id).map(message => {
    let node = chatNodes.get(message.id);
    if (!node) {
      node = buildMessage(message, chatPrimed && message.kind === 'ai' && message.id > newestSeen);
      chatNodes.set(message.id, node);
    }
    maxId = Math.max(maxId, message.id);
    return node;
  });
  newestSeen = maxId; chatPrimed = true;
  container.replaceChildren(...nodes); 
  if (nearBottom) container.scrollTop = container.scrollHeight;
}
byId('narrative-chat').addEventListener('click', skipTyping);
byId('narrative-chat').addEventListener('scroll', event => {
  const c = event.currentTarget;
  followChat = c.scrollHeight - c.scrollTop - c.clientHeight < 100;
});

function renderGame(room) {
  if (room.phase !== 'playing') return;
  for (const m of room.messages || []) chatMessages.set(m.id,m);
  drawChat();
  renderRoll(room.turn.action);
  const t = room.turn;
  const owner = room.members.find(m => m.id === t.memberId);
  const mine = ownsTurn();
  byId('turn-status').textContent = t.action?.stage === 'awaiting_roll'
    ? `Esperando la tirada de ${owner?.name || 'participante'}. La configuración está guardada en SQLite.`
    : t.action?.status === 'pending'
    ? `${t.action.stage === 'resolution' ? 'El Director IA está resolviendo la tirada' : 'El Director IA está evaluando la acción'} de ${owner?.name || 'participante'}...`
    : t.action?.status === 'failed'
      ? `La narración se interrumpió. El turno de ${owner?.name} se conserva y su acción puede reintentarse.`
      : mine ? (owner?.isNPC ? 'Controlas a '+owner.name+'. Escribe su acción como Director.' : 'Es tu turno. Describe tu acción.') : `Esperando el turno de ${owner?.name || 'participante'}...${owner?.connected ? '' : ' Está desconectado; no se salta su turno.'}`;
  const list = t.order.map((id,index) => {
    const m = room.members.find(x => x.id === id),item = document.createElement('li');
    if(id === t.memberId) item.className = 'current-turn';
    item.textContent = `${index+1}. ${m?.name || 'Participante'}${m?.isHost ? ' (Director)' : m?.isNPC ? ' (NPC · Director)' : ''} — ${m?.connected ? 'Conectado' : 'Desconectado'}${id === t.memberId ? ' · Turno actual' : ''}`;
    return item;
  });
  byId('game-member-list').replaceChildren(...list);
  decorateMembers(byId('game-member-list'),t.order.map(id=>room.members.find(m=>m.id===id)));
}

let rolling = false;
function cachedRoll(id) {
  if(!id) return null;
  try { return JSON.parse(storage.get('cronicas.roll.'+id)); } catch {return null;}
}
function renderRoll(action) {
  const config=action?.pendingRoll;
  byId('roll-panel').hidden = !config;
  if(!config) return;
  byId('roll-prelude').textContent = config.narrativa_previa;
  byId('roll-dice').textContent = 'Dados: '+config.dados_a_lanzar.join(' + ');
  const terms=config.modificadores.map(m=>`${m.valor>=0?'+':''}${m.valor}`).join(' ');
  byId('roll-equation').textContent = `CD final = limitar(1..100, ${config.cd_base} − (${terms || '0'})) = ${config.cd_final}. Éxito: suma ≥ ${config.cd_final}`;
  const nodes=config.modificadores.map(m=> {
    const li=document.createElement('li');li.className='mod-'+m.tipo;
    li.textContent=`${m.nombre}: ${m.valor>0?'+':''}${m.valor} · ${m.tipo} (${m.tipo==='ventaja'?'reduce':'aumenta'} CD)`;
    return li;
  });
  byId('roll-modifiers').replaceChildren(...nodes);
  const results=action.rollResults || cachedRoll(action.id);
  byId('roll-result').textContent = results
    ? `Resultados: ${results.resultados.map(r=>`d${r.caras}:${r.valor}`).join(', ')}. Total: ${results.total}. ${action.rollResults ? (results.total>=config.cd_final ? 'Éxito.' : 'Fallo.') : 'Pendiente de confirmación en servidor.'}`
    : 'Tirada pendiente. No se avanza el turno.';
}
byId('roll-button').addEventListener('click',async()=> {
  const action=session?.room.turn.action;
  if(busy || resuming || rolling || action?.stage!=='awaiting_roll' || !ownsTurn()) return;
  const expectedToken=token,version=session.room.turn.version;
  busy=true;rolling=true;controls();status('action','Preparando dados 3D…');
  try {
    let saved=cachedRoll(action.id);
    if(!saved) {
      const {rollDice}=await import(diceModuleURL);
      saved=await rollDice(action.pendingRoll.dados_a_lanzar);
      storage.set('cronicas.roll.'+action.id,JSON.stringify(saved));
    }
    if(token!==expectedToken || !session) throw new Error('La sesión ha cambiado.');
    renderRoll(session.room.turn.action);
    await request('roll:submit',{id:action.id,turnVersion:version,...saved,...turnTarget()});
    status('action','Tirada guardada en SQLite. Esperando consecuencia final…');
    await recoverDecision(); 
  } catch(error) {
    status('action',error.message+' Si hay resultados guardados, vuelve a enviarlos; no repitas el lanzamiento.',true);
    if(token===expectedToken && socket?.connected) await recoverDecision();
  } finally {rolling=false;busy=false;controls();}
});
byId('action-form').addEventListener('submit', event => {
  event.preventDefault();
  submit('action-form','action',async () => {
    const content = byId('action-text').value.trim();
    const version = session.room.turn.version;
    if(!pendingAction || pendingAction.turnVersion !== version || pendingAction.text !== content) {
      pendingAction = {id:crypto.randomUUID(),turnVersion:version,text:content,...turnTarget()};
    }
    const result = await request('action:submit',pendingAction);
    byId('action-text').value = ''; pendingAction = null;
    status('action',result.status === 'failed' ? 'Acción guardada; reintenta la narración.' : 'Acción guardada en SQLite.');
  });
});
byId('action-retry').addEventListener('click',async () => {
  if(busy || resuming || !session?.room.turn.action) return;
  busy = true; controls();
  try { await request('action:retry',{id:session.room.turn.action.id,...turnTarget()}); status('action','Reintentando la narración...'); }
  catch(error) { status('action',error.message,true); }
  finally { busy = false; controls(); }
});
byId('history-button').addEventListener('click',async () => {
  if(busy || resuming || !chatMessages.size) return;
  busy = true; controls();
  try {
    const before = Math.min(...chatMessages.keys());
    const data = await request('chat:history',{before});
    for(const m of data.messages) chatMessages.set(m.id,m);
    drawChat();
    status('action',data.messages.length ? 'Mensajes anteriores recuperados.' : 'No hay mensajes anteriores.');
  } catch(error) { status('action',error.message,true); }
  finally { busy = false; controls(); }
});

initSocial();
try { audio?.bindUISounds?.(); } catch { /* Audio opcional. */ }
connect();
'use strict';
const byId = id => document.getElementById(id);
const panels = { create: byId('panel-create'), join: byId('panel-join') };
const storage = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* Sin recuperación tras recarga. */ } },
  remove(key) { try { sessionStorage.removeItem(key); } catch { /* Almacenamiento no disponible. */ } }
};
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
function status(name, message, error = false) {
  const element = byId(`${name}-status`);
  element.textContent = message;
  element.dataset.error = String(error);
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
  byId('start-button').disabled = disabled || !session?.room.canStart;
}
function ownMember() { return session?.room.members.find(m => m.id === session.memberId); }
function request(event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error('Sin conexión con el servidor.'));
    const requestSocket = socket;
    const version = generation;
    requestSocket.timeout(event === 'character:submit' ? 60000 : 10000).emit(event, payload, (error, response) => {
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
  storage.remove('cronicas.token');
  byId('character-form').reset();
  status('character', '');
  status('session', '');
  byId('member-list').replaceChildren();
  byId('session-code').textContent = '';
  byId('world-summary').textContent = '';
  byId('starting-panel').hidden = true; byId('start-button').hidden = true;
}
const labels = {
  high: 'Alta Magia', low: 'Baja Magia', none: 'Sin Magia',
  epic: 'Épico', dark: 'Oscuro/Letal', comic: 'Cómico',
  live: 'En vivo', async: 'Asíncrono/Foro', story: 'Modo Historia', relentless: 'Modo Implacable'
};
function render(room) {
  if (!session) return;
  session.room = room;
  byId('session-code').textContent = room.code;
  byId('session-role').textContent = session.isHost ? 'Anfitrión' : 'Jugador';
  const starting = room.phase === 'starting';
  byId('session-title').textContent = starting ? 'La partida está comenzando...' :
    (session.isHost ? 'Sala de Espera' : 'Creación de Personaje');
  byId('character-panel').hidden = session.isHost || starting;
  byId('starting-panel').hidden = !starting;
  byId('start-button').hidden = !session.isHost || starting;
  byId('leave-button').textContent = session.isHost ? 'Cerrar sala para todos' : 'Salir de la sala';
  const w = room.world;
  byId('world-summary').textContent = `${w.storyName}\n${[w.magicLevel, w.adventureTone, w.turnPace, w.mortality].map(v => labels[v] || v).join(' · ')}\nPremisa: ${w.premise || 'No especificada'}\nLíneas rojas: ${w.redLines || 'No especificadas'}\nCaduca: ${new Date(room.expiresAt).toLocaleString()}`;
  const nodes = room.members.map(member => {
    const item = document.createElement('li');
    item.textContent = `${member.name}${member.isHost ? ' · Anfitrión' : ''}${member.id === session.memberId ? ' · Tú' : ''} — ${member.connected ? 'Conectado' : 'Desconectado (reserva temporal)'}${!member.isHost ? ` · ${{ draft: 'Creando personaje', evaluating: 'Evaluando con el DM...', rejected: 'Rechazado: requiere cambios', approved: 'Aprobado' }[member.characterStatus] || 'Creando personaje'}${member.characterName ? ': ' + member.characterName : ''}` : ''}`;
    return item;
  });
  byId('member-list').replaceChildren(...nodes);
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
    showCharacterDecision(data.character);
  }
  showScreen('session');
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
      // No borrar una sesión ante cortes de red o ausencia de confirmación.
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
    connection('Sin conexión. Reconexión automática; reserva de sesión de 15 minutos.'); controls();
  });
  socket.on('room:state', room => {
    if (session && room.code === session.room.code) {
      const wasEvaluating = ownMember()?.characterStatus === 'evaluating';
      render(room);
      if (wasEvaluating && ownMember()?.characterStatus !== 'evaluating' && !busy) recoverDecision();
    }
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

function showCharacterDecision(character) {
  const messages = {
    approved: 'El DM aprueba tu personaje: ', rejected: 'El DM rechaza tu personaje: ',
    evaluating: 'El DM sigue evaluando tu personaje...', draft: 'Borrador pendiente de evaluación. '
  };
  status('character', (messages[character.status] || '') + (character.narrative || ''),
    character.status === 'rejected');
}
async function recoverDecision() {
  if (!token || !socket?.connected) return;
  const expectedToken = token;
  try {
    const data = await request('session:resume', { token: expectedToken });
    if (token !== expectedToken || !session) return;
    session.character = data.character;
    render(data.room);
    if (data.character) showCharacterDecision(data.character);
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
byId('random-premise-button').addEventListener('click', () => {
  byId('story-premise').value = 'Un grupo de mercenarios busca una reliquia en ruinas subterráneas.';
  status('random', 'Premisa fija insertada; no se utilizó IA.'); status('create', '');
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
  submit('character-form', 'character', async () => {
    const expectedToken = token;
    try {
      const data = await request('character:submit', fields);
      if (token !== expectedToken || !session) return;
      session.character = data.character;
      showCharacterDecision(data.character);
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
connect();

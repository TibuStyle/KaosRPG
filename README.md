# Crónicas 1.4 — Persistencia y motor asíncrono estricto

Proyecto completo basado en v1.3. Express / Socket.io, aprobación OpenAI y tablero
narrativo por turnos con SQLite local. No hay selector de ritmo ni modo en vivo.

## Instalación local

1. Instala Node.js >=22 y ejecuta `npm install` desde la raíz del proyecto.
   Se añade `better-sqlite3` 11.10.0; es un módulo nativo. Si no hay binario
   precompilado para tu plataforma, instala las herramientas de compilación de
   Node (Python, compilador C/C++ y herramientas del sistema). Conserva y
   commitea el `package-lock.json` real generado. No se entrega uno inventado.
2. Copia `.env.example` a `.env` y configura `OPENAI_API_KEY` en el backend.
3. Ejecuta `npm run check`, `npm test`, `npm start`.
4. Abre `http://localhost:3000` como host y en otro navegador como jugador.

Sin clave, funcionan creación, unión y recuperación, pero no aprobación ni
narración. No hay aprobación simulada ni bypass en producción.
La instalación de dependencias y pruebas Node no se ejecutaron en el entorno de
entrega; consulta `Verification.txt`. No se incluyen node_modules ni una DB con
sesiones reales.

## SQLite: datos durables y operación

`SQLITE_PATH=./data/cronicas.sqlite` indica el archivo local (por defecto,
`data/cronicas.sqlite` junto al código). Se crea automáticamente al iniciar.
`db.js` configura foreign_keys, WAL, synchronous=FULL, busy_timeout y una
migración inicial transaccional, identificada por PRAGMA user_version=1.
Un formato más reciente provoca error en lugar de sobrescribirlo.

Tablas relacionales: rooms, members, sessions, characters, traits, turn_order,
actions, messages y rate_limits. Configuración, miembros, historias, decisiones,
rasgos secretos, sesión, orden, turno, acciones y chat se consultan/actualizan en
SQLite; no hay mapas RAM de salas ni sesiones. Mapas en memoria solo contienen
AbortControllers de trabajos IA y límites de transporte. La presencia se registra
en SQLite, pero sus socket_id son efímeros y se invalidan en cada arranque.

Tokens: 256 bits, sessionStorage por pestaña; la DB conserva SHA-256 del token,
no su texto en claro. Se puede recuperar con el mismo token tras reinicio. Los
hashes tampoco aparecen en snapshots ni prompts. El token sigue siendo una
credencial bearer, no una identidad autenticada. Perder/borrar sessionStorage o
cerrar una pestaña puede perder el acceso: no hay cuentas ni recuperación de
credenciales. No publicar la DB: contiene historias y rasgos en texto claro.

Al reiniciar: todos offline, evaluaciones interrumpidas vuelven a draft (requieren
reenviar), acciones pending pasan a failed, turno y acción se conservan. Resultados
approved/rejected completados, perks/defectos y chat siguen intactos. Apagar no
cierra ni elimina salas. No hay TTL de 24 h, reserva de 15 min ni expulsión por
inactividad. La sala se borra por cierre explícito del host, con cascadas.

**Solo una instancia de servidor por archivo SQLite.** Dos procesos invalidarían
presencia/recuperación y no compartirían broadcasts ni trabajos. No usar PM2 en
cluster, varias réplicas o un archivo WAL en un filesystem de red. Un adaptador
Socket.io y leases/jobs distribuidos son trabajo futuro.

Para despliegue, montar un volumen persistente para la DB; un disco efímero de
hosting destruye la persistencia. GitHub Pages solo sirve public/ y no SQLite.
No poner la DB bajo public/. Mantener permisos privados en archivo y directorio.
Backup simple: detener servidor y copiar DB; si se hace backup online, usar una
herramienta con SQLite backup API. No copiar solo .sqlite mientras WAL está activo.
Retención, backups automáticos, cifrado y cuentas quedan pendientes.
No se puede migrar lo que v1.3 ya perdió de RAM: la DB comienza vacía.

## Core loop: cola ininterrumpible

- Solo host inicia desde lobby, con al menos un jugador y todos los jugadores
  conectados y aprobados. Host no necesita personaje.
- Se fija y persiste el orden: host (Director), jugadores por orden de unión.
- La fase cambia a playing y se abre Vista de Partida: chat, barra lateral con
  participantes/conexión/orden, input y estado del turno.
- El Director escribe la primera acción o planteamiento; la IA continúa después
  de cada acción. No se genera una apertura automática facturable al pulsar inicio.
- Solo el participante actual puede enviar. El servidor comprueba membresía,
  conexión vigente, fase, propietario y versión del turno; el DOM no autoriza.
- Acción, mensaje y estado pending se guardan en una transacción antes de la IA.
  El texto de la acción pasa a ser público: no introducir datos sensibles.
- Durante IA el input queda bloqueado para todos. Respuesta narrativa validada,
  mensaje IA, finalización y avance circular se guardan en una sola transacción.
- Desconexión, demora, error técnico o reinicio no saltan ni pasan el turno.
  La IA puede terminar después de una desconexión del autor, si la acción ya
  estaba enviada. El siguiente turno se asigna incluso a alguien offline y espera.
- Si la IA falla, el autor ve un botón para reintentar la misma acción. No se vuelve
  a publicar el mensaje del jugador ni se altera la acción ya guardada.
- No hay chat libre paralelo, timeout de turno, votación de salto o cambio de orden.
  En playing, jugadores no pueden eliminar su plaza/personaje: pueden ausentarse
  cerrando la pestaña o desconectándose. Solo el host puede cerrar para todos.
  Si se pierde definitivamente un token, la partida puede quedar bloqueada;
  diseñar recuperación autenticada antes de un servicio público.

## Contrato Socket.io

Solicitudes con ACK `{ok:true,data}` / `{ok:false,error}`:

- `room:create {playerName,world}`. World exacto: storyName, premise, redLines,
  magicLevel, adventureTone, mortality. No campo de ritmo; claves extra rechazadas.
- `room:join {playerName,code}` solo en lobby.
- `session:resume {token}`: token propio, memberId, isHost, snapshot y personaje
  propio (nombre, historia, status y narrativa; nunca rasgos).
- `character:submit {name,history}`: aprobación original conservada, 45 s de
  timeout API / 60 s ACK cliente, JSON mode y validación estricta en approval.js.
- `adventure:start {}`: solo host; fija orden y playing transaccionalmente.
- `action:submit {id,turnVersion,text}`: ID UUID y texto hasta 2000 caracteres.
  ACK inmediato tras persistencia; narración llega por room:state. Repetir mismo
  ID/datos devuelve el resultado existente sin repetir API/mensaje/avance.
  Un ID con datos distintos se rechaza; UNIQUE(room_code,turn_version) impide dos
  acciones distintas del mismo turno, incluidas solicitudes concurrentes.
- `action:retry {id}`: solo autor del turno actual para una acción failed.
- `chat:history {before}`: página de hasta 100 mensajes anteriores al ID indicado,
  ascendente. Snapshot incluye los 100 últimos; los anteriores permanecen en DB.
- `room:leave {}`: jugador elimina su plaza solo en lobby; host borra sala completa.
- Eventos de servidor: room:state, room:closed {reason}, session:replaced.

Snapshot incluye world, phase, canStart, members públicos, turn {order,memberId,
version,action} y messages públicos. No contiene historias, narrativa de aprobación,
perks/defectos, token/hash ni conexión interna. Una conexión reemplaza la anterior.
No se garantiza idempotencia de crear/unirse si se pierde su ACK; sigue pendiente.

## OpenAI y privacidad

SDK openai 4.77.0; OPENAI_MODEL=gpt-4o-mini configurable. Facturación de API externa.
Aprobación mantiene prompt y validación estricta v1.3 en approval.js.
Narración: JSON exacto {narrativa:string}, 1..5000 caracteres, salida completa,
validada antes del commit. Contexto limitado a los 20 últimos mensajes del snapshot;
la DB conserva el historial completo, pero la IA puede olvidar hechos antiguos.
Se envían mundo y texto de acciones/chat público a OpenAI; no tokens ni rasgos
secretos. Aprobación sí envía la historia del propietario. No incluir datos sensibles.
Tratamiento de entradas como datos y restricciones en prompts no garantizan
moderación semántica ni resistencia absoluta a prompt injection. Revisión humana,
moderación y resúmenes de memoria narrativa siguen pendientes.
No hay atributos, CD, tiradas autorizadas ni combate formal: narración textual.

Límites: 8 jugadores + host, 1000 salas, 40 eventos/min por conexión, payload
32 KiB, HTTP 180/min, handshakes 120/min/IP. IA: cuatro trabajos concurrentes,
tres/min por miembro, diez/min por sala (aprobación y narración comparten cuotas
persistentes). Un turno solo tiene una acción en curso. SDK sin reintentos automáticos.
Un reintento tras fallo/reinicio puede generar otro coste: no hay exactly-once con
el proveedor, aunque sí deduplicación y avance atómico en la DB local.

## Despliegue y aceptación

Workflow Pages conservado; backend separado con HTTPS, volumen local persistente,
NODE_ENV=production, FRONTEND_ORIGINS con orígenes HTTPS exactos.
Configurar URL base HTTPS desde Opciones / Servidor. TRUST_PROXY_HOPS solo según
proxy real. Helmet, allowlist y validación de Origin WebSocket se conservan.
El frontend carga Socket.io desde CDN; requiere acceso a ese CDN.

`npm test` contiene esquema/recuperación con better-sqlite3 real y pruebas de
Socket.io + DB reales con proveedor OpenAI simulado, sin coste de API. El mock
solo está en test/mock-server.cjs y nunca se carga con npm start.

Aceptación manual tras ejecutar check/test:
1. Crear, unir, rechazar/aprobar con proveedor real; verificar secretos en red.
2. Iniciar: host primero, input de otros bloqueado; servidor rechaza envío intruso.
3. Enviar acción, esperar narrativa, comprobar avance circular exactamente una vez.
4. Desconectar jugador actual: nadie puede saltarlo; reconectar con su token.
5. Apagar/reiniciar backend usando misma DB: recuperar personajes, chat y turno.
6. Interrumpir IA de acción: recuperar failed, reintentar mismo texto, un solo avance.
7. Probar doble click/ACK perdido, claves erróneas, JSON inválido y cuotas.
8. Revisar móvil, teclado, CORS/HTTPS, rendimiento y límites en entorno real.

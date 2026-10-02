# CRÓNICAS v1.8 — Forja del Director

Fuente actualizada desde el consolidado v1.7. Estado: **implementación no certificada en producción**.
No se abrió ni verificó https://kaosrpg.onrender.com/; no hay navegador/herramienta web disponible.
El feedback de funcionamiento v1.7 proviene del Director, no de una comprobación de esta entrega.

## Arranque y actualización

Requiere Node >=22. En un entorno con red:

```sh
npm install
npm run check
npm test
npm start
```

`postinstall` genera los assets locales de DiceBox. Versiona el `package-lock.json` real que genere
npm; no se ha inventado ni incluido un lockfile. No se incluyen node_modules ni binarios de terceros.
Configura `.env` desde `.env.example`: `GEMINI_API_KEY`, un `GEMINI_MODEL` disponible elegido
explícitamente, `FRONTEND_ORIGINS`, `SQLITE_PATH` y `POLLINATIONS_ENABLED` según el despliegue.
El nombre de modelo heredado es un ejemplo, no una garantía de disponibilidad actual.

Render: build `npm install`, start `npm start`, **una sola instancia**, HTTPS, SQLite en disco
persistente FUERA de `public`. Guarda los secretos en Render, nunca en el repositorio.
`/health` devuelve versión `1.8.0`. Frontend Pages conserva workflow y rutas relativas.
Consulta `README_v1.7.md` y `README_v1.6.md` para detalles heredados de DiceBox/Workers/WASM.

### Migración

Haz un backup consistente antes de arrancar y ensaya restore. El servidor ejecuta las migraciones
heredadas y v3→v4 transaccional. Añade `members.is_npc` y
`characters.motivo_rechazo_narrativo`. Conserva acciones, tiradas, cola, sesiones y mochila.
Los rechazos heredados copian `narrative` al nuevo motivo. **No uses v1.7 con una DB v4**;
para volver atrás restaura un backup compatible. No se modifica tu servidor desde esta entrega.

## Novedades

- UI sin fondo cuadriculado: bóveda oscura azul/pizarra, luz cálida, pergamino envejecido,
  contenedores de 4px y botones metálicos. Todo con CSS local, sin assets externos nuevos.
- Economía de Rasgos en aprobación: ventajas extremas requieren defectos críticos explícitos
  y relevantes. El balance no levanta prohibiciones del lore ni líneas rojas. Es un criterio
  SEMÁNTICO de Gemini, no un balance numérico demostrado ni un sistema de puntos.
- `motivo_rechazo_narrativo` obligatorio y no vacío en rechazos; vacío en aprobación.
  Se persiste y se muestra como «Rechazado: …» en alerta accesible; fallos del proveedor
  siguen siendo errores técnicos, no rechazos.
- Host: **Borrar Sala**, confirmando su código, elimina la campaña y revoca sesiones.
  «Cerrar sala para todos» conserva su comportamiento destructivo anterior.
- Host: **Añadir NPC** con nombre/historia públicos; máximo 12 por sala. Sin aprobación IA,
  retrato, rasgos ni equipo inferidos. Se puede iniciar con Host + NPC(s), sin humanos.
  Los NPCs no consumen las 8 plazas de jugadores humanos. En partida se añaden al final
  de la cola conservando participante actual y versión. NPCs no tienen token/socket propio.
  Solo el Host escribe sus acciones, tira y reintenta cuando les toca. Las acciones se
  evalúan y resuelven con Gemini igual que las demás; no se salta la cola.
- **Generar premisa** reemplaza Random: llamada backend Gemini antes de crear sala,
  3 o 4 párrafos, máximo 2000 caracteres, teniendo en cuenta las reglas seleccionadas.
  Confirma el envío externo; si falla o editas mientras genera, no sobrescribe el texto.
  Sin fallback fijo ni retry automático. Timeout del proveedor 45s, ACK frontend 60s.

## API Socket.io nueva / ampliada

Los eventos usan el ACK heredado `{ok,data}` o `{ok:false,error}`.

- `premise:generate` → `{world}` con las seis claves del contrato de sala; responde `{premise}`.
  Solo antes de tener sesión. Hasta 3 peticiones/minuto por dirección de conexión y
  10/minuto globales, contando fallos. Máximo 4 trabajos IA simultáneos compartidos con motor.
  Detrás de proxy la IP de conexión puede ser compartida: el límite es conservador;
  no confía en X-Forwarded-For sin una infraestructura verificada. Esta API es pública,
  puede consumir cuota; no sustituye autenticación, captcha ni un límite de gasto del proveedor.
- `room:wipe` → `{confirmCode}`. Servidor verifica Host autenticado y código de SU sala.
- `npc:add` → `{name,history}`. Solo Host. Nombre 1–60, historia 1–6000 caracteres.
- `action:submit`, `action:retry`, `roll:submit`: admiten `memberId` opcional para el NPC.
  Se permite el propio miembro o un NPC de la misma sala controlado por el Host;
  jamás otro jugador humano. El presupuesto de IA se carga al Host, no por cada NPC.
- Snapshot público incorpora `isNPC`. La conexión de un NPC refleja la conexión del Host.
  NPCs no son destinatarios de susurros; mochila/chat conservan aislamiento y privacidad.

## Borrado: alcance y precauciones

El borrado de sala y datos relacionados es atómico vía cascadas FK: miembros, personajes,
rasgos, estados, sesiones, turnos, acciones, resultados, historial narrativo y chat humano.
También elimina contadores de sala/miembro/chat de campaña y aborta lógicamente trabajos IA.
Emite `room:closed`, expulsa sockets del canal y limpia tokens activos; los sockets pueden
seguir conectados al transporte para crear otra sala. No borra otras campañas ni backups.
**No es borrado forense** del disco/WAL/backups ni elimina datos ya enviados a proveedores.
Cancelar un trabajo no garantiza anular la facturación externa. No hay recuperación desde la UI.

## Verificación y aceptación

Ver `Verification_v1.8.txt`. Se ejecutó SQL real extraído con SQLite Python y checks estáticos.
**No se ejecutaron Node/npm, tests JavaScript, build, navegador, Socket runtime ni APIs reales.**
Los tests entregados son código de pruebas, NO resultados aprobados. El mock Gemini es solo
para tests; el bypass NPC es autorización Host explícita, no un bypass de jugadores.

Antes de producción: ejecutar check/tests/build; ensayar migración/backup/restore; validar
premisas 3–4 párrafos y rechazos con Gemini real; Host/NPC con tiradas, retry, desconexión,
reinicio e idempotencia; wipe con clientes de otras salas y trabajos activos; teclado/móvil,
contraste visual, retratos, dados 3D, Pages subruta, Render HTTPS y persistencia de disco.

## Limitaciones conservadas

Cola estricta sin saltos, dados cliente manipulables, sin cuentas/HP/combate formal,
moderación garantizada, economía antitrampas ni privacidad semántica certificada.
Chat sin E2EE: el operador puede leer DB. No TTL automático. Gemini puede equivocarse
sobre lore/balance o líneas rojas; el Director debe revisar. Pollinations permanece sin
verificación en vivo de disponibilidad, autenticación, condiciones ni calidad visual.

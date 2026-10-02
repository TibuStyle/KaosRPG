# Crónicas 1.3 — Game Master Engine

MVP de preparación multijugador. La IA evalúa personajes; no se ejecutan aventuras todavía.

## Instalación
1. Node.js >=22. Ejecuta `npm install` y conserva el `package-lock.json` generado.
2. Copia `.env.example` a `.env`. Configura `OPENAI_API_KEY` solo en el backend.
3. `npm run check`, `npm test`, `npm start`.
4. Abre `http://localhost:3000` en dos navegadores independientes: anfitrión y jugador.

Modelo predeterminado: `gpt-4o-mini` (familia GPT-4, modo JSON). `OPENAI_MODEL`
permite elegir `gpt-4-turbo` o `gpt-3.5-turbo` si tu cuenta y ese modelo siguen
admitiendo Chat Completions y `response_format: json_object`. No todos los modelos
son compatibles. Si cambias el modelo, verifica compatibilidad y límites.
La disponibilidad de modelos depende de OpenAI. SDK fijado: openai 4.77.0.
La API tiene facturación independiente. Sin clave, funcionan las salas pero
la evaluación informa que el administrador debe configurar la IA.

## Privacidad y aprobación
- El servidor envía a OpenAI el nombre/historia y la configuración del mundo,
  incluidas premisa y líneas rojas. No envía tokens de sesión ni claves en el prompt.
- JSON mode garantiza formato JSON cuando la respuesta termina correctamente,
  no el esquema ni la decisión correcta. El servidor valida claves exactas,
  booleano, longitudes, tipos, duplicados, listas y restricciones de rechazo.
- El prompt trata las entradas como datos y exige respetar las prohibiciones.
  **Una IA no ofrece garantía absoluta contra prompt injection ni detección perfecta
  de líneas rojas.** Se requiere revisión humana y política de moderación antes de
  producción; no confundir validación estructural con comprobación semántica.
- Solo el servidor conserva perks/defectos en `member.gm`. Snapshot y recuperación
  privada usan proyecciones explícitas; nunca exponen esos arrays.
- El grupo conoce nombre y estado, no historia ni mensaje narrativo. El propietario
  recibe historia, estado y mensaje, incluidos tras reconexión.
- Estados: draft, evaluating, rejected, approved. Los fallos técnicos no aprueban
  ni rechazan. Si el texto cambió se conserva como borrador; para el mismo texto
  se recupera el estado previo.

## Contrato Socket.io
Todos los eventos de solicitud requieren ACK: `{ok:true,data}` o `{ok:false,error}`.
- `room:create {playerName,world}`, `room:join {playerName,code}`.
- `session:resume {token}` devuelve sesión y personaje propio, sin rasgos.
- `character:submit {name,history}` espera hasta 45 segundos al proveedor; ACK
  cliente hasta 60 segundos. Devuelve `{character:{name,history,status,narrative}}`.
  Estado público por `room:state`: incluye characterStatus, phase y canStart.
- `adventure:start {}` solo host; exige fase lobby, al menos un jugador y todos
  conectados y aprobados. Cambia phase a starting y publica el estado a todos.
  El frontend muestra “La partida está comenzando...” también tras reconectar.
- `room:leave {}` elimina al jugador; el host cierra la sala.
- `room:closed {reason}` y `session:replaced` mantienen su contrato anterior.

Al comenzar no se admiten nuevas uniones ni modificaciones de personaje.
Los jugadores desconectados bloquean el inicio hasta volver o expirar su reserva.
El host no necesita personaje. El último estado del servidor gobierna el botón;
no se confía en habilitación del cliente.

## Límites y operaciones
Se conservan 8 jugadores más host, 1000 salas, TTL 24 horas, reserva 15 minutos,
limpieza cada 30 segundos, límites HTTP/eventos y mensajes de 32768 bytes.
IA: 4 solicitudes simultáneas por proceso, 1 por jugador, 3/min por jugador y
10/min por sala; sin cola ni reintentos automáticos del SDK. Son límites de
mitigación, no una protección completa de facturación: crea presupuestos/alertas
con el proveedor. Cancelar una solicitud puede no evitar el coste ya generado.
Se cancela al abandonar/cerrar y se descartan resultados de salas caducadas.
La desconexión temporal no cancela la evaluación: el resultado se recupera.
No uses varias instancias sin base de datos/estado compartido y adaptador.
Todo permanece en RAM y se pierde al reiniciar. El token es un secreto de acceso,
no una cuenta autenticada. CORS no equivale a autenticación.

## Despliegue
GitHub Pages publica solo `public/` mediante el workflow incluido.
En Settings > Pages selecciona GitHub Actions. Backend Node separado con HTTPS,
`NODE_ENV=production` y `FRONTEND_ORIGINS=https://tuusuario.github.io` (origen,
no ruta del repositorio). Configura secretos en el proveedor del backend.
Desde Opciones / Servidor usa la URL base HTTPS del backend.
Configura `TRUST_PROXY_HOPS` solo según el proxy real. El límite de handshakes
usa IP del socket: detrás de un proxy puede agrupar usuarios; ajustar la estrategia
con IP fiable antes de producción, sin confiar ciegamente en X-Forwarded-For.
CSP y allowlist se conservan; Socket.io se sirve desde CDN en esta versión.

## Pruebas y aceptación
`npm test` incluye pruebas de servidor con mocks, sin llamadas facturables.
No sustituye integración con dependencias reales ni navegadores.

Recorrido manual necesario:
1. Crear mundo sin magia con líneas rojas claras; unirse como jugador.
2. Enviar historia incompatible: rechazo, mensaje privado y posibilidad de editar.
3. Corregir historia: aprobación, host ve Aprobado, botón habilitado.
4. Añadir segundo jugador: botón deshabilitado hasta aprobarlo.
5. Intentar adventure:start como jugador: error de autorización.
6. Iniciar como host: todos ven la vista temporal; recargar recupera esa fase.
7. Inspeccionar ACKs/room:state: ningún perks/defectos ni historia ajena.
8. Desconectar/reconectar durante IA: resultado propio recuperable.
9. Probar clave ausente/incorrecta, timeout, JSON inválido, exceso de solicitudes,
   cierre de sala durante evaluación y límites de capacidad.
10. Verificar móvil, teclado, HTTPS y CORS desde Pages.

Ver Verification.txt para las comprobaciones efectivamente realizadas en la entrega.

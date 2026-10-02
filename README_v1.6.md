# Crónicas 1.6 — Tiradas dinámicas y UI matemática

RPG web cooperativo, siempre asíncrono y persistente. Express, Socket.io,
SQLite y Google Gemini backend. No hay selector de ritmo, salto ni timeout de turno.

## Probar localmente

Requiere Node.js >=22, npm y acceso al registro npm para instalar dependencias.

```sh
npm install
# copiar .env.example a .env y configurar GEMINI_API_KEY
npm run check
npm test
npm start
```

Abrir http://localhost:3000 como host y otro navegador como jugador.
`npm install` ejecuta postinstall: compila DiceBox con esbuild y copia TODOS sus
assets distribuidos, workers, WASM y licencias a public/vendor/. Si usas
--ignore-scripts, debes ejecutar `npm run build:frontend` antes de iniciar.
No abras index.html con file://: módulos, workers y WASM necesitan HTTP(S).

No se incluyen node_modules, secretos, DB real, binarios de terceros ni lockfile
inventado. Genera y conserva package-lock.json con la instalación real.
**El entorno de entrega no tiene Node/npm ni internet: no se han instalado ni
probado DiceBox, better-sqlite3, los tests Node, navegador o proveedor real.**
Se entrega integración y build reproducible por versión, no certificación runtime.
Consulta Verification.txt. El ZIP es el proyecto fuente completo; su instalación
normal descarga y genera los recursos de terceros necesarios para funcionar.

Dependencias nuevas: @3d-dice/dice-box 1.1.4 y esbuild 0.25.5. better-sqlite3
11.10.0 es nativa: requiere binario compatible o herramientas de compilación.

## Decisiones mecánicas explícitas

1. El servidor lee traits del autor en SQLite y envía mundo, últimos 20 mensajes,
   acción, rol y rasgos ocultos a la evaluación Google Gemini.
2. Structured Outputs: response_format json_schema con strict=true y exactamente
   requiere_dado, narrativa_previa, dados_a_lanzar, cd_base, modificadores.
   GEMINI_MODEL=gemini-1.5-flash por defecto; confirmar disponibilidad del modelo.
3. Trivial: false, dados=[], cd_base=0, modificadores=[]; resolución y avance atómico.
4. Riesgo: se almacena pending_roll; no avanza. CD base 1..100. Notaciones NdS:
   N=1..12; S=4/6/8/10/12/20/100; máximo 8 grupos y 12 dados físicos.
5. Solo rasgos existentes pueden modificar; una aplicación por rasgo, valores
   +1..+5 ventaja, -1..-5 desventaja. El servidor rechaza rasgos inventados o signos
   incoherentes. La elección semántica del rasgo y CD depende de IA y no es balance formal.
6. CD final = clamp(1,100, CD base - suma(modificadores)). Todos los dados se suman.
   Éxito si total >= CD final. Igualdad es éxito. Ej.: CD15 y ventaja+3 => CD12.
   Ventaja/desventaja son ajustes, NO doble d20. No hay críticos, HP ni daño separado.
7. UI muestra preparación, notaciones, fórmula y ajustes verde/rojo con etiquetas
   neutras “Ajuste N”. Los nombres de perks/defectos continúan privados.
8. DiceBox lanza el array exacto, espera onRollComplete y envía resultados
   {caras,valor} individuales más total. El servidor valida dados y suma, fija el
   veredicto y hace la segunda llamada IA para narrar la consecuencia.
9. Resultado final público incluye resumen numérico. Mensaje final, completed/done
   y avance se confirman juntos. Una tirada nunca avanza por sí sola.

Los rasgos se envían al proveedor solo en aprobación/evaluación mecánica. La
resolución final recibe ajustes neutros y veredicto calculado, no rasgos ni tokens.
Redacción literal de nombres en narrativas más prompt evita exposición directa,
pero NO garantiza que una IA no parafrasee/infiere un secreto. Moderación/revisión
humana pendientes. No introducir datos sensibles en historias o chat.

## Persistencia y migración

`db.js` migra automáticamente user_version=1 a 2 en una transacción, manteniendo
salas, sesiones, personajes, acciones, chat y turnos de 1.4. Añade actions.stage,
pending_roll y roll_results. Una DB nueva crea esquema v1 y aplica v2. Versiones
más recientes se rechazan. Haz backup antes de actualizar; no volver a servidor 1.4
sobre una DB v2. Ningún dato perdido de versiones RAM se puede recuperar.

Estados durables:
- evaluation + pending: primera llamada IA en curso.
- awaiting_roll + pending: configuración guardada; botón disponible al autor.
- resolution + pending: números ya guardados; segunda llamada IA en curso.
- done + completed: consecuencia confirmada y turno avanzado.
- evaluation/resolution + failed: reintento explícito del autor del turno actual.

Arranque marca presencia offline. Evaluaciones de personajes interrumpidas vuelven
a draft. Trabajos evaluation/resolution de acciones pasan a failed conservando
configuración y resultados. awaiting_roll NO pasa a failed: conserva el mismo
botón y dados incluso después del reinicio. Reintentar resolution no reevalúa ni
vuelve a tirar. No hay llamadas IA/reintentos automáticos facturables.

Cliente guarda resultados en sessionStorage antes de enviarlos. ACK perdido o
recarga posterior al lanzamiento permite reenviar los mismos números. El servidor
acepta el primer resultado válido y deduplica iguales; datos diferentes fallan.
Si la pestaña se cierra DURANTE las físicas antes de obtener resultados, la DB
sigue esperando: al volver puede lanzar, porque no existe resultado recibido.
Perder sessionStorage pierde token y resultados cliente aún no guardados en DB.
Token perdido puede bloquear la cola; recuperación autenticada pendiente.

SQLite: WAL, FK ON, synchronous FULL, busy_timeout 5000; volumen durable fuera
public/. Sesiones SHA-256 de tokens 256 bits, no cuentas. Una conexión por sesión.
Solo UNA instancia por DB; no cluster, réplicas ni WAL sobre filesystem de red.
No hay TTL, autoexpulsión, salto por desconexión ni cierre al apagar. Host puede
borrar sala completa; jugador solo puede eliminar plaza en lobby. Backups online
requieren SQLite backup API; no copiar únicamente .sqlite si WAL está activo.

## Contrato Socket.io

ACK {ok:true,data} / {ok:false,error}; eventos room:state, room:closed, session:replaced.

- room:create {playerName,world}: storyName, premise, redLines, magicLevel,
  adventureTone, mortality; claves exactas, sin ritmo configurable.
- room:join {playerName,code}: solo lobby, código A-Z seis letras, 8 jugadores+host.
- session:resume {token}: sesión y personaje propio sin traits; reemplaza conexión.
- character:submit {name,history}: aprobación IA en lobby; estados persistidos.
- adventure:start {}: solo host, al menos un jugador y todos conectados/aprobados.
- action:submit {id,turnVersion,text}: UUID; texto 1..2000; idempotente por ID/datos.
- action:retry {id}: solo autor actual, failed; respeta la etapa y tirada anterior.
- roll:submit {id,turnVersion,resultados:[{caras,valor}],total}: claves exactas,
  solo autor, configuración DB; ACK confirma guardado, no resolución completada.
- chat:history {before}: páginas de 100 mensajes; historial durable.
- room:leave {}: host borra todos, jugador elimina su plaza solo en lobby.

turn.action añade stage, pendingRoll y rollResults. pendingRoll es proyección
pública de configuración: cd_final calculada, nombres de ajustes neutros.
No contiene rasgos privados, historias, aprobación privada, token/hash ni socket_id.
Host primero, luego jugadores por unión, avance circular solo tras commit final.

## Dados 3D, workers, CSP y GitHub Pages

public/main.js importa dice-ui.mjs relativo a su propio script. El módulo importa
vendor/dice-box.js y calcula origen + pathname de vendor/dice-assets relativo a
import.meta.url: admite https://usuario.github.io/repositorio/ sin rutas absolutas
que borren /repositorio/. El build conserva árboles auxiliares de dist y assets.
Workers y WASM son locales de mismo origen; no se descargan desde CDN en runtime.
DiceBox usa tema default, WebGL y físicas de su librería; no hay fallback 2D que
invente resultados. Si falla init/roll, se informa y la DB mantiene la espera.

Helmet autoriza worker-src self blob:, script-src self wasm-unsafe-eval y CDN
Socket.io; mantiene restricciones restantes. offscreen=false evita depender de
transferencia OffscreenCanvas; comprobar soporte real de navegadores.
Hosting debe servir .js/.mjs con MIME JavaScript y .wasm application/wasm y no
reescribir 404 de workers/assets a index.html. No habilitar COEP/COOP globales sin
validar Socket.io/CDN y comportamiento real. Assets WASM y worker usan rutas
locales; revisar consola y Network en aceptación para confirmar versión integrada.

Workflow Pages instala Node22/dependencias y build ANTES de publicar public/.
Usa npm ci cuando exista lockfile real; npm install en primera entrega.
El backend va aparte: HTTPS, volumen persistente, FRONTEND_ORIGINS con origen
exacto de Pages (sin /repositorio). Configurar URL backend en Opciones.
No se han probado Pages, CSP ni workers reales desde este entorno.

## Seguridad y límites

La tirada física se genera en navegador, como pide este parche. Validar cantidades,
caras y suma NO prueba azar honesto: cliente modificado puede elegir valores
válidos. La configuración/veredicto/avance sí los controla el servidor. Antes de
servicio competitivo, implementar azar servidor con animación vinculada o protocolo
verificable; firmas sin origen confiable no resuelven este problema.
No prometer “tirada autorizada/antitrampas” a partir de estos números cliente.

API timeout45s, sin auto retries; 4 trabajos IA, 3 llamadas/min miembro y 10/min sala,
cuotas persistentes compartidas entre aprobación, evaluación y resolución. Turnos
arriesgados usan dos llamadas y reintentos pueden alcanzar cuota: esperar un minuto
sin cambiar resultados. 40 eventos/min conexión, 32KiB socket, 180 HTTP/min,
120 handshakes/min/IP, 1000 salas. No hay exactly-once de facturación del proveedor.
CORS, Origin WebSocket, Helmet, validación servidor y render textContent conservados.

## Aceptación pendiente

1. npm install/build, check y test; comprobar manifest local con workers y WASM.
2. Host + jugador aprobado: trivial avanza una vez, riesgosa espera sin avanzar.
3. Revisar CD/colores, secretos en red, dados 1d20+2d6 y resultados individuales.
4. Recargar/reiniciar ANTES de tirar: mismo botón/configuración/turno.
5. ACK perdido tras tirar: reenvío igual, datos distintos rechazados.
6. Cortar segunda IA: retry conserva números, un solo mensaje final/avance.
7. Probar JSON inválido, rasgo falso, intruso, caras/suma incorrectas y cuota agotada.
8. Migrar copia de DB1.4, verificar FK/cascadas y backup/restore.
9. Navegador real WebGL/worker/WASM, móvil/teclado, CSP, HTTPS y Pages /repositorio/.

Entregables: ZIP completo fuente, Codigo_completo_v1.6.txt con TODOS los archivos
textuales del proyecto (código, pruebas, config y docs históricos), Patch_Notes_v1.6.txt.
El TXT no se incluye a sí mismo recursivamente; incluye manifiesto SHA-256 por archivo.


## Parche 1.6: Gemini y despliegue Render

SDK backend solicitado: @google/generative-ai 0.24.1. Los tres contratos
(aprobación, evaluación mecánica, resolución) usan responseMimeType application/json
y responseSchema. additionalProperties no se envía: no pertenece al subconjunto
OpenAPI del SDK. Los validadores locales siguen exigiendo claves exactas,
rasgos autorizados y reglas de negocio. Prompts originales conservados íntegros.
Presupuestos de salida conservados: 1800, 2600 y 2200 tokens respectivamente;
la tokenización y el coste efectivo no son equivalentes entre proveedores.

IMPORTANTE: gemini-1.5-flash y el SDK solicitado pertenecen a una generación
legacy. Su disponibilidad no se ha confirmado aquí. Si Google devuelve modelo
no encontrado/retirado, el despliegue del servidor no hace disponible ese modelo:
configura GEMINI_MODEL con un modelo habilitado que admita systemInstruction,
responseSchema y application/json. No existe sustitución silenciosa ni promesa de
ahorro medido. La API fallida mantiene el estado recuperable y no avanza turnos.

Render (backend): Node >=22, build `npm install`, start `npm start`.
Configurar GEMINI_API_KEY como secreto, GEMINI_MODEL, NODE_ENV=production,
FRONTEND_ORIGINS=https://tu-frontend y TRUST_PROXY_HOPS según proxy real.
Configurar SQLITE_PATH en disco persistente, por ejemplo /var/data/cronicas.sqlite.
Una instancia por DB; no desplegar réplicas ni guardar SQLite en filesystem efímero.
Health check /health informa versión 1.6.0. No usar --ignore-scripts sin ejecutar
npm run build:frontend explícitamente. esbuild es dependencia de producción.
Tras primera instalación real generar y versionar package-lock.json para npm ci.
No se incluye un lockfile inventado ni binarios descargados de terceros.

El build localiza la raíz real del paquete a partir de require.resolve y comprueba
name/version. Copia dist/assets completo a public/vendor/dice-assets; conserva
dist completo en dice-box-dist y sus auxiliares de raíz en dice-assets. No exige
un fichero cuyo nombre incluya worker dentro de assets: acepta código Worker
embebido en JS de dist o auxiliares externos. Valida WASM no vacío y genera
manifest.json con evidencias. Es una detección estática, no certificación del
contenido npm 1.1.4 ni de WebGL. Los fixtures de test/build-dice.test.js son
sintéticos; la estructura exacta del paquete publicado debe verificarse al instalar.

Antes de abrir a usuarios ejecutar npm run check y npm test; revisar en navegador
Network sin 404 para JS, tema, modelos y WASM, tanto Render como Pages con subruta.
Hacer una aprobación real y una acción trivial/arriesgada con Gemini; confirmar
recuperación tras error, rechazo JSON incorrecto y conservación de rasgos SQLite.
Cancelar un trabajo descarta su resultado; no garantiza cancelar la facturación.


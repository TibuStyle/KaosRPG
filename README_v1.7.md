# Crónicas 1.7 — La Taberna

Proyecto fuente completo para Node >=22 y una única instancia con SQLite durable.
El Director de Proyecto informa de despliegue funcional de 1.6 en Render; esta entrega no verifica ese despliegue ni certifica 1.7 en producción.

## Instalación y despliegue

1. Detener la instancia y hacer backup consistente de SQLite (DB y WAL, o backup SQLite). Ensayar restore antes de actualizar.
2. Instalar Node >=22 y ejecutar `npm install` en la raíz. El postinstall construye DiceBox local.
3. Copiar `.env.example` a `.env` en local, o configurar secretos en Render.
4. Configurar `GEMINI_API_KEY`, un `GEMINI_MODEL` disponible compatible con salida estructurada, `FRONTEND_ORIGINS` explícito y `SQLITE_PATH` en disco persistente, fuera de `public/`.
5. Ejecutar `npm run check`, `npm test`, `npm start`. Generar y versionar un package-lock.json REAL; no se entrega un lockfile inventado.
6. Render: Build Command `npm install`; Start Command `npm start`; Node 22 o superior; `NODE_ENV=production`. PORT lo proporciona Render. No usar varias instancias con una misma DB.
7. `/health` debe responder version 1.7.0. Revisar manifiesto DiceBox, MIME WASM, CSP, workers/assets sin 404 y subruta Pages si se usa frontend separado.

La migración automática `user_version 2 -> 3` agrega columnas de fichas, mochila, avatar y tablas de estados/chat social en transacción. Conserva personajes, acciones, tiradas y turnos. DB nueva recorre 0 ->1 ->2 ->3. No volver al servidor 1.6/1.5 después de migrar; restaurar backup compatible para rollback.

## Interfaz y funcionamiento

- CSS nuevo: madera/pergamino de gradientes locales (sin imágenes o fuentes externas), serifas, botones tallados/metalizados, narrativa clara de alto contraste, adaptación móvil y movimiento reducido.
- Apariencia Estética (máx. 1000 caracteres), puramente visual. Confirmaciones explícitas de publicación de historia y envío visual externo.
- Al aprobar, Gemini traduce la apariencia al inglés y deriva SOLO equipo declarado en la historia; el backend solicita el retrato a `https://image.pollinations.ai/prompt/{prompt_codificado}`.
- Estructura fija: `detailed pixel art character portrait, 2d game art, no weapons, [tono/reglas generales del mundo], [apariencia en inglés]`. No se envían premisa, líneas rojas, mochila o rasgos al endpoint de imagen deliberadamente. La traducción/depuración semántica depende de Gemini: revisar que no filtre historia/rasgos antes de aceptar.
- Timeout de retrato 12s, máximo 8MiB y MIME PNG/JPEG/WebP, redirects rechazados. Éxito guarda URL en `characters.avatar_url`. Fallo deja avatar nulo/estado unavailable SIN cancelar la aprobación. `POLLINATIONS_ENABLED=false` desactiva el fetch.
- El endpoint pedido se integra sin credenciales. Su acceso público/gratuidad actual NO se ha comprobado. Podría requerir autenticación, cambiar condiciones o redirigir; este parche no promete disponibilidad, coste cero ni migración silenciosa a otro endpoint. Si falla, no habrá retrato.
- URL remota, no copia local de imagen: cargar miniatura/ficha vuelve a contactar Pollinations; no hay persistencia binaria, consistencia visual ni garantía de imagen sin armas. No reintentos automáticos. Personajes heredados no regeneran retrato: una nueva aprobación con consentimiento en lobby sí lo solicita.
- Lista de jugadores con miniaturas; clic abre ficha modal: avatar, nombre, historia pública, equipo narrativo y estados.
- Equipo público tipo ataque/defensa/otro, sin estadísticas ni sistema de combate nuevo. Máximo 12 objetos, nombres 80 caracteres. Personajes heredados conservan equipo vacío hasta nueva evaluación.
- Historia aprobada nueva se publica. Historias heredadas se mantienen ocultas hasta pulsar `Publicar mi historia existente` con confirmación o reenviar personaje antes de jugar. El botón publica TODO el texto: no usar si contiene secretos.
- Estados narrativos públicos (máximo 16 por personaje): Gemini puede poner/retirar hasta 12 etiquetas al resolver una tirada; validación de personajes de la sala y límites, commit junto con narrativa y avance. Un fallo no aplica cambios; retry conserva los resultados. Triviales mantienen su contrato y no modifican estados. Etiquetas no alteran CD ni conceden ventajas automáticas.
- `Mochila (Privado)` aparece solo al abrir la ficha propia: registro editable, 30 objetos de 120 caracteres, sin duplicados. Servidor deriva dueño de sesión, nunca de un ID solicitado. No recibe objetos de Gemini ni se comunica a IA; no es economía autoritativa/antitrampas.
- La Taberna: chat social global y susurros independiente; lateral en pantallas amplias, debajo en móvil. Funciona en lobby y partida. Clic en nombre de mensaje selecciona susurro; selector permite iniciar conversación con cualquier otro miembro, incluido Director.
- Historial SQLite paginado (100), recepción selectiva de susurros, límite 20 mensajes/minuto/miembro y límite de transporte existente 40 solicitudes/minuto. Persistencia e idempotencia por client UUID. Destinatario desconectado recibe historial al reconectar.

## Privacidad y límites

Gemini usa SOLO historial narrativo en `messages`, no `social_messages`, ni `inventory`. Mochila no está en snapshot ni ficha pública. Susurros se entregan al remitente/destinatario autenticados, no al host por privilegio. Excepción obvia: lo que una persona copie manualmente a su acción ya forma parte de narrativa/IA. Chat no avanza turno ni llama a IA.

Privacidad respecto al grupo, no cifrado de extremo a extremo: operador del servidor tiene acceso a SQLite. No poner secretos personales. El prompt visual queda en URL y puede ser registrado por proveedor. Historias públicas, etiquetas y equipo pueden filtrar secretos si el usuario o Gemini los escribe; no se certifica privacidad semántica. Rasgos siguen ocultos; etiquetas con nombres literales de rasgos se rechazan.

Se mantienen cola fija Director primero, turno no saltable por desconexión, SQLite durable, resultados de dados CLIENTE manipulables y reglas matemáticas 1.5. Nada de autenticación de cuentas, azar servidor, HP, combate formal, mapas, memoria extensa, moderación garantizada o multiinstancia en este parche.

## Contratos y eventos nuevos

- Aprobación: claves anteriores + `descripcion_visual_ingles`, `equipo_publico`, `inventario_privado` (obligatoriamente vacío; administración privada manual).
- Resolución de tirada: `{narrativa, estados:[{member_id,operacion:'poner'|'retirar',etiqueta}]}`.
- `character:public {memberId}` => ficha aprobada de la misma sala (o null).
- `character:publish-history {}` => publica historia propia aprobada.
- `inventory:get {}` / `inventory:save {items}` => solo dueño de sesión.
- `social:history {before?}` / `social:send {id,kind:'global'|'whisper',recipientId:null|id,text}`.
- Recepción `social:message`; no se reutiliza `chat:history` (reservado a narrativa histórica).

## Pruebas / aceptación obligatoria

Ver `Verification_v1.7.txt`. Aquí se ejecutaron comprobaciones Python SQLite y referencias estáticas; NO Node/npm, build, Socket runtime, navegador ni servicios reales. Tests de Node nuevos/adaptados están entregados, NO aprobados.

En entorno con Node:
- `npm run check` y `npm test`; revisar pruebas de contratos, privacidad SQL, Socket real con Gemini mock, idempotencia, reinicio, retratos con fetch simulado y estados tras retry.
- Gemini real: aprobación/rechazo, traducción estética, equipo explícito, tirada/resolución con poner y retirar etiquetas; cancelar/reiniciar sin commit parcial.
- Pollinations real: MIME, timeout, endpoint vigente, imagen disponible/no disponible, URL codificada, ausencia de armas/datos sensibles, políticas y términos. CSP deja únicamente origen de imagen solicitado; redirects no están permitidos deliberadamente.
- Dos jugadores + host + otra sala: susurros invisibles a terceros en eventos, historial, snapshot y reconexión. Mochila distinta en cada dueño y ausente en contexto IA.
- Tab/Shift-Tab/Escape y lectores de pantalla en modales, cierre y limpieza privada; móvil, contraste, navegador/WebGL; Render HTTPS; subruta Pages.
- Backup/restore, disco lleno, carga y límites antes de producción.

ZIP sin .env real, DB, node_modules o binarios de terceros. TXT consolidado contiene todos los archivos textuales del ZIP salvo él mismo, con separadores y SHA-256.


# Crónicas · v1.2

Node.js 22+, Express, Socket.io. Frontend estático en `public/`.

## Local

```sh
npm install
cp .env.example .env
npm run check
npm start
```

Abre http://localhost:3000 en dos navegadores o en una ventana privada: crea
una sala como host y únete como jugador. Dos pestañas nuevas también sirven;
si una pestaña duplica la sesión, usa ventana privada para una identidad distinta.
No abras el HTML mediante file://.

`npm install` genera package-lock.json: añadirlo al repositorio tras instalar y
revisar dependencias. Después, usar `npm ci` para despliegues reproducibles.
No se incluye un lock inventado sin resolución real de dependencias.

## Despliegue separado

1. Desplegar raíz en un servicio con Node.js 22+, WebSockets y HTTPS.
   Instalación: npm install (npm ci tras incorporar el lock). Inicio: npm start.
2. Variables: NODE_ENV=production, PORT según proveedor y
   FRONTEND_ORIGINS=https://TU_USUARIO.github.io,https://TU_BACKEND.example.com
   Orígenes exactos: sin ruta, sin barra final, sin comodín. Para Pages con
   dominio propio, añadir su origen real. Nunca poner /nombre-repositorio.
3. Configurar TRUST_PROXY_HOPS solo según la cadena real de proxies.
   El límite de handshakes usa IP de conexión directa: tras un proxy es
   compartido. Afinar ese límite en infraestructura antes de tráfico público.
4. GitHub Pages no ejecuta server.js ni permite seleccionar cualquier subcarpeta
   como fuente de rama. El workflow incluido publica public/ como artefacto.
   En Settings > Pages > Source seleccionar GitHub Actions; rama main.
5. Abrir Pages > Opciones / Servidor y guardar URL HTTPS del backend.
   Se conserva en sessionStorage por pestaña. Para fijar URL para todo el
   despliegue, sustituir fallback en public/main.js por el origen del backend.

No hay secretos en el frontend. No incluir .env en Git. El script cliente de
Socket.io usa CDN oficial fijado en 4.8.1: se necesita acceso a ese CDN. Para
alojamiento sin CDN, copiar el cliente distribuido por la dependencia a public/
y cambiar la referencia script; no inventar hashes SRI.

## Contrato Socket.io

Todas las peticiones incluyen payload y callback de confirmación:
`{ ok: true, data: ... }` o `{ ok: false, error: ... }`.

- room:create: { playerName, world: { storyName, premise, redLines,
  magicLevel, adventureTone, turnPace, mortality } }.
- room:join: { playerName, code }.
- session:resume: { token }.
- character:submit: { name, history }.
- room:leave: {}. Host cierra para todos; jugador elimina su personaje.
- room:state (servidor): mundo y lista de miembros sin tokens ni historias.
- room:closed (servidor): { reason }.
- session:replaced (servidor): otra conexión recuperó el mismo token.

Crear/unirse/recuperar devuelve token secreto, memberId, isHost y room.
Recuperar devuelve también el personaje propio, si existe. Token aleatorio de
256 bits: tratarlo como credencial de portador, no compartirlo ni registrarlo.
El código es invitación, no autenticación. CORS no sustituye autenticación.

## Límites explícitos

- Una instancia/proceso. No usar cluster, múltiples réplicas o balanceo entre
  procesos sin almacenamiento compartido y adaptador Socket.io.
- Estado solo en RAM: reinicios eliminan salas, sesiones y personajes.
- Sala: 24 horas; desconexión: reserva 15 minutos, limpieza cada 30 segundos.
- Hasta 1000 salas; ocho jugadores más host por sala.
- Host desconectado: reserva temporal; si expira, se cierra toda la sala.
- Reglas y líneas rojas se validan por tipo/longitud/enumeración, NO por sentido.
  Seleccionar Asíncrono no implementa todavía un foro persistente.
- IA, Perks/Defectos, aprobación, inicio de aventura, tiradas y mapas pendientes.
- Personajes modificables por propietario; no se comparte su historia.
- No hay cuentas, contraseñas ni autorización externa. Recomendado como MVP
  privado de evaluación; antes de público, añadir autenticación, base de datos,
  moderación, monitorización, copias y protección antiabuso perimetral.
- Helmet, allowlist de Origin (también WebSocket), tamaño máximo de mensajes,
  límites de eventos/HTTP y validación de servidor son una base, no garantía.
- Un timeout no prueba que la operación falló: si crear/unirse perdió su ACK,
  recarga para liberar esa conexión o espera su reserva antes de reintentar.

## Pruebas manuales antes de desplegar

1. Crear con todos los campos; comprobar transición y código A-Z de seis letras.
2. Unirse desde otra identidad; ver lista del host sin recargar.
3. Enviar/editar personaje y comprobar nombre/estado en ambas ventanas.
4. Código inexistente, sala llena, campos espacios y payloads malformados.
5. Cortar red/reconectar y recargar; verificar recuperación con token propio.
6. Cerrar sala y salir como jugador; comprobar expulsión/limpieza de lista.
7. Reiniciar backend: confirmar pérdida de estado y manejo de sesión caducada.
8. Pages HTTPS + backend HTTPS: probar CORS, WebSocket y fallback polling.
9. Teclado, Escape, foco, móvil y movimiento reducido.

# Lista de regalos

Web para organizar listas de regalos (bebé, boda, deseos…): los organizadores añaden artículos pegando
un enlace y los invitados marcan lo que van a regalar, para que nadie lo repita.

Sin dependencias: Node 22 (`node:http` + `node:sqlite`) y un frontend en HTML + Bootstrap con un tema propio.

## Qué hace

- **Invitados**: entran con su móvil y su correo (verificado con un PIN de 6 cifras). Ven las listas,
  marcan «Lo regalo yo» indicando de parte de quién, y pueden deshacerlo durante 10 minutos.
- **Organizadores (admins)**: entran con móvil + PIN enviado a su correo. Crean listas, añaden artículos
  por URL (se rellenan título, descripción, precio y foto cuando la tienda lo permite), los ordenan,
  los ocultan o los vuelven a habilitar, y reciben un correo cada vez que alguien marca un regalo.
- **Tipos de artículo**: normal (una persona), varias unidades («quedan 3 de 5») o regalo entre varios
  (cada uno apunta cuánto pone hasta reunir el importe).
- **Registro**: tabla con quién regala qué (teléfono, correo, de parte de quién), exportable a CSV.
- **Control de acceso**: enlace secreto por lista (quien entra con él solo ve esa lista), listas fuera
  de portada, whitelist de móviles por lista y bloqueo de números.
- **Tarjeta de vista previa** (Open Graph) al compartir el enlace por WhatsApp y similares.
- Modo claro y oscuro con tema «cristal»; pensado para móvil.

## Puesta en marcha

Requisitos: Docker, un proxy inverso con HTTPS delante y un relay SMTP accesible desde el contenedor.

```bash
cp .env.example .env      # y rellénalo (admins, dominio, correo)
docker compose up -d
```

El `docker-compose.yml` espera dos redes externas: `reverse_proxy` (la del proxy que publica el sitio,
apuntando a `listas-web:3000`) y `mail_net` (la del relay SMTP). Ajústalas a tu entorno.

Para desarrollo sin Docker:

```bash
cd app
PORT=3000 COOKIE_SECURE=0 DATA_DIR=../data ADMINS=600000001:admin@example.com \
  SMTP_HOST=127.0.0.1 SMTP_PORT=25 node --disable-warning=ExperimentalWarning server.js
```

## Datos y copias

Todo vive en `data/` (no se versiona): `regalos.db` (SQLite), `img/` (fotos de los artículos) y
`secret.key`. La aplicación guarda cada día una copia consistente de la base de datos en
`data/backups/` (se conservan 14). Incluye `data/` en las copias de seguridad de tu servidor.

## Seguridad

- Nada se ve sin sesión. PIN por correo (10 minutos, 5 intentos) para invitados y admins.
- Anti-bots: prueba de trabajo en el acceso, campo trampa, filtro de user-agents, límites por IP,
  `noindex` y `robots.txt`. Los previsualizadores de enlaces solo pueden pedir la portada sin datos.
- Cookies `__Host-`, HttpOnly, Secure, SameSite=Strict; anti-CSRF por cabecera y origen; CSP estricta
  (solo recursos propios). El contenido se pinta siempre como texto.
- Lectura de fichas con protección SSRF (solo IPs públicas y puertos 80/443); las fotos se guardan en local.
- Contenedor de solo lectura, sin capabilities y con usuario sin privilegios.
- Límite de regalos por móvil y día, y registro de accesos que se borra a los 90 días.

## Estructura

```
app/server.js        servidor HTTP, API y base de datos
app/scrape.js        lectura segura de fichas de producto
app/mail.js          cliente SMTP mínimo
app/public/          web (index.html, app.js, theme.css, theme.js, Bootstrap)
docker-compose.yml   despliegue
.env.example         configuración de ejemplo
```

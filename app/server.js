'use strict';
// Lista de regalos — servidor HTTP sin dependencias externas (Node 22 + node:sqlite).
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { scrape, downloadImage, checkUrl } = require('./scrape');
const { sendMail } = require('./mail');

// ---------- Configuración ----------
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const IMG_DIR = path.join(DATA_DIR, 'img');
const COOKIE_SECURE = process.env.COOKIE_SECURE !== '0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const POW_BITS = Number(process.env.POW_BITS || 15);
const PUBLIC_ORIGIN = String(process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
const SID = COOKIE_SECURE ? '__Host-sid' : 'sid';
const PID = COOKIE_SECURE ? '__Host-pin' : 'pin';
// Sesión deslizante: caduca a los 7 días SIN entrar; cada visita la renueva otros 7.
const SESSION_TTL = 7 * 24 * 3600e3;
const SESSION_RENEW_EVERY = 3600e3; // como mucho una renovación por hora
const PIN_TTL = 10 * 60e3;
const MAX_GIFTS_PER_DAY = 5;          // regalos que un mismo móvil puede marcar en 24 h
const UNDO_WINDOW = 10 * 60e3;        // minutos que tiene un invitado para deshacer
const LOGIN_LOG_DAYS = 90;            // el registro de accesos se borra pasado este plazo
const CONSENT_VERSION = '2026-11-20'; // versión de la política de privacidad aceptada
const PRIVACY_CONTACT = String(process.env.PRIVACY_CONTACT || '').trim();

// ADMINS="600000001:correo@example.com,600000002:otro@example.com"
const ADMINS = new Map();
for (const pair of String(process.env.ADMINS || '').split(',')) {
  const [phone, email] = pair.split(':').map((s) => (s || '').trim());
  if (/^[67]\d{8}$/.test(phone) && email) ADMINS.set(phone, email.toLowerCase());
}
if (!ADMINS.size) console.warn('AVISO: no hay administradores configurados (variable ADMINS)');

fs.mkdirSync(IMG_DIR, { recursive: true, mode: 0o700 });
const secretFile = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile);

// ---------- Base de datos ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'regalos.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  whitelist_enabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS list_whitelist (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE, phone TEXT NOT NULL,
  PRIMARY KEY (list_id, phone));
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  price TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','disabled','purchased')),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  phone TEXT NOT NULL, from_name TEXT NOT NULL, at INTEGER NOT NULL,
  cancelled_at INTEGER, cancelled_by TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, phone TEXT NOT NULL, is_admin INTEGER NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pins (
  pending_hash TEXT PRIMARY KEY, phone TEXT NOT NULL, pin_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS logins (
  id INTEGER PRIMARY KEY, phone TEXT NOT NULL, is_admin INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id);
CREATE INDEX IF NOT EXISTS idx_purchases_item ON purchases(item_id);
`);
// Migraciones: enlace propio por lista, visibilidad en portada y sesiones limitadas a listas.
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('lists').includes('share_token')) db.exec('ALTER TABLE lists ADD COLUMN share_token TEXT');
if (!cols('lists').includes('listed')) db.exec('ALTER TABLE lists ADD COLUMN listed INTEGER NOT NULL DEFAULT 1');
if (!cols('sessions').includes('scoped')) db.exec('ALTER TABLE sessions ADD COLUMN scoped INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS session_lists (
  token_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  PRIMARY KEY (token_hash, list_id));
CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_share ON lists(share_token);
`);
const addCol = (t, c, def) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('items', 'quantity', 'INTEGER NOT NULL DEFAULT 1');   // cuántas personas pueden regalarlo
addCol('items', 'group_target', 'REAL');                     // regalo entre varios: importe objetivo
addCol('items', 'favorite', 'INTEGER NOT NULL DEFAULT 0');
if (!cols('items').includes('position')) { db.exec('ALTER TABLE items ADD COLUMN position INTEGER NOT NULL DEFAULT 0'); db.exec('UPDATE items SET position = id'); }
addCol('purchases', 'amount', 'REAL');
addCol('purchases', 'email', "TEXT NOT NULL DEFAULT ''");
addCol('sessions', 'email', "TEXT NOT NULL DEFAULT ''");
addCol('logins', 'email', "TEXT NOT NULL DEFAULT ''");
addCol('pins', 'email', "TEXT NOT NULL DEFAULT ''");
addCol('pins', 'kind', "TEXT NOT NULL DEFAULT 'admin'");
addCol('pins', 'share', "TEXT NOT NULL DEFAULT ''");
db.exec(`
CREATE TABLE IF NOT EXISTS blocked (phone TEXT PRIMARY KEY, at INTEGER NOT NULL, by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY, phone TEXT NOT NULL, email TEXT NOT NULL, version TEXT NOT NULL, at INTEGER NOT NULL);
`);
const newShareToken = () => crypto.randomBytes(16).toString('base64url'); // 128 bits, imposible de adivinar
const SHARE_RE = /^[A-Za-z0-9_-]{22}$/;

if (!db.prepare('SELECT COUNT(*) AS n FROM lists').get().n) {
  const ins = db.prepare('INSERT INTO lists (name, description, created_at) VALUES (?,?,?)');
  ins.run('Lista bebé', 'Cositas para la llegada del bebé', Date.now());
  ins.run('Lista boda', '', Date.now());
  ins.run('Lista de deseos', '', Date.now());
}
for (const l of db.prepare('SELECT id FROM lists WHERE share_token IS NULL').all()) {
  db.prepare('UPDATE lists SET share_token = ? WHERE id = ?').run(newShareToken(), l.id);
}
const listByShare = (tok) => (typeof tok === 'string' && SHARE_RE.test(tok) ? db.prepare('SELECT * FROM lists WHERE share_token = ?').get(tok) || null : null);

// ---------- Utilidades ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮]/g, '').trim().slice(0, max) : '');

function normPhone(v) {
  if (typeof v !== 'string' || v.length > 30) return null;
  let p = v.replace(/[\s.\-()]/g, '');
  if (p.startsWith('0034')) p = p.slice(4);
  else if (p.startsWith('+34')) p = p.slice(3);
  if (/^[67]\d{8}$/.test(p)) return p;
  if (/^\+[1-9]\d{7,14}$/.test(p)) return p; // móviles extranjeros, con prefijo
  return null;
}

function normEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 120 && /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e) ? e : null;
}
const isBlocked = (phone) => !!db.prepare('SELECT 1 AS x FROM blocked WHERE phone = ?').get(phone);
const euros = (n) => `${(Math.round(n * 100) / 100).toLocaleString('es-ES', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })} €`;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (status, msg) => { throw new HttpError(status, msg); };

// Limitador en memoria (ventana fija)
const buckets = new Map();
function hit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  return ++b.n <= max;
}
const limit = (key, max, windowMs, msg) => { if (!hit(key, max, windowMs)) bad(429, msg || 'Demasiadas peticiones. Espera unos minutos.'); };

// Prueba de trabajo anti-bots
const usedChallenges = new Map();
function newChallenge() {
  const base = `${Date.now() + 5 * 60e3}.${crypto.randomBytes(12).toString('hex')}`;
  return `${base}.${hmac('pow:' + base)}`;
}
function verifyPow(c, n) {
  if (typeof c !== 'string' || c.length > 200 || !/^\d{1,12}$/.test(String(n))) return false;
  const [exp, rnd, mac] = c.split('.');
  if (!exp || !rnd || !mac || !safeEq(mac, hmac(`pow:${exp}.${rnd}`))) return false;
  if (Number(exp) < Date.now() || usedChallenges.has(c)) return false;
  const h = crypto.createHash('sha256').update(`${c}:${n}`).digest();
  let zeros = 0;
  for (const byte of h) {
    if (byte === 0) { zeros += 8; continue; }
    zeros += Math.clz32(byte) - 24;
    break;
  }
  if (zeros < POW_BITS) return false;
  usedChallenges.set(c, Number(exp));
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
  for (const [k, exp] of usedChallenges) if (exp < now) usedChallenges.delete(k);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM pins WHERE expires_at < ?').run(now);
}, 60e3).unref();

// Copia diaria y consistente de la base de datos (VACUUM INTO) en data/backups; se guardan 14.
// Están dentro de data/, así que la copia de seguridad del servidor también se las lleva.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
function dailyMaintenance() {
  try {
    db.prepare('DELETE FROM logins WHERE at < ?').run(Date.now() - LOGIN_LOG_DAYS * 86400e3);
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(BACKUP_DIR, `regalos-${day}.db`);
    if (!fs.existsSync(file)) {
      const tmp = `${file}.tmp`;
      fs.rmSync(tmp, { force: true });
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const check = new DatabaseSync(tmp, { readOnly: true });
      const ok = check.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
      check.close();
      if (!ok) throw new Error('la copia no pasa la comprobación de integridad');
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
      console.log(`Copia diaria creada: ${path.basename(file)}`);
    }
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^regalos-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -14);
    for (const f of old) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  } catch (e) { console.error('Fallo en la copia diaria:', e.message); }
}
dailyMaintenance();
setInterval(dailyMaintenance, 3600e3).unref();

// ---------- HTTP ----------
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
};

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const buf = isObj ? Buffer.from(JSON.stringify(body)) : Buffer.from(body ?? '');
  res.writeHead(status, {
    ...SEC_HEADERS,
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
    'Content-Length': buf.length,
  });
  res.end(buf);
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function setCookie(res, name, value, maxAgeMs) {
  const prev = res.getHeader('Set-Cookie') || [];
  const c = `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${COOKIE_SECURE ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', [...prev, c]);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Petición no válida'));
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > 65536) { reject(new HttpError(413, 'Petición demasiado grande')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(o && typeof o === 'object' && !Array.isArray(o) ? o : {});
      } catch { reject(new HttpError(400, 'Petición no válida')); }
    });
    req.on('error', reject);
  });
}

function getSession(req) {
  const tok = cookies(req)[SID];
  if (!tok || !/^[a-f0-9]{64}$/.test(tok)) return null;
  const s = db.prepare('SELECT phone, is_admin, expires_at, scoped, email FROM sessions WHERE token_hash = ?').get(sha(tok));
  if (!s || s.expires_at < Date.now()) return null;
  // Si deja de ser admin en la configuración, la sesión de admin deja de valer.
  if (s.is_admin && !ADMINS.has(s.phone)) return null;
  // Invitados: hace falta correo verificado, y que el número no esté bloqueado.
  if (!s.is_admin && (!s.email || isBlocked(s.phone))) return null;
  return { phone: s.phone, email: s.email, admin: !!s.is_admin, scoped: !s.is_admin && !!s.scoped, tokenHash: sha(tok), token: tok, expiresAt: s.expires_at };
}
// scope: null = sesión normal · { listId } = entró por el enlace de una lista y solo ve esa.
function createSession(res, phone, admin, scope = null, email = '') {
  const tok = crypto.randomBytes(32).toString('hex');
  const ttl = SESSION_TTL;
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, phone, is_admin, created_at, expires_at, scoped, email) VALUES (?,?,?,?,?,?,?)').run(sha(tok), phone, admin ? 1 : 0, now, now + ttl, scope && !admin ? 1 : 0, email);
  if (scope && !admin && scope.listId) db.prepare('INSERT OR IGNORE INTO session_lists (token_hash, list_id) VALUES (?,?)').run(sha(tok), scope.listId);
  db.prepare('INSERT INTO logins (phone, is_admin, at, email) VALUES (?,?,?,?)').run(phone, admin ? 1 : 0, now, email);
  setCookie(res, SID, tok, ttl);
}

const maskEmail = (e) => e.replace(/^(.).*(@.*)$/, '$1•••$2');

// ---------- Estáticos ----------
const PUB = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8', 'no-cache'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8', 'no-cache'],
  '/theme.css': ['theme.css', 'text/css; charset=utf-8', 'no-cache'],
  '/og.png': ['og.png', 'image/png', 'public, max-age=86400'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml', 'public, max-age=86400'],
  '/favicon.ico': ['favicon.png', 'image/png', 'public, max-age=86400'],
  '/favicon.png': ['favicon.png', 'image/png', 'public, max-age=86400'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png', 'public, max-age=86400'],
  '/vendor/bootstrap.min.css': ['vendor/bootstrap.min.css', 'text/css; charset=utf-8', 'public, max-age=604800'],
  '/vendor/bootstrap.bundle.min.js': ['vendor/bootstrap.bundle.min.js', 'text/javascript; charset=utf-8', 'public, max-age=604800'],
};
for (const k of Object.keys(STATIC)) STATIC[k].push(fs.readFileSync(path.join(PUB, STATIC[k][0])));

const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE_TPL = STATIC['/'][3].toString('utf8');
const OG_DESC = 'Entra con tu número de móvil, elige el regalo que quieras hacer y márcalo: desaparecerá de la lista para que nadie lo repita.';
function renderPage(req, list) {
  const origin = PUBLIC_ORIGIN || `https://${String(req.headers.host || '').replace(/[^A-Za-z0-9.:-]/g, '')}`;
  // El nombre de la lista solo sale en la tarjeta si se abre con su enlace secreto y no tiene whitelist.
  const named = list && !list.whitelist_enabled;
  const vars = {
    __OG_TITLE__: named ? `🎁 ${list.name}` : '🎁 Lista de regalos',
    __OG_DESC__: named && list.description ? `${list.description} · ${OG_DESC}` : OG_DESC,
    __OG_URL__: list ? `${origin}/l/${list.share_token}` : `${origin}/`,
    __ORIGIN__: origin,
    __PRIVACY_CONTACT__: PRIVACY_CONTACT || 'quien te envió la invitación',
  };
  return Buffer.from(PAGE_TPL.replace(/__OG_TITLE__|__OG_DESC__|__OG_URL__|__ORIGIN__|__PRIVACY_CONTACT__/g, (k) => escHtml(vars[k])));
}
const IMG_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const IMG_RE = /^[a-f0-9]{32}\.(jpg|png|webp|gif)$/;

// ---------- Lógica ----------
// Qué listas ve cada uno:
//  · admin: todas.
//  · whitelist activada: solo los móviles de la whitelist (manda sobre todo lo demás).
//  · quien entró por el enlace de una lista: solo las listas cuyos enlaces ha abierto.
//  · quien entró por la portada: las listas «en portada» + las que haya abierto por enlace.
function visibleList(id, sess) {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
  if (!list) return null;
  if (sess.admin) return list;
  if (list.whitelist_enabled && !db.prepare('SELECT 1 AS ok FROM list_whitelist WHERE list_id = ? AND phone = ?').get(id, sess.phone)) return null;
  const granted = !!db.prepare('SELECT 1 AS ok FROM session_lists WHERE token_hash = ? AND list_id = ?').get(sess.tokenHash, id);
  if (granted || (!sess.scoped && list.listed)) return list;
  return null;
}

async function resolveImage(body) {
  const imageUrl = str(body.imageUrl, 2000);
  if (imageUrl) return downloadImage(imageUrl, IMG_DIR);
  const image = str(body.image, 60);
  if (image && IMG_RE.test(image) && fs.existsSync(path.join(IMG_DIR, image))) return image;
  return '';
}
function itemFields(body) {
  const title = str(body.title, 200);
  if (!title) bad(400, 'El título es obligatorio');
  let url = str(body.url, 2000);
  if (url) { try { url = checkUrl(url).toString(); } catch (e) { bad(400, e.message); } }
  let groupTarget = body.groupTarget === '' || body.groupTarget == null ? null : Number(String(body.groupTarget).replace(',', '.'));
  if (groupTarget !== null && (!Number.isFinite(groupTarget) || groupTarget <= 0 || groupTarget > 100000)) bad(400, 'El importe del regalo entre varios no es válido');
  if (groupTarget !== null) groupTarget = Math.round(groupTarget * 100) / 100;
  let quantity = groupTarget !== null ? 1 : Math.floor(Number(body.quantity || 1));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) bad(400, 'La cantidad debe estar entre 1 y 99');
  return { title, url, description: str(body.description, 600), price: str(body.price, 40), quantity, groupTarget, favorite: body.favorite ? 1 : 0 };
}
// Compras activas de un artículo y si ya está completo (todas las unidades, o el importe reunido).
function itemProgress(item) {
  const r = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS sum FROM purchases WHERE item_id = ? AND cancelled_at IS NULL').get(item.id);
  const full = item.group_target != null ? r.sum >= item.group_target - 0.005 : r.n >= item.quantity;
  return { taken: r.n, pledged: Math.round(r.sum * 100) / 100, full };
}
// Recalcula disponible/comprado tras una compra, una anulación o un cambio de cantidad.
function refreshStatus(itemId) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item || item.status === 'disabled') return;
  const want = itemProgress(item).full ? 'purchased' : 'available';
  if (want !== item.status) db.prepare('UPDATE items SET status = ? WHERE id = ?').run(want, itemId);
}
function cancelPurchase(purchaseId, by) {
  const p = db.prepare('SELECT * FROM purchases WHERE id = ? AND cancelled_at IS NULL').get(purchaseId);
  if (!p) return null;
  db.prepare('UPDATE purchases SET cancelled_at = ?, cancelled_by = ? WHERE id = ?').run(Date.now(), by, p.id);
  refreshStatus(p.item_id);
  return p;
}
function dropImageIfUnused(image) {
  if (!image || !IMG_RE.test(image)) return;
  if (db.prepare('SELECT 1 AS x FROM items WHERE image = ? LIMIT 1').get(image)) return;
  fs.rm(path.join(IMG_DIR, image), { force: true }, () => {});
}

// Avisos por correo a todos los admins (en segundo plano: si el correo falla, lo hecho queda registrado igual).
function notifyAdmins(subject, lines) {
  const text = lines.filter((l) => l !== null).join('\n') + '\n';
  for (const to of new Set(ADMINS.values())) {
    sendMail({ to, subject: subject.slice(0, 150), text }).catch((e) => console.error(`Fallo al avisar a ${to}:`, e.message));
  }
}
function purchaseLines(item, p) {
  const list = db.prepare('SELECT name FROM lists WHERE id = ?').get(item.list_id);
  const when = new Date(p.at).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'full', timeStyle: 'short' });
  const prog = itemProgress(item);
  return [
    `Regalo:       ${item.title}`,
    `Lista:        ${list ? list.name : '—'}`,
    `Precio:       ${item.price || '—'}`,
    p.amount != null ? `Aporta:       ${euros(p.amount)} (reunido ${euros(prog.pledged)} de ${euros(item.group_target)})` : null,
    p.amount == null && item.quantity > 1 ? `Unidades:     ${prog.taken} de ${item.quantity} ya regaladas` : null,
    `De parte de:  ${p.from_name}`,
    `Teléfono:     ${p.phone}`,
    `Correo:       ${p.email || '—'}`,
    `Cuándo:       ${when}`,
    item.url ? `Enlace:       ${item.url}` : null,
  ];
}
function notifyPurchase(item, p) {
  const prog = itemProgress(item);
  notifyAdmins(`🎁 ${p.from_name} ${p.amount != null ? `aporta ${euros(p.amount)} a` : 'regala'}: ${item.title}`, [
    p.amount != null ? '¡Alguien participa en un regalo entre varios!' : '¡Alguien ha marcado un regalo!', '',
    ...purchaseLines(item, p), '',
    prog.full ? 'El artículo ya no aparece en la lista para los demás.' : 'El artículo sigue en la lista: todavía admite más.',
    PUBLIC_ORIGIN ? `Tienes todo el registro en ${PUBLIC_ORIGIN}/#/registro` : null,
  ]);
}
function notifyUndo(item, p) {
  notifyAdmins(`↩️ ${p.from_name} ha deshecho: ${item.title}`, [
    'Alguien ha deshecho un regalo que había marcado. El artículo vuelve a estar disponible en la lista.', '',
    ...purchaseLines(item, p),
  ]);
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita inyección de fórmulas en Excel
  return `"${s.replace(/"/g, '""')}"`;
};
const purchaseRows = () => db.prepare(`
  SELECT p.id, p.at, p.phone, p.email, p.amount, p.from_name AS fromName, p.cancelled_at AS cancelledAt,
         i.title, i.price, i.url, l.name AS list
  FROM purchases p JOIN items i ON i.id = p.item_id JOIN lists l ON l.id = i.list_id
  ORDER BY p.at DESC`).all();

// ---------- Rutas ----------
async function route(req, res, ip) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  let sm;
  if (m === 'GET' && (p === '/' || (sm = p.match(/^\/l\/([A-Za-z0-9_-]{22})$/)))) {
    return send(res, 200, renderPage(req, sm ? listByShare(sm[1]) : null), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  }
  if (m === 'GET' && STATIC[p]) {
    const [, type, cache, buf] = STATIC[p];
    return send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': cache });
  }
  if (m === 'GET' && p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n');

  if (m !== 'GET') {
    // Anti-CSRF: cabecera propia + origen igual al host (además de SameSite=Strict).
    if (req.headers['x-requested-with'] !== 'fetch') bad(403, 'Petición no permitida');
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* origen ilegible */ }
      if (host !== req.headers.host) bad(403, 'Petición no permitida');
    }
  }

  // --- Acceso ---
  if (m === 'GET' && p === '/api/challenge') {
    limit('ch:' + ip, 30, 10 * 60e3);
    return send(res, 200, { c: newChallenge(), bits: POW_BITS });
  }
  if (m === 'POST' && p === '/api/login') {
    limit('login:' + ip, 10, 10 * 60e3, 'Demasiados intentos. Espera unos minutos.');
    const body = await readBody(req);
    if (body.website) bad(400, 'Petición no válida'); // campo trampa: solo lo rellenan los bots
    if (!verifyPow(body.c, body.n)) bad(400, 'No se ha podido verificar tu navegador. Recarga la página e inténtalo de nuevo.');
    const phone = normPhone(body.phone);
    if (!phone) bad(400, 'Escribe un número de móvil válido (9 cifras).');
    if (isBlocked(phone)) bad(403, 'Este número no puede acceder. Si crees que es un error, habla con los organizadores.');
    const isAdmin = ADMINS.has(phone);
    let email = '';
    if (!isAdmin) {
      // Invitados: después del móvil se pide el correo y se verifica con un PIN.
      if (body.email == null || body.email === '') return send(res, 200, { needEmail: true });
      email = normEmail(body.email);
      if (!email) bad(400, 'Escribe un correo electrónico válido.');
      limit('mail:' + email, 3, 15 * 60e3, 'Ya te hemos enviado varios PIN. Espera unos minutos.');
      limit('mailip:' + ip, 6, 3600e3, 'Demasiados envíos desde tu conexión. Espera un rato.');
      limit('mailall', 300, 86400e3, 'Hoy ya no podemos enviar más correos. Inténtalo mañana.');
    }
    limit('pinsend:' + phone, 3, 15 * 60e3, 'Ya te hemos enviado varios PIN. Espera unos minutos.');
    const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const pending = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM pins WHERE phone = ?').run(phone);
    const to = isAdmin ? ADMINS.get(phone) : email;
    db.prepare('INSERT INTO pins (pending_hash, phone, pin_hash, expires_at, email, kind, share) VALUES (?,?,?,?,?,?,?)')
      .run(sha(pending), phone, hmac(`pin:${pending}:${pin}`), Date.now() + PIN_TTL, email, isAdmin ? 'admin' : 'guest', typeof body.share === 'string' ? body.share.slice(0, 40) : '');
    try {
      await sendMail({
        to,
        subject: `Tu PIN de acceso: ${pin}`,
        text: isAdmin
          ? `Hola,\n\nTu PIN para entrar como administrador en la lista de regalos es:\n\n    ${pin}\n\nCaduca en 10 minutos. Si no has sido tú, ignora este correo: sin el PIN nadie puede entrar.\n`
          : `Hola,\n\nTu PIN para entrar en la lista de regalos es:\n\n    ${pin}\n\nCaduca en 10 minutos. Al introducirlo aceptas la política de privacidad de la web${PUBLIC_ORIGIN ? ` (${PUBLIC_ORIGIN})` : ''}.\n\nSi no has sido tú, ignora este correo.\n`,
      });
    } catch (e) {
      console.error('Fallo al enviar el PIN:', e.message);
      bad(502, isAdmin ? 'No se ha podido enviar el correo con el PIN. Inténtalo en un momento.' : 'No se ha podido enviar el correo a esa dirección. Revísala o prueba con otra.');
    }
    setCookie(res, PID, pending, PIN_TTL);
    return send(res, 200, { pin: true, email: isAdmin ? maskEmail(to) : to });
  }
  if (m === 'POST' && p === '/api/pin') {
    limit('pin:' + ip, 15, 10 * 60e3, 'Demasiados intentos. Espera unos minutos.');
    const body = await readBody(req);
    const pending = cookies(req)[PID] || '';
    const row = /^[a-f0-9]{64}$/.test(pending) ? db.prepare('SELECT * FROM pins WHERE pending_hash = ?').get(sha(pending)) : null;
    const adminPin = !!row && row.kind === 'admin';
    if (!row || row.expires_at < Date.now() || (adminPin && !ADMINS.has(row.phone)) || (!adminPin && (ADMINS.has(row.phone) || isBlocked(row.phone)))) bad(400, 'El PIN ha caducado. Vuelve a empezar.');
    const pin = String(body.pin || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(pin) || !safeEq(hmac(`pin:${pending}:${pin}`), row.pin_hash)) {
      if (row.attempts + 1 >= 5) {
        db.prepare('DELETE FROM pins WHERE pending_hash = ?').run(row.pending_hash);
        bad(400, 'Demasiados intentos fallidos. Vuelve a empezar.');
      }
      db.prepare('UPDATE pins SET attempts = attempts + 1 WHERE pending_hash = ?').run(row.pending_hash);
      bad(400, 'PIN incorrecto.');
    }
    db.prepare('DELETE FROM pins WHERE pending_hash = ?').run(row.pending_hash);
    setCookie(res, PID, '', 0);
    if (adminPin) createSession(res, row.phone, true);
    else {
      // Introducir el PIN = correo verificado + aceptación de la política de privacidad.
      const shared = row.share ? listByShare(row.share) : null;
      createSession(res, row.phone, false, row.share ? { listId: shared && shared.id } : null, row.email);
      db.prepare('INSERT INTO consents (phone, email, version, at) VALUES (?,?,?,?)').run(row.phone, row.email, CONSENT_VERSION, Date.now());
    }
    return send(res, 200, { ok: true });
  }

  // --- A partir de aquí, todo requiere sesión ---
  const sess = getSession(req);
  if (m === 'POST' && p === '/api/logout') {
    if (sess) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sess.tokenHash);
    setCookie(res, SID, '', 0);
    return send(res, 200, { ok: true });
  }
  if (!sess) {
    if (p.startsWith('/api/') || p.startsWith('/img/')) bad(401, 'Sesión no iniciada');
    bad(404, 'No encontrado');
  }

  if (sess.expiresAt - Date.now() < SESSION_TTL - SESSION_RENEW_EVERY) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() + SESSION_TTL, sess.tokenHash);
    setCookie(res, SID, sess.token, SESSION_TTL);
  }

  if (m === 'GET' && p === '/api/me') return send(res, 200, { phone: sess.phone, admin: sess.admin, scoped: sess.scoped });

  // Abrir el enlace de una lista con la sesión ya iniciada: se añade esa lista a las que puede ver.
  if (m === 'POST' && p === '/api/share') {
    limit('share:' + ip, 40, 10 * 60e3);
    const body = await readBody(req);
    const list = listByShare(body.share);
    const allowed = list && (sess.admin || !list.whitelist_enabled
      || db.prepare('SELECT 1 AS ok FROM list_whitelist WHERE list_id = ? AND phone = ?').get(list.id, sess.phone));
    if (!allowed) bad(404, 'Este enlace ya no es válido o no tienes acceso a esa lista.');
    if (!sess.admin) db.prepare('INSERT OR IGNORE INTO session_lists (token_hash, list_id) VALUES (?,?)').run(sess.tokenHash, list.id);
    return send(res, 200, { id: list.id });
  }

  let mm;
  if (m === 'GET' && (mm = p.match(/^\/img\/([a-f0-9]{32}\.(jpg|png|webp|gif))$/))) {
    let buf;
    try { buf = fs.readFileSync(path.join(IMG_DIR, mm[1])); } catch { bad(404, 'No encontrado'); }
    return send(res, 200, buf, { 'Content-Type': IMG_TYPES[mm[2]], 'Cache-Control': 'private, max-age=604800, immutable' });
  }

  if (m === 'GET' && p === '/api/lists') {
    const lists = db.prepare('SELECT * FROM lists ORDER BY id').all().filter((l) => visibleList(l.id, sess));
    return send(res, 200, {
      lists: lists.map((l) => {
        const c = db.prepare("SELECT COUNT(*) AS total, SUM(status = 'available') AS available FROM items WHERE list_id = ?").get(l.id);
        const out = { id: l.id, name: l.name, description: l.description, available: c.available || 0 };
        if (sess.admin) {
          out.total = c.total;
          out.whitelistEnabled = !!l.whitelist_enabled;
          out.listed = !!l.listed;
          out.shareToken = l.share_token;
          out.whitelist = db.prepare('SELECT phone FROM list_whitelist WHERE list_id = ? ORDER BY phone').all(l.id).map((r) => r.phone);
        }
        return out;
      }),
    });
  }
  if (m === 'GET' && (mm = p.match(/^\/api\/lists\/(\d+)$/))) {
    const list = visibleList(Number(mm[1]), sess);
    if (!list) bad(404, 'Esa lista no existe');
    const head = { id: list.id, name: list.name, description: list.description };
    if (sess.admin) head.shareToken = list.share_token;
    const all = db.prepare('SELECT * FROM items WHERE list_id = ? ORDER BY position, id').all(list.id);
    const view = (it) => {
      const g = itemProgress(it);
      return {
        id: it.id, title: it.title, description: it.description, price: it.price, url: it.url, image: it.image,
        favorite: !!it.favorite, quantity: it.quantity, taken: g.taken, groupTarget: it.group_target, pledged: g.pledged,
      };
    };
    if (sess.admin) {
      const buyers = db.prepare('SELECT id, phone, email, from_name AS fromName, amount, at FROM purchases WHERE item_id = ? AND cancelled_at IS NULL ORDER BY at');
      return send(res, 200, { list: head, items: all.map((it) => ({ ...view(it), status: it.status, buyers: buyers.all(it.id) })), mine: [] });
    }
    // Lo que el invitado ha marcado él mismo (aunque el artículo siga admitiendo más).
    const now = Date.now();
    const mine = db.prepare(`
      SELECT p.id AS purchaseId, p.item_id AS itemId, p.from_name AS buyerFrom, p.amount, p.at
      FROM purchases p JOIN items i ON i.id = p.item_id
      WHERE i.list_id = ? AND p.phone = ? AND p.cancelled_at IS NULL ORDER BY p.at`).all(list.id, sess.phone)
      .map((p) => {
        const it = all.find((x) => x.id === p.itemId);
        return { ...view(it), purchaseId: p.purchaseId, buyerFrom: p.buyerFrom, amount: p.amount, canUndo: now - p.at < UNDO_WINDOW };
      });
    return send(res, 200, { list: head, items: all.filter((it) => it.status === 'available').map(view), mine });
  }
  if (m === 'POST' && (mm = p.match(/^\/api\/items\/(\d+)\/buy$/))) {
    limit('buy:' + ip, 60, 3600e3);
    const body = await readBody(req);
    const fromName = str(body.from, 120);
    if (!fromName) bad(400, 'Dinos de parte de quién es el regalo.');
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(mm[1]));
    if (!item || !visibleList(item.list_id, sess)) bad(404, 'Ese artículo ya no existe');
    if (!sess.admin) {
      const today = db.prepare('SELECT COUNT(*) AS n FROM purchases WHERE phone = ? AND at > ?').get(sess.phone, Date.now() - 86400e3).n;
      if (today >= MAX_GIFTS_PER_DAY) bad(429, `Has llegado al máximo de ${MAX_GIFTS_PER_DAY} regalos al día. Si necesitas marcar más, avisa a los organizadores.`);
    }
    // Sin ningún "await" entre comprobar y escribir: aunque dos pulsen a la vez, no se pasa del cupo.
    const prog = itemProgress(item);
    if (item.status !== 'available' || prog.full) bad(409, '¡Vaya! Alguien se te ha adelantado: este artículo ya no está disponible.');
    let amount = null;
    if (item.group_target != null) {
      amount = Number(String(body.amount ?? '').replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0) bad(400, 'Dinos cuánto quieres aportar.');
      const left = Math.round((item.group_target - prog.pledged) * 100) / 100;
      amount = Math.min(Math.round(amount * 100) / 100, left); // nunca más de lo que falta
    }
    const at = Date.now();
    db.prepare('INSERT INTO purchases (item_id, phone, from_name, at, amount, email) VALUES (?,?,?,?,?,?)').run(item.id, sess.phone, fromName, at, amount, sess.email || '');
    refreshStatus(item.id);
    notifyPurchase(item, { phone: sess.phone, email: sess.email, from_name: fromName, amount, at });
    return send(res, 200, { ok: true, amount });
  }
  // El invitado puede deshacer lo que él mismo marcó, durante unos minutos.
  if (m === 'POST' && (mm = p.match(/^\/api\/purchases\/(\d+)\/undo$/))) {
    const pch = db.prepare('SELECT * FROM purchases WHERE id = ? AND cancelled_at IS NULL').get(Number(mm[1]));
    if (!pch || pch.phone !== sess.phone) bad(404, 'No encontramos ese regalo entre los tuyos.');
    if (Date.now() - pch.at >= UNDO_WINDOW) bad(403, 'Ya han pasado más de 10 minutos. Avisa a los organizadores para que lo vuelvan a poner en la lista.');
    cancelPurchase(pch.id, sess.phone);
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(pch.item_id);
    if (item) notifyUndo(item, pch);
    return send(res, 200, { ok: true });
  }

  // --- Solo administradores ---
  if (!p.startsWith('/api/admin/')) bad(404, 'No encontrado');
  if (!sess.admin) bad(403, 'No tienes permiso');

  if (m === 'POST' && p === '/api/admin/lists') {
    const body = await readBody(req);
    const name = str(body.name, 80);
    if (!name) bad(400, 'La lista necesita un nombre');
    const r = db.prepare('INSERT INTO lists (name, description, created_at, share_token) VALUES (?,?,?,?)').run(name, str(body.description, 300), Date.now(), newShareToken());
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if ((mm = p.match(/^\/api\/admin\/lists\/(\d+)$/))) {
    const id = Number(mm[1]);
    if (!db.prepare('SELECT 1 AS x FROM lists WHERE id = ?').get(id)) bad(404, 'Esa lista no existe');
    if (m === 'PUT') {
      const body = await readBody(req);
      const name = str(body.name, 80);
      if (!name) bad(400, 'La lista necesita un nombre');
      const raw = Array.isArray(body.whitelist) ? body.whitelist.slice(0, 1000) : [];
      const phones = new Set();
      const invalid = [];
      for (const v of raw) {
        const ph = normPhone(String(v));
        if (ph) phones.add(ph); else if (String(v).trim()) invalid.push(String(v).slice(0, 30));
      }
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE lists SET name = ?, description = ?, whitelist_enabled = ?, listed = ? WHERE id = ?').run(name, str(body.description, 300), body.whitelistEnabled ? 1 : 0, body.listed === false ? 0 : 1, id);
        db.prepare('DELETE FROM list_whitelist WHERE list_id = ?').run(id);
        const ins = db.prepare('INSERT INTO list_whitelist (list_id, phone) VALUES (?,?)');
        for (const ph of phones) ins.run(id, ph);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, { ok: true, invalid });
    }
    if (m === 'DELETE') {
      const imgs = db.prepare('SELECT image FROM items WHERE list_id = ?').all(id).map((r) => r.image);
      db.prepare('DELETE FROM lists WHERE id = ?').run(id);
      imgs.forEach(dropImageIfUnused);
      return send(res, 200, { ok: true });
    }
  }
  if (m === 'POST' && (mm = p.match(/^\/api\/admin\/lists\/(\d+)\/share$/))) {
    // Cambiar el enlace: el anterior deja de funcionar y quien entró con él pierde el acceso.
    const id = Number(mm[1]);
    if (!db.prepare('SELECT 1 AS x FROM lists WHERE id = ?').get(id)) bad(404, 'Esa lista no existe');
    const tok = newShareToken();
    db.prepare('UPDATE lists SET share_token = ? WHERE id = ?').run(tok, id);
    db.prepare('DELETE FROM session_lists WHERE list_id = ?').run(id);
    return send(res, 200, { shareToken: tok });
  }
  if (m === 'POST' && p === '/api/admin/preview') {
    limit('preview:' + sess.phone, 60, 3600e3);
    const body = await readBody(req);
    let data;
    try { data = await scrape(str(body.url, 2000)); } catch (e) { bad(422, `No hemos podido leer la ficha: ${e.message}. Rellénala a mano o usa el botón «Añadir a mi lista» (lo tienes en Configuración).`); }
    let image = '';
    if (data.imageUrl) { try { image = await downloadImage(data.imageUrl, IMG_DIR); } catch { /* sin imagen */ } }
    return send(res, 200, { title: data.title, description: data.description, price: data.price, image });
  }
  if (m === 'POST' && (mm = p.match(/^\/api\/admin\/lists\/(\d+)\/items$/))) {
    const listId = Number(mm[1]);
    if (!db.prepare('SELECT 1 AS x FROM lists WHERE id = ?').get(listId)) bad(404, 'Esa lista no existe');
    const body = await readBody(req);
    const f = itemFields(body);
    let image;
    try { image = await resolveImage(body); } catch (e) { bad(422, e.message); }
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM items WHERE list_id = ?').get(listId).n;
    const r = db.prepare('INSERT INTO items (list_id, url, title, description, price, image, created_by, created_at, quantity, group_target, favorite, position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(listId, f.url, f.title, f.description, f.price, image, sess.phone, Date.now(), f.quantity, f.groupTarget, f.favorite, pos);
    return send(res, 200, { id: Number(r.lastInsertRowid) });
  }
  if ((mm = p.match(/^\/api\/admin\/items\/(\d+)$/))) {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(mm[1]));
    if (!item) bad(404, 'Ese artículo no existe');
    if (m === 'PUT') {
      const body = await readBody(req);
      const f = itemFields(body);
      let image;
      try { image = await resolveImage(body); } catch (e) { bad(422, e.message); }
      if ((f.groupTarget != null) !== (item.group_target != null) && itemProgress(item).taken > 0) bad(409, 'Este artículo ya tiene regalos marcados: anúlalos en el Registro antes de cambiar entre «unidades» y «regalo entre varios».');
      db.prepare('UPDATE items SET url = ?, title = ?, description = ?, price = ?, image = ?, quantity = ?, group_target = ?, favorite = ? WHERE id = ?')
        .run(f.url, f.title, f.description, f.price, image, f.quantity, f.groupTarget, f.favorite, item.id);
      refreshStatus(item.id);
      if (image !== item.image) dropImageIfUnused(item.image);
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
      dropImageIfUnused(item.image);
      return send(res, 200, { ok: true });
    }
  }
  if (m === 'POST' && (mm = p.match(/^\/api\/admin\/items\/(\d+)\/enable$/))) {
    const body = await readBody(req);
    const id = Number(mm[1]);
    if (!db.prepare('SELECT 1 AS x FROM items WHERE id = ?').get(id)) bad(404, 'Ese artículo no existe');
    const cur = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    if (body.enabled) {
      if (cur.status === 'purchased') {
        // Volver a poner en la lista algo ya completo: se anulan sus compras (quedan en el registro).
        db.prepare('UPDATE purchases SET cancelled_at = ?, cancelled_by = ? WHERE item_id = ? AND cancelled_at IS NULL').run(Date.now(), sess.phone, id);
      }
      db.prepare("UPDATE items SET status = 'available' WHERE id = ?").run(id);
      refreshStatus(id);
    } else {
      db.prepare("UPDATE items SET status = 'disabled' WHERE id = ? AND status = 'available'").run(id);
    }
    return send(res, 200, { ok: true });
  }
  // Ordenar: intercambia la posición con el artículo de al lado.
  if (m === 'POST' && (mm = p.match(/^\/api\/admin\/items\/(\d+)\/move$/))) {
    const body = await readBody(req);
    const it = db.prepare('SELECT id, list_id FROM items WHERE id = ?').get(Number(mm[1]));
    if (!it) bad(404, 'Ese artículo no existe');
    const ids = db.prepare('SELECT id FROM items WHERE list_id = ? ORDER BY position, id').all(it.list_id).map((r) => r.id);
    const i = ids.indexOf(it.id);
    const j = i + (body.dir < 0 ? -1 : 1);
    if (j >= 0 && j < ids.length) {
      [ids[i], ids[j]] = [ids[j], ids[i]];
      const up = db.prepare('UPDATE items SET position = ? WHERE id = ?');
      ids.forEach((id, n) => up.run(n + 1, id));
    }
    return send(res, 200, { ok: true });
  }
  // Anular una compra concreta: el artículo vuelve a admitir a otra persona.
  if (m === 'POST' && (mm = p.match(/^\/api\/admin\/purchases\/(\d+)\/cancel$/))) {
    if (!cancelPurchase(Number(mm[1]), sess.phone)) bad(404, 'Esa compra no existe o ya estaba anulada');
    return send(res, 200, { ok: true });
  }
  // Números bloqueados: no pueden entrar, y si estaban dentro se les cierra la sesión.
  if (m === 'GET' && p === '/api/admin/blocked') {
    return send(res, 200, { blocked: db.prepare('SELECT phone, at FROM blocked ORDER BY at DESC').all() });
  }
  if (m === 'POST' && p === '/api/admin/blocked') {
    const body = await readBody(req);
    const phone = normPhone(String(body.phone || ''));
    if (!phone) bad(400, 'Ese número no es válido');
    if (ADMINS.has(phone)) bad(400, 'No se puede bloquear a un administrador');
    db.prepare('INSERT OR IGNORE INTO blocked (phone, at, by) VALUES (?,?,?)').run(phone, Date.now(), sess.phone);
    db.prepare('DELETE FROM sessions WHERE phone = ?').run(phone);
    return send(res, 200, { ok: true });
  }
  if (m === 'DELETE' && (mm = p.match(/^\/api\/admin\/blocked\/(\+?\d{8,15})$/))) {
    db.prepare('DELETE FROM blocked WHERE phone = ?').run(mm[1]);
    return send(res, 200, { ok: true });
  }
  if (m === 'GET' && p === '/api/admin/purchases') return send(res, 200, { purchases: purchaseRows() });
  if (m === 'GET' && p === '/api/admin/logins') {
    return send(res, 200, { logins: db.prepare('SELECT phone, email, is_admin AS admin, at FROM logins ORDER BY at DESC LIMIT 500').all() });
  }
  if (m === 'GET' && p === '/api/admin/export.csv') {
    const fmt = (t) => new Date(t).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
    const lines = [['Fecha', 'Lista', 'Artículo', 'Precio', 'Aporta', 'Enlace', 'Teléfono', 'Correo', 'De parte de', 'Estado'].map(csvCell).join(';')];
    for (const r of purchaseRows()) {
      lines.push([fmt(r.at), r.list, r.title, r.price, r.amount != null ? euros(r.amount) : '', r.url, r.phone, r.email, r.fromName, r.cancelledAt ? `Anulada (${fmt(r.cancelledAt)})` : 'Comprado'].map(csvCell).join(';'));
    }
    return send(res, 200, '﻿' + lines.join('\r\n') + '\r\n', {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="regalos.csv"',
    });
  }
  bad(404, 'No encontrado');
}

const BOT_UA = /bot|crawl|spider|slurp|scrap|curl|wget|python|httpclient|http-client|okhttp|axios|node-fetch|undici|go-http|java\/|libwww|headless|phantom|selenium|puppeteer|playwright|facebookexternalhit|whatsapp|telegram|preview|gpt|claude|anthropic|perplexity|bytedance|cohere/i;

// WhatsApp, iMessage, Telegram… piden la página para pintar la tarjeta del enlace. Se les deja
// ver SOLO la portada pública (no contiene ningún dato) y la imagen de la tarjeta.
const PREVIEW_UA = /whatsapp|facebookexternalhit|facebot|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|skypeuripreview/i;
const PREVIEW_PATHS = /^\/(?:|l\/[A-Za-z0-9_-]{22}|og\.png|favicon\.(?:ico|png|svg)|apple-touch-icon\.png)$/;

const server = http.createServer((req, res) => {
  const ip = (TRUST_PROXY && String(req.headers['x-real-ip'] || '').slice(0, 64)) || req.socket.remoteAddress || '?';
  const ua = String(req.headers['user-agent'] || '');
  const previewer = PREVIEW_UA.test(ua) && ua.length <= 400;
  if (previewer) {
    const path0 = String(req.url || '').split('?')[0];
    if (req.method !== 'GET' || !PREVIEW_PATHS.test(path0)) return send(res, 403, { error: 'Acceso no permitido' });
  } else if (!ua || ua.length > 400 || BOT_UA.test(ua)) return send(res, 403, { error: 'Acceso no permitido' });
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return send(res, 405, { error: 'Método no permitido' });
  if (!hit('all:' + ip, 300, 60e3)) return send(res, 429, { error: 'Demasiadas peticiones. Espera un momento.' });
  route(req, res, ip).catch((e) => {
    if (res.headersSent) return res.destroy();
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error('Error interno:', e);
    send(res, 500, { error: 'Error interno' });
  });
});
server.headersTimeout = 10e3;
server.requestTimeout = 30e3;
server.keepAliveTimeout = 30e3;
server.maxHeadersCount = 60;
server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Lista de regalos escuchando en :${PORT} (${ADMINS.size} admins)`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); });

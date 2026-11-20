'use strict';
// Descarga segura (anti-SSRF) de páginas de producto y extracción de título,
// descripción, precio e imagen. Sin dependencias.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------- Anti-SSRF: solo IPs públicas ----------
const blocked = new net.BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [
  ['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
]) blocked.addSubnet(ip, bits, 'ipv6');

function isPublicIp(ip) {
  const fam = net.isIP(ip);
  if (!fam) return false;
  // IPv4 mapeada en IPv6 (::ffff:a.b.c.d): se rechaza siempre. No va como regla del
  // BlockList porque Node la aplicaría también a todas las IPv4 normales.
  if (fam === 6 && /^(0*:)*:?ffff:/i.test(ip)) return false;
  return !blocked.check(ip, fam === 4 ? 'ipv4' : 'ipv6');
}

// La IP validada es la misma que se usa para conectar (evita DNS rebinding).
function safeLookup(hostname, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || !addrs.every((a) => isPublicIp(a.address))) return cb(new Error('Destino no permitido'));
    if (opts && opts.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// Segundo intento: muchas tiendas solo enseñan su ficha (Open Graph) a los previsualizadores de enlaces.
const UA_PREVIEW = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

function checkUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new Error('URL no válida'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Solo se admiten enlaces http/https');
  if (u.username || u.password) throw new Error('URL no válida');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('Puerto no permitido');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isPublicIp(host)) throw new Error('Destino no permitido');
  if (!host.includes('.') && !net.isIP(host)) throw new Error('Destino no permitido');
  return u;
}

function fetchOnce(u, { maxBytes, truncate, accept, deadline, ua }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    const end = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      err ? reject(err) : resolve(val);
    };
    const req = mod.request(u, {
      method: 'GET',
      lookup: safeLookup,
      agent: false,
      headers: {
        'User-Agent': ua || UA,
        Accept: accept,
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Upgrade-Insecure-Requests': '1',
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return end(null, { redirect: res.headers.location });
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let n = 0;
      const finish = () => end(null, { status, headers: res.headers, body: Buffer.concat(chunks) });
      stream.on('data', (c) => {
        n += c.length;
        if (n > maxBytes) {
          if (!truncate) return end(new Error('Respuesta demasiado grande'));
          chunks.push(c.subarray(0, c.length - (n - maxBytes)));
          return finish();
        }
        chunks.push(c);
      });
      stream.on('end', finish);
      stream.on('error', (e) => (truncate && chunks.length ? finish() : end(e)));
      res.on('error', (e) => end(e));
    });
    const timer = setTimeout(() => end(new Error('La web ha tardado demasiado en responder')), Math.max(1, deadline - Date.now()));
    req.on('error', (e) => end(e));
    req.end();
  });
}

async function safeFetch(urlStr, opts) {
  const deadline = Date.now() + 12000;
  let u = checkUrl(urlStr);
  for (let hop = 0; hop < 6; hop++) {
    const r = await fetchOnce(u, { ...opts, deadline });
    if (!r.redirect) return { ...r, url: u.toString() };
    u = checkUrl(new URL(r.redirect, u).toString());
  }
  throw new Error('Demasiadas redirecciones');
}

// ---------- Parseo de HTML ----------
const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', pound: '£', iquest: '¿', iexcl: '¡',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ccedil: 'ç',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Uuml: 'Ü', Ccedil: 'Ç',
  ordf: 'ª', ordm: 'º', deg: '°', reg: '®', copy: '©', trade: '™', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
};
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return cp > 0 ? String.fromCodePoint(cp) : ''; } catch { return ''; }
    }
    return Object.hasOwn(ENT, e) ? ENT[e] : m;
  });
}
const clean = (s, max) => decode(String(s || '').replace(/<[^>]*>/g, ' '))
  .replace(/[\u0000-\u001f\u007f ​-‏‪-‮]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function attrs(tag) {
  const o = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) o[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  return o;
}

function findProduct(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const p = findProduct(n, depth + 1); if (p) return p; }
    return null;
  }
  const t = node['@type'];
  if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) return node;
  for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item']) {
    const p = findProduct(node[k], depth + 1);
    if (p) return p;
  }
  return null;
}

function fmtPrice(amount, currency) {
  if (amount == null || amount === '') return '';
  const raw = String(amount).trim();
  const num = Number(raw.replace(/\s/g, '').replace(/^(\d{1,3}(?:\.\d{3})+),(\d+)$/, (m) => m.replace(/\./g, '').replace(',', '.')).replace(/^(\d+),(\d{1,2})$/, '$1.$2'));
  if (!Number.isFinite(num) || num <= 0) return raw.slice(0, 40);
  const cur = String(currency || 'EUR').toUpperCase();
  const sym = { EUR: '€', USD: '$', GBP: '£' }[cur] || cur.slice(0, 3);
  return `${num.toFixed(2).replace('.', ',')} ${sym}`;
}

function parseProduct(html, baseUrl) {
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content && !(key in meta)) meta[key] = a.content;
  }
  let ld = null;
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { ld = findProduct(JSON.parse(m[1].trim())); } catch { /* JSON-LD roto: ignorar */ }
    if (ld) break;
  }
  const first = (...v) => v.find((x) => typeof x === 'string' && x.trim()) || '';
  const pick = (re) => { const m = html.match(re); return m ? m[1] : ''; };

  // Título
  const title = first(
    pick(/<span[^>]+id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i),
    ld && ld.name, meta['og:title'], meta['twitter:title'], pick(/<title[^>]*>([\s\S]*?)<\/title>/i));

  // Descripción
  const description = first(ld && ld.description, meta['og:description'], meta['description'], meta['twitter:description']);

  // Imagen
  let ldImg = ld && ld.image;
  if (Array.isArray(ldImg)) ldImg = ldImg[0];
  if (ldImg && typeof ldImg === 'object') ldImg = ldImg.url || ldImg.contentUrl;
  let image = first(
    pick(/"hiRes"\s*:\s*"(https:[^"]+)"/),
    pick(/data-old-hires=["'](https:[^"']+)["']/i),
    pick(/<img[^>]+id=["']landingImage["'][^>]*\ssrc=["'](https:[^"']+)["']/i),
    meta['og:image:secure_url'], meta['og:image'], ldImg, meta['twitter:image'], meta['twitter:image:src'],
    pick(/<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i));
  if (image) { try { image = new URL(decode(image), baseUrl).toString(); } catch { image = ''; } }

  // Precio
  let offer = ld && ld.offers;
  if (Array.isArray(offer)) offer = offer[0];
  let price = '';
  if (offer && typeof offer === 'object') price = fmtPrice(offer.price ?? offer.lowPrice ?? (offer.priceSpecification && offer.priceSpecification.price), offer.priceCurrency);
  if (!price) price = fmtPrice(meta['product:price:amount'] || meta['og:price:amount'] || meta['price'], meta['product:price:currency'] || meta['og:price:currency'] || meta['pricecurrency']);
  if (!price) {
    const i = html.search(/id=["']corePrice/i);
    const scope = i >= 0 ? html.slice(i, i + 6000) : html;
    price = (scope.match(/class=["']a-offscreen["'][^>]*>([^<]{1,30})</i) || [])[1] || '';
  }

  return { title: clean(title, 200), description: clean(description, 600), price: clean(price, 40), imageUrl: image };
}

function decodeBody(buf, contentType) {
  let cs = (String(contentType || '').match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!cs) cs = (buf.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

async function scrape(urlStr) {
  let lastErr = new Error('La tienda no ha devuelto datos');
  let best = null;
  for (const ua of [UA, UA_PREVIEW]) {
    try {
      const r = await safeFetch(urlStr, {
        maxBytes: 5 * 1024 * 1024, truncate: true, ua,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      });
      if (r.status >= 400) throw new Error(`la tienda bloquea las lecturas automáticas (error ${r.status})`);
      const data = { ...parseProduct(decodeBody(r.body, r.headers['content-type']), r.url), finalUrl: r.url };
      if (data.title && data.imageUrl) return data;
      if (!best || (data.title && !best.title)) best = data;
    } catch (e) { lastErr = e; }
  }
  if (best && best.title) return best;
  // La tienda no deja leer la ficha: si el enlace lleva el nombre del producto (Amazon), se aprovecha.
  const slug = (() => { try { return (new URL(urlStr).pathname.match(/^\/([^/]{6,})\/dp\/[A-Z0-9]{10}/) || [])[1]; } catch { return null; } })();
  if (slug) return { title: clean(slug.replace(/%[0-9A-Fa-f]{2}/g, ' ').replace(/[-_]+/g, ' '), 200), description: '', price: '', imageUrl: '', finalUrl: urlStr, partial: true };
  throw lastErr;
}

// ---------- Imágenes ----------
function imageExt(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  return null;
}

async function downloadImage(urlStr, dir) {
  const r = await safeFetch(urlStr, { maxBytes: 6 * 1024 * 1024, truncate: false, accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5' });
  if (r.status !== 200) throw new Error('No se pudo descargar la imagen');
  const ext = imageExt(r.body);
  if (!ext) throw new Error('El archivo no es una imagen válida (jpg, png, webp o gif)');
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, name), r.body, { mode: 0o600 });
  return name;
}

module.exports = { scrape, downloadImage, checkUrl, isPublicIp, parseProduct };

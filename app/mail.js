'use strict';
// Cliente SMTP mínimo (sin dependencias) contra el relay local del servidor.
const net = require('node:net');
const crypto = require('node:crypto');

const HOST = process.env.SMTP_HOST || '127.0.0.1';
const PORT = Number(process.env.SMTP_PORT || 25);
const FROM = process.env.MAIL_FROM || 'noreply@localhost';

// Buzones a los que NUNCA se envía, pase lo que pase (BLOCKED_RECIPIENTS=a@x.com,b@y.com).
const BLOCKED = new Set(String(process.env.BLOCKED_RECIPIENTS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function sendMail({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    to = String(to || '').trim().toLowerCase();
    if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/.test(to)) return reject(new Error('destinatario no válido'));
    if (BLOCKED.has(to)) return reject(new Error('destinatario vetado'));

    const body = [
      `From: Lista de regalos <${FROM}>`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${b64(subject)}?=`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <${crypto.randomUUID()}@${FROM.split('@')[1]}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      'Auto-Submitted: auto-generated',
      '',
      b64(text).replace(/(.{76})/g, '$1\r\n'),
    ].join('\r\n');

    const steps = [
      [220, `EHLO ${FROM.split('@')[1]}`],
      [250, `MAIL FROM:<${FROM}>`],
      [250, `RCPT TO:<${to}>`],
      [250, 'DATA'],
      [354, body + '\r\n.'],
      [250, 'QUIT'],
    ];
    let i = 0;
    let buf = '';
    let done = false;
    const sock = net.connect({ host: HOST, port: PORT });
    const finish = (err) => {
      if (done) return;
      done = true;
      sock.destroy();
      err ? reject(err) : resolve();
    };
    sock.setTimeout(15000, () => finish(new Error('SMTP timeout')));
    sock.on('error', finish);
    sock.on('close', () => finish(new Error('SMTP cerrado antes de tiempo')));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (/^\d{3}-/.test(line)) continue; // respuesta multilínea, esperar la última
        const code = Number(line.slice(0, 3));
        if (i >= steps.length) return finish();
        const [expect, cmd] = steps[i];
        if (code !== expect) return finish(new Error(`SMTP ${line}`));
        i++;
        sock.write(cmd + '\r\n');
        if (i === steps.length) { // QUIT enviado; el correo ya fue aceptado (250)
          done = true;
          sock.end();
          return resolve();
        }
      }
    });
  });
}

module.exports = { sendMail };

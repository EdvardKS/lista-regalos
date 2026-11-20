'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const view = $('view');
  const state = { me: null, listId: null, editing: null, buying: null };
  // Enlace de una lista concreta: /l/<código>. Quien entra por aquí solo ve esa lista.
  const SHARE = (location.pathname.match(/^\/l\/([A-Za-z0-9_-]{22})$/) || [])[1] || '';

  // ---------- Artículo capturado con el botón «Añadir a mi lista» ----------
  // Llega en el fragmento de la URL (#/add=…), que nunca viaja al servidor.
  const cut = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  function takeCapture() {
    if (!location.hash.startsWith('#/add=')) return;
    try {
      const d = JSON.parse(decodeURIComponent(location.hash.slice(6)));
      const cap = { url: cut(d.u, 2000), title: cut(d.t, 200), description: cut(d.d, 600), price: cut(d.p, 40), imageUrl: cut(d.i, 2000) };
      if (cap.title || cap.url) sessionStorage.setItem('capture', JSON.stringify(cap));
    } catch { /* captura ilegible: se ignora */ }
    history.replaceState(null, '', '#/');
  }
  const getCapture = () => { try { return JSON.parse(sessionStorage.getItem('capture')); } catch { return null; } };
  const clearCapture = () => { try { sessionStorage.removeItem('capture'); } catch { /* nada */ } };
  takeCapture();

  // ---------- Utilidades ----------
  // Todo el contenido se pinta con nodos de texto (nunca innerHTML): sin XSS.
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    for (const c of kids.flat(Infinity)) {
      if (c == null || c === false) continue;
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return e;
  }
  const show = (...nodes) => { view.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false && n !== '')); };
  const spinner = () => h('div', { class: 'text-center py-5' }, h('div', { class: 'spinner-border text-secondary', role: 'status' }));
  const fmtDate = (t) => new Date(t).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
  const safeHref = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
  const shop = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'la tienda'; } };

  function notify(msg, type = 'success') {
    const a = h('div', { class: `alert alert-${type} alert-dismissible fade show`, role: 'alert' }, msg,
      h('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'alert', 'aria-label': 'Cerrar' }));
    $('alerts').replaceChildren(a);
    if (type === 'success') setTimeout(() => a.remove(), 6000);
  }
  function fieldError(id, msg) {
    const e = $(id);
    e.textContent = msg || '';
    e.classList.toggle('d-none', !msg);
  }

  async function api(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(url, opts); } catch { throw new Error('Sin conexión. Inténtalo de nuevo.'); }
    let data = {};
    try { data = await r.json(); } catch { /* respuesta sin JSON */ }
    if (r.status === 401 && state.me) { state.me = null; renderLogin(); }
    if (!r.ok) throw new Error(data.error || 'Ha ocurrido un error.');
    return data;
  }

  // ---------- Prueba de trabajo (anti-bots) ----------
  async function solve(c, bits) {
    const enc = new TextEncoder();
    for (let n = 0; ; n++) {
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${c}:${n}`)));
      let zeros = 0;
      for (const b of d) { if (b === 0) { zeros += 8; continue; } zeros += Math.clz32(b) - 24; break; }
      if (zeros >= bits) return n;
    }
  }

  // ---------- Tema (claro / oscuro / automático) ----------
  const THEME_LABEL = { auto: '🌗 Tema: automático', light: '☀️ Tema: claro', dark: '🌙 Tema: oscuro' };
  const themeLabel = () => THEME_LABEL[window.appTheme.get()];
  $('themeBtn').textContent = themeLabel();
  $('themeBtn').addEventListener('click', (ev) => {
    ev.stopPropagation(); // no cerrar el menú: se puede seguir pulsando para cambiar
    window.appTheme.next();
    $('themeBtn').textContent = themeLabel();
  });

  // ---------- Acceso ----------
  function chrome() {
    $('nav').classList.toggle('d-none', !state.me);
    document.querySelectorAll('.admin-only').forEach((e) => e.classList.toggle('d-none', !(state.me && state.me.admin)));
    // Quien entra por el enlace de una lista se queda en ella: sin portada ni «volver».
    const locked = !!(state.me && state.lock);
    document.querySelectorAll('.home-link').forEach((e) => e.classList.toggle('d-none', locked));
    $('brand').setAttribute('href', locked ? `#/l/${state.lock}` : '#/');
    $('navUser').textContent = state.me ? `${state.me.phone}${state.me.admin ? ' · admin' : ''} ` : '';
  }

  const privacyModal = new bootstrap.Modal($('privacyModal'));
  $('privacyBtn').addEventListener('click', () => privacyModal.show());
  const privacyLink = (text) => h('button', { class: 'btn btn-link p-0 align-baseline', type: 'button', onclick: () => privacyModal.show() }, text);

  // Tarjeta común de las tres pantallas de acceso (móvil → correo → PIN).
  function authCard(title, intro, form, back) {
    show(h('div', { class: 'row justify-content-center pt-4' }, h('div', { class: 'col-12 col-sm-9 col-md-6 col-lg-4' },
      h('div', { class: 'card' }, h('div', { class: 'card-body p-4' },
        h('div', { class: 'display-4 text-center' }, '🎁'),
        h('h1', { class: 'h4 text-center mb-2' }, title),
        h('p', { class: 'text-body-secondary text-center' }, intro),
        form,
        back && h('button', { class: 'btn btn-link w-100 mt-2', type: 'button', onclick: renderLogin }, 'Volver'))),
      h('div', { class: 'd-flex flex-wrap justify-content-center gap-2 mt-3' },
        h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: (ev) => { window.appTheme.next(); ev.currentTarget.textContent = themeLabel(); $('themeBtn').textContent = themeLabel(); } }, themeLabel()),
        h('button', { class: 'btn btn-sm btn-outline-secondary', type: 'button', onclick: () => privacyModal.show() }, 'Privacidad')))));
  }
  // Formulario de un paso: gestiona el botón, el error y la prueba anti-bots.
  function stepForm(label, input, buttonText, onSubmit, extra) {
    const err = h('div', { class: 'text-danger small mt-2 d-none' });
    const btn = h('button', { class: 'btn btn-primary btn-lg w-100 mt-3', type: 'submit' }, buttonText);
    return h('form', {
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.classList.add('d-none');
        btn.disabled = true;
        btn.textContent = 'Un momento…';
        try { await onSubmit(); } catch (e) {
          err.textContent = e.message;
          err.classList.remove('d-none');
          btn.disabled = false;
          btn.textContent = buttonText;
          input.select();
        }
      },
    }, h('label', { class: 'form-label', for: input.id }, label), input, extra, err, btn);
  }
  async function requestLogin(data) {
    const ch = await api('GET', '/api/challenge');
    const n = await solve(ch.c, ch.bits);
    return api('POST', '/api/login', { ...data, c: ch.c, n, share: SHARE });
  }

  function renderLogin() {
    chrome();
    $('alerts').replaceChildren();
    const phone = h('input', { class: 'form-control form-control-lg', id: 'phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel', maxlength: '20', required: true, placeholder: '600 000 000' });
    // Campo trampa: invisible para personas; los bots que rellenan todo se delatan.
    const trap = h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    authCard('Lista de regalos', 'Escribe tu número de móvil para entrar.',
      stepForm('Tu número de móvil', phone, 'Continuar', async () => {
        const r = await requestLogin({ phone: phone.value, website: trap.value });
        if (r.needEmail) return renderEmail(phone.value);
        if (r.pin) return renderPin(r.email, true);
        await start();
      }, h('div', { class: 'd-none' }, trap)));
    phone.focus();
  }

  function renderEmail(phone) {
    let saved = '';
    try { saved = localStorage.getItem('email') || ''; } catch { /* almacenamiento bloqueado */ }
    const email = h('input', { class: 'form-control form-control-lg', id: 'email', type: 'email', inputmode: 'email', autocomplete: 'email', maxlength: '120', required: true, placeholder: 'tu@correo.com', value: saved });
    authCard('Tu correo', 'Te enviamos un PIN para comprobar que eres tú. Solo se usa para esto y para que los organizadores sepan quién regala.',
      stepForm('Correo electrónico', email, 'Enviarme el PIN', async () => {
        const r = await requestLogin({ phone, email: email.value });
        try { localStorage.setItem('email', email.value.trim()); } catch { /* nada */ }
        renderPin(r.email, false);
      }), true);
    email.focus();
  }

  function renderPin(email, admin) {
    const pin = h('input', { class: 'form-control form-control-lg text-center', id: 'pin', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]*', maxlength: '7', required: true, placeholder: '000000' });
    authCard('Introduce tu PIN', `Te hemos enviado un PIN de 6 cifras a ${email}. Caduca en 10 minutos. Si no lo ves, mira en la carpeta de spam.`,
      stepForm('PIN', pin, admin ? 'Confirmar' : 'Aceptar y entrar', async () => {
        await api('POST', '/api/pin', { pin: pin.value });
        await start();
      }, !admin && h('p', { class: 'small text-body-secondary mt-3 mb-0' },
        'Al introducir el PIN aceptas la ', privacyLink('política de privacidad'),
        ' y el tratamiento de tu teléfono y tu correo para gestionar la lista de regalos, conforme al RGPD y la LOPDGDD.')), true);
    pin.focus();
  }

  // ---------- Compartir una lista (admin) ----------
  const shareUrl = (l) => `${location.origin}/l/${l.shareToken}`;
  async function shareList(l) {
    const url = shareUrl(l);
    if (navigator.share) {
      try { await navigator.share({ title: l.name, text: `🎁 ${l.name}`, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(url);
      notify('Enlace copiado. Quien entre con él solo verá esta lista.');
    } catch { window.prompt('Copia este enlace:', url); }
  }

  // ---------- Listas ----------
  async function renderLists() {
    show(spinner());
    const { lists } = await api('GET', '/api/lists');
    const admin = state.me.admin;
    const cards = lists.map((l) => h('div', { class: 'col' },
      h('div', { class: 'card h-100' },
        h('div', { class: 'card-body' },
          h('h2', { class: 'h5 card-title' }, l.name),
          l.description && h('p', { class: 'card-text text-body-secondary' }, l.description),
          h('p', { class: 'card-text small mb-0' },
            l.available === 1 ? '1 artículo disponible' : `${l.available} artículos disponibles`,
            admin && ` · ${l.total} en total`),
          admin && l.whitelistEnabled && h('span', { class: 'badge text-bg-warning mt-2 me-1' }, `Solo whitelist (${l.whitelist.length})`),
          admin && !l.listed && h('span', { class: 'badge text-bg-secondary mt-2' }, 'Solo con enlace')),
        h('div', { class: 'card-footer border-0 pb-3' },
          h('a', { class: 'btn btn-primary w-100 stretched-link', href: `#/l/${l.id}` }, 'Ver lista')))));
    if (admin) {
      cards.push(h('div', { class: 'col' },
        h('div', { class: 'card h-100 card-ghost' },
          h('div', { class: 'card-body d-flex align-items-center justify-content-center py-5' },
            h('button', { class: 'btn btn-outline-primary stretched-link', type: 'button', onclick: openListModal }, '+ Nueva lista')))));
    }
    const cap = admin && getCapture();
    show(
      h('h1', { class: 'h3 mb-4' }, state.me.scoped && lists.length === 1 ? 'Tu lista' : 'Listas'),
      cap && h('div', { class: 'alert alert-primary d-flex flex-wrap align-items-center justify-content-between gap-2' },
        h('span', null, 'Artículo capturado: ', h('strong', null, cap.title || cap.url), '. Entra en la lista donde quieras añadirlo.'),
        h('button', { class: 'btn btn-sm btn-outline-primary', type: 'button', onclick: () => { clearCapture(); renderLists(); } }, 'Descartar')),
      cards.length
        ? h('div', { class: 'row row-cols-1 row-cols-sm-2 row-cols-lg-3 g-3' }, cards)
        : h('div', { class: 'alert alert-info' }, state.me.scoped ? 'El enlace con el que has entrado ya no es válido. Pide uno nuevo a quien te lo envió.' : 'Ahora mismo no hay ninguna lista disponible para ti.'));
  }

  const eur = (n) => `${Number(n).toLocaleString('es-ES', { maximumFractionDigits: 2 })} €`;
  // Número de un precio escrito a mano («1.299,00 €», «12 €», «29.99»), para poder ordenar.
  function priceNum(t) {
    const m = String(t || '').replace(/\s/g, '').match(/\d[\d.,]*/);
    if (!m) return null;
    let v = m[0];
    if (/,\d{1,2}$/.test(v)) v = v.replace(/\./g, '').replace(',', '.'); else v = v.replace(/,/g, '');
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  function progressBar(done, total) {
    const bar = h('div', { class: 'progress-bar' });
    bar.style.width = `${Math.max(0, Math.min(100, (done / total) * 100))}%`; // por CSSOM: compatible con la CSP
    return h('div', { class: 'progress my-2', role: 'progressbar', 'aria-valuenow': String(Math.round(done)), 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(total)) }, bar);
  }

  function itemCard(it, mode, pos) {
    // mode: 'user' | 'mine' | 'admin' · pos: { first, last } para las flechas de ordenar (admin)
    const off = mode === 'admin' && it.status !== 'available';
    const href = safeHref(it.url);
    const group = it.groupTarget != null;
    const multi = !group && it.quantity > 1;
    const body = h('div', { class: 'card-body' },
      h('div', { class: 'd-flex flex-wrap gap-1 mb-2' },
        it.favorite && h('span', { class: 'badge text-bg-warning' }, '⭐ Nos hace mucha ilusión'),
        group && h('span', { class: 'badge text-bg-secondary' }, '🤝 Entre varios'),
        mode === 'admin' && it.status === 'purchased' && h('span', { class: 'badge text-bg-success' }, group ? 'Completado' : 'Comprado'),
        mode === 'admin' && it.status === 'disabled' && h('span', { class: 'badge text-bg-secondary' }, 'Deshabilitado')),
      h('h3', { class: 'h6 card-title' }, it.title),
      it.description && h('p', { class: 'card-text small text-body-secondary' }, it.description),
      h('div', null,
        it.price && h('p', { class: 'fs-5 fw-bold mb-1 price' }, it.price),
        group && mode !== 'mine' && [progressBar(it.pledged, it.groupTarget),
          h('p', { class: 'small mb-1' }, `Reunido ${eur(it.pledged)} de ${eur(it.groupTarget)}`)],
        multi && mode !== 'mine' && h('p', { class: 'small mb-1' }, it.taken >= it.quantity ? `Regaladas las ${it.quantity}` : `Quedan ${it.quantity - it.taken} de ${it.quantity}`),
        mode === 'admin' && it.buyers.map((b) => h('p', { class: 'small mb-1' },
          h('strong', null, b.fromName), b.amount != null && ` · ${eur(b.amount)}`, h('br'),
          `Tel. ${b.phone}`, b.email && [h('br'), b.email], h('br'), h('span', { class: 'text-body-secondary' }, fmtDate(b.at)))),
        mode === 'mine' && h('p', { class: 'small mb-0' }, `De parte de: ${it.buyerFrom}`, it.amount != null && ` · aportas ${eur(it.amount)}`)));

    const footer = h('div', { class: 'card-footer d-grid gap-2' });
    if (href) footer.append(h('a', { class: `btn ${mode === 'mine' ? 'btn-primary' : 'btn-outline-secondary'}`, href, target: '_blank', rel: 'noopener noreferrer nofollow' }, `Ver en ${shop(it.url)}`));
    if (mode === 'user' || (mode === 'admin' && it.status === 'available')) {
      footer.append(h('button', { class: 'btn btn-primary py-2', type: 'button', onclick: () => openBuy(it) }, group ? '🤝 Participar' : '🎁 Lo regalo yo'));
    }
    if (mode === 'mine' && it.canUndo) {
      footer.append(h('button', {
        class: 'btn btn-outline-danger', type: 'button',
        onclick: async () => {
          if (!confirm('¿Deshacer este regalo? Volverá a aparecer en la lista para todos.')) return;
          try { await api('POST', `/api/purchases/${it.purchaseId}/undo`); notify('Deshecho. El artículo vuelve a estar en la lista.'); } catch (e) { notify(e.message, 'danger'); }
          renderList(state.listId, true);
        },
      }, 'Me he equivocado, deshacer'));
    }
    if (mode === 'admin') {
      const sw = h('input', {
        class: 'form-check-input', type: 'checkbox', role: 'switch', id: `sw${it.id}`, checked: it.status === 'available',
        onchange: async () => {
          if (sw.checked && it.status === 'purchased' && !confirm('Este artículo está completo. Si lo vuelves a habilitar, aparecerá otra vez para todos y sus compras quedarán anuladas en el registro. ¿Continuar?')) { sw.checked = false; return; }
          try { await api('POST', `/api/admin/items/${it.id}/enable`, { enabled: sw.checked }); } catch (e) { notify(e.message, 'danger'); }
          renderList(state.listId, true);
        },
      });
      const move = (dir) => async () => {
        try { await api('POST', `/api/admin/items/${it.id}/move`, { dir }); } catch (e) { notify(e.message, 'danger'); }
        renderList(state.listId, true);
      };
      footer.append(
        h('div', { class: 'form-check form-switch' }, sw, h('label', { class: 'form-check-label small', for: `sw${it.id}` }, 'Visible para los invitados')),
        pos && h('div', { class: 'btn-group btn-group-sm' },
          h('button', { class: 'btn btn-outline-secondary', type: 'button', disabled: pos.first, onclick: move(-1) }, '↑ Subir'),
          h('button', { class: 'btn btn-outline-secondary', type: 'button', disabled: pos.last, onclick: move(1) }, '↓ Bajar')),
        h('div', { class: 'btn-group' },
          h('button', { class: 'btn btn-outline-secondary', type: 'button', onclick: () => openItemModal(it) }, 'Editar'),
          h('button', {
            class: 'btn btn-outline-danger', type: 'button',
            onclick: async () => {
              if (!confirm(`¿Borrar «${it.title}» definitivamente? También se borra su registro de compra.`)) return;
              try { await api('DELETE', `/api/admin/items/${it.id}`); } catch (e) { notify(e.message, 'danger'); }
              renderList(state.listId, true);
            },
          }, 'Borrar')));
    }
    return h('div', { class: 'col' },
      h('div', { class: `card h-100 overflow-hidden ${off ? 'card-off text-body-secondary' : ''}` },
        h('div', { class: 'row g-0 flex-grow-1 align-content-start' },
          h('div', { class: 'col-4 col-sm-12 img-tile' },
            h('div', { class: 'ratio ratio-1x1' },
              it.image
                ? h('img', { class: `object-fit-contain p-2 ${off ? 'opacity-50' : ''}`, src: `/img/${it.image}`, alt: '', loading: 'lazy' })
                : h('div', { class: 'd-flex align-items-center justify-content-center display-4' }, '🎁'))),
          h('div', { class: 'col-8 col-sm-12' }, body)),
        footer));
  }

  const SORTS = { orden: 'Orden de la lista', asc: 'Precio: de menor a mayor', desc: 'Precio: de mayor a menor', fav: 'Primero lo que más ilusión hace' };
  function sortItems(items) {
    const mode = state.sort || 'orden';
    if (mode === 'orden') return items;
    const arr = items.slice();
    if (mode === 'fav') return arr.sort((a, b) => Number(b.favorite) - Number(a.favorite));
    const val = (it) => { const n = priceNum(it.price); return n == null ? Infinity : n; }; // sin precio, al final
    return arr.sort((a, b) => (mode === 'asc' ? val(a) - val(b) : (val(b) === Infinity ? -1 : val(b)) - (val(a) === Infinity ? -1 : val(a))));
  }

  async function renderList(id, quiet) {
    state.listId = id;
    if (!quiet) show(spinner());
    const { list, items, mine } = await api('GET', `/api/lists/${id}`);
    const admin = state.me.admin;
    const sorted = sortItems(items);
    const manual = (state.sort || 'orden') === 'orden';
    const grid = (arr, mode) => h('div', { class: 'row row-cols-1 row-cols-sm-2 row-cols-lg-3 row-cols-xl-4 g-3' },
      arr.map((it, i) => itemCard(it, mode, mode === 'admin' && manual ? { first: i === 0, last: i === arr.length - 1 } : null)));
    const sortSel = h('select', { class: 'form-select w-auto', 'aria-label': 'Ordenar', onchange: () => { state.sort = sortSel.value; renderList(id, true); } },
      Object.entries(SORTS).map(([k, label]) => h('option', { value: k, selected: (state.sort || 'orden') === k }, label)));
    show(
      !state.lock && h('nav', { 'aria-label': 'breadcrumb' }, h('ol', { class: 'breadcrumb' },
        h('li', { class: 'breadcrumb-item' }, h('a', { href: '#/' }, 'Listas')),
        h('li', { class: 'breadcrumb-item active', 'aria-current': 'page' }, list.name))),
      h('div', { class: 'd-flex flex-wrap align-items-center justify-content-between gap-2 mb-3' },
        h('div', null, h('h1', { class: 'h3 mb-0' }, list.name), list.description && h('p', { class: 'text-body-secondary mb-0' }, list.description)),
        admin && h('div', { class: 'd-grid d-sm-flex gap-2 col-12 col-sm-auto' },
          h('button', { class: 'btn btn-outline-primary', type: 'button', onclick: () => shareList(list) }, 'Compartir lista'),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openItemModal(null) }, '+ Añadir artículo'))),
      !admin && h('p', { class: 'text-body-secondary' }, 'Elige lo que quieras regalar y pulsa «Lo regalo yo»: se quitará de la lista para que nadie lo repita.'),
      items.length > 1 && h('div', { class: 'd-flex justify-content-end mb-3' }, sortSel),
      items.length ? grid(sorted, admin ? 'admin' : 'user')
        : h('div', { class: 'alert alert-info' }, admin ? 'Esta lista está vacía. Pulsa «Añadir artículo» y pega un enlace.' : 'Ahora mismo no queda nada disponible en esta lista. ¡Gracias!'),
      mine.length > 0 && [
        h('h2', { class: 'h5 mt-5 mb-1' }, 'Lo que vas a regalar tú'),
        h('p', { class: 'text-body-secondary small' }, 'Solo tú ves esto. Si te has equivocado, tienes 10 minutos para deshacerlo; después, avisa a los organizadores.'),
        grid(mine, 'mine')]);
    const cap = admin && !quiet && getCapture();
    if (cap) { clearCapture(); openItemModal(null, cap); }
  }

  // ---------- Regalar ----------
  const buyModal = new bootstrap.Modal($('buyModal'));
  function openBuy(it) {
    state.buying = it;
    const group = it.groupTarget != null;
    const left = group ? Math.round((it.groupTarget - it.pledged) * 100) / 100 : 0;
    $('buyItem').textContent = it.title;
    $('buyTitle').textContent = group ? 'Participar en este regalo' : '¿Seguro que quieres comprar esto?';
    $('buyWarn').textContent = group
      ? `Es un regalo entre varios: faltan ${eur(left)} de ${eur(it.groupTarget)}. Apunta cuánto quieres poner; cuando se reúna todo, desaparecerá de la lista.`
      : it.quantity > 1
        ? `Quedan ${it.quantity - it.taken} de ${it.quantity}. Al confirmar se apunta una a tu nombre; cuando se regalen todas, desaparecerá de la lista.`
        : 'Al confirmar, este artículo desaparecerá de la lista para todo el mundo, para que nadie más lo compre.';
    $('buyAmountWrap').classList.toggle('d-none', !group);
    $('buyAmount').required = group;
    $('buyAmount').value = '';
    $('buyAmount').placeholder = group ? `Hasta ${eur(left)}` : '';
    $('buySubmit').textContent = group ? 'Sí, participo' : 'Sí, lo regalo yo';
    $('buyFrom').value = localStorage.getItem('from') || '';
    fieldError('buyError');
    buyModal.show();
  }
  $('buyModal').addEventListener('shown.bs.modal', () => $('buyFrom').focus());
  $('buyForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const from = $('buyFrom').value.trim();
    if (!from) return fieldError('buyError', 'Dinos de parte de quién es el regalo.');
    $('buySubmit').disabled = true;
    try {
      const r = await api('POST', `/api/items/${state.buying.id}/buy`, { from, amount: $('buyAmount').value });
      try { localStorage.setItem('from', from); } catch { /* almacenamiento bloqueado */ }
      buyModal.hide();
      notify(r.amount != null
        ? `¡Muchas gracias! Hemos apuntado tu aportación de ${eur(r.amount)}. La tienes abajo, en «Lo que vas a regalar tú».`
        : '¡Muchas gracias! Apuntado. Lo tienes abajo, en «Lo que vas a regalar tú», con el enlace para comprarlo.');
      renderList(state.listId, true);
    } catch (e) {
      fieldError('buyError', e.message);
      renderList(state.listId, true);
    } finally { $('buySubmit').disabled = false; }
  });

  // ---------- Artículos (admin) ----------
  const itemModal = new bootstrap.Modal($('itemModal'));
  function setItemImage(name) {
    state.itemImage = name || '';
    $('itemImg').classList.toggle('d-none', !name);
    $('itemNoImg').classList.toggle('d-none', !!name);
    if (name) $('itemImg').src = `/img/${name}`; else $('itemImg').removeAttribute('src');
  }
  function openItemModal(it, cap) {
    state.editing = it;
    $('itemTitle').textContent = it ? 'Editar artículo' : 'Añadir artículo';
    $('itemUrl').value = it ? it.url : '';
    $('itemName').value = it ? it.title : '';
    $('itemDesc').value = it ? it.description : '';
    $('itemPrice').value = it ? it.price : '';
    $('itemImageUrl').value = '';
    $('itemQty').value = it ? it.quantity : 1;
    $('itemGroup').value = it && it.groupTarget != null ? it.groupTarget : '';
    $('itemFav').checked = !!(it && it.favorite);
    setItemImage(it ? it.image : '');
    $('itemFetchMsg').className = 'form-text mb-3';
    $('itemFetchMsg').textContent = 'Pega el enlace y pulsa «Cargar datos»: rellenamos la ficha por ti y luego puedes retocarla.';
    if (cap) {
      $('itemUrl').value = cap.url;
      $('itemName').value = cap.title;
      $('itemDesc').value = cap.description;
      $('itemPrice').value = cap.price;
      $('itemImageUrl').value = cap.imageUrl;
      $('itemFetchMsg').className = 'form-text mb-3 text-success';
      $('itemFetchMsg').textContent = 'Ficha capturada desde la tienda. Revísala y guarda' + (cap.imageUrl ? ' (la foto se descarga al guardar).' : '.');
    }
    fieldError('itemError');
    itemModal.show();
  }
  $('itemModal').addEventListener('shown.bs.modal', () => $('itemUrl').focus());
  $('itemUrl').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); $('itemFetch').click(); } });
  $('itemFetch').addEventListener('click', async () => {
    const url = $('itemUrl').value.trim();
    const msg = $('itemFetchMsg');
    if (!url) return;
    $('itemFetch').disabled = true;
    msg.className = 'form-text mb-3';
    msg.textContent = 'Leyendo la página de la tienda…';
    try {
      const d = await api('POST', '/api/admin/preview', { url });
      if (d.title) $('itemName').value = d.title;
      if (d.description) $('itemDesc').value = d.description;
      if (d.price) $('itemPrice').value = d.price;
      if (d.image) setItemImage(d.image);
      const missing = [!d.title && 'título', !d.price && 'precio', !d.image && 'foto'].filter(Boolean);
      msg.className = `form-text mb-3 ${missing.length ? 'text-warning-emphasis' : 'text-success'}`;
      msg.textContent = missing.length ? `Datos cargados, pero la tienda no nos ha dado: ${missing.join(', ')}. Complétalo a mano.` : 'Datos cargados. Revísalos y guarda.';
    } catch (e) {
      msg.className = 'form-text mb-3 text-danger';
      msg.textContent = e.message;
    } finally { $('itemFetch').disabled = false; }
  });
  $('itemForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = {
      url: $('itemUrl').value.trim(), title: $('itemName').value, description: $('itemDesc').value,
      price: $('itemPrice').value, image: state.itemImage, imageUrl: $('itemImageUrl').value.trim(),
      quantity: $('itemQty').value, groupTarget: $('itemGroup').value.trim(), favorite: $('itemFav').checked,
    };
    $('itemSubmit').disabled = true;
    try {
      if (state.editing) await api('PUT', `/api/admin/items/${state.editing.id}`, body);
      else await api('POST', `/api/admin/lists/${state.listId}/items`, body);
      itemModal.hide();
      renderList(state.listId, true);
    } catch (e) { fieldError('itemError', e.message); } finally { $('itemSubmit').disabled = false; }
  });

  // ---------- Nueva lista (admin) ----------
  const listModal = new bootstrap.Modal($('listModal'));
  function openListModal() {
    $('listName').value = '';
    $('listDesc').value = '';
    fieldError('listError');
    listModal.show();
  }
  $('listModal').addEventListener('shown.bs.modal', () => $('listName').focus());
  $('listForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/admin/lists', { name: $('listName').value, description: $('listDesc').value });
      listModal.hide();
      render();
    } catch (e) { fieldError('listError', e.message); }
  });

  // ---------- Registro (admin) ----------
  async function blockPhone(phone) {
    if (!confirm(`¿Bloquear el ${phone}? No podrá volver a entrar y se le cierra la sesión. Lo que ya haya marcado no se toca.`)) return false;
    try { await api('POST', '/api/admin/blocked', { phone }); notify(`${phone} bloqueado. Puedes desbloquearlo en Configuración.`); return true; } catch (e) { notify(e.message, 'danger'); return false; }
  }
  async function renderRegistro() {
    show(spinner());
    const [{ purchases }, { logins }, { blocked }] = await Promise.all([api('GET', '/api/admin/purchases'), api('GET', '/api/admin/logins'), api('GET', '/api/admin/blocked')]);
    const isBlocked = new Set(blocked.map((b) => b.phone));
    const tbody = h('tbody');
    const mobile = h('div', { class: 'list-group d-md-none' });
    const estado = (p) => (p.cancelledAt
      ? h('span', { class: 'badge text-bg-secondary' }, `Anulada ${fmtDate(p.cancelledAt)}`)
      : h('span', { class: 'badge text-bg-success' }, 'Comprado'));
    const anular = (p) => !p.cancelledAt && h('button', {
      class: 'btn btn-sm btn-outline-danger', type: 'button',
      onclick: async () => {
        if (!confirm(`¿Anular el regalo de ${p.fromName} («${p.title}»)? El artículo volverá a estar disponible en la lista.`)) return;
        try { await api('POST', `/api/admin/purchases/${p.id}/cancel`); notify('Compra anulada.'); } catch (e) { notify(e.message, 'danger'); }
        renderRegistro();
      },
    }, 'Anular');
    const titleCell = (p) => (safeHref(p.url) ? h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, p.title) : p.title);
    const paint = (q) => {
      q = q.toLowerCase();
      const rows = purchases.filter((p) => !q || [p.list, p.title, p.phone, p.email, p.fromName, p.price].join(' ').toLowerCase().includes(q));
      mobile.replaceChildren(...(rows.length ? rows.map((p) => h('div', { class: `list-group-item ${p.cancelledAt ? 'list-group-item-secondary' : ''}` },
        h('div', { class: 'd-flex justify-content-between align-items-start gap-2' },
          h('div', { class: 'fw-semibold text-break' }, titleCell(p)),
          h('div', { class: 'text-nowrap fw-semibold' }, p.amount != null ? `aporta ${eur(p.amount)}` : p.price)),
        h('div', { class: 'text-break' }, 'De parte de: ', h('strong', null, p.fromName)),
        h('div', null, 'Tel. ', h('a', { href: `tel:${p.phone}` }, p.phone)),
        p.email && h('div', { class: 'text-break' }, h('a', { href: `mailto:${p.email}` }, p.email)),
        h('div', { class: 'd-flex flex-wrap justify-content-between align-items-center gap-2 small text-body-secondary mt-1' },
          h('span', null, `${p.list} · ${fmtDate(p.at)}`), h('span', { class: 'd-flex align-items-center gap-2' }, estado(p), anular(p)))))
        : [h('div', { class: 'list-group-item text-center text-body-secondary py-4' }, 'Todavía no hay nada aquí.')]));
      tbody.replaceChildren(...(rows.length ? rows.map((p) => h('tr', { class: p.cancelledAt ? 'table-secondary' : null },
        h('td', { class: 'text-nowrap' }, fmtDate(p.at)),
        h('td', null, p.list),
        h('td', null, titleCell(p)),
        h('td', { class: 'text-nowrap' }, p.amount != null ? `aporta ${eur(p.amount)}` : p.price),
        h('td', { class: 'text-nowrap' }, p.phone, p.email && [h('br'), h('span', { class: 'small text-body-secondary' }, p.email)]),
        h('td', null, p.fromName),
        h('td', null, estado(p)),
        h('td', { class: 'text-end' }, anular(p))))
        : [h('tr', null, h('td', { colspan: '8', class: 'text-center text-body-secondary py-4' }, 'Todavía no hay nada aquí.'))]));
    };
    const search = h('input', { class: 'form-control', type: 'search', placeholder: 'Buscar por teléfono, correo, nombre, artículo…', 'aria-label': 'Buscar', oninput: () => paint(search.value) });
    paint('');
    show(
      h('div', { class: 'd-flex flex-wrap align-items-center justify-content-between gap-2 mb-3' },
        h('h1', { class: 'h3 mb-0' }, 'Registro de regalos'),
        h('div', { class: 'd-grid d-sm-block col-12 col-sm-auto' }, h('a', { class: 'btn btn-outline-success', href: '/api/admin/export.csv', download: 'regalos.csv' }, 'Descargar para Excel (CSV)'))),
      h('div', { class: 'mb-3' }, search),
      mobile,
      h('div', { class: 'table-wrap d-none d-md-block' },
        h('table', { class: 'table table-striped table-hover align-middle mb-0' },
          h('thead', { class: 'table-light' }, h('tr', null, ['Fecha', 'Lista', 'Artículo', 'Precio', 'Teléfono y correo', 'De parte de', 'Estado', ''].map((t) => h('th', { scope: 'col' }, t)))),
          tbody)),
      h('h2', { class: 'h5 mt-5 mb-1' }, 'Últimos accesos'),
      h('p', { class: 'small text-body-secondary' }, 'Se borran solos a los 90 días.'),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'table table-striped align-middle mb-0' },
          h('thead', { class: 'table-light' }, h('tr', null, ['Fecha', 'Teléfono y correo', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, logins.map((l) => h('tr', null,
            h('td', { class: 'text-nowrap' }, fmtDate(l.at)),
            h('td', { class: 'text-break' }, l.phone, l.admin ? ' · admin' : '', l.email && [h('br'), h('span', { class: 'small text-body-secondary' }, l.email)]),
            h('td', { class: 'text-end' }, l.admin ? null : isBlocked.has(l.phone)
              ? h('span', { class: 'badge text-bg-secondary' }, 'Bloqueado')
              : h('button', { class: 'btn btn-sm btn-outline-danger', type: 'button', onclick: async () => { if (await blockPhone(l.phone)) renderRegistro(); } }, 'Bloquear'))))))));
  }

  // ---------- Botón de marcadores (admin) ----------
  // Se ejecuta en la página de la tienda, en el navegador del admin: lee la ficha
  // y vuelve aquí con los datos. Sirve para tiendas que bloquean a los servidores (Amazon…).
  function bookmarklet() {
    const fn = function (O) {
      var q = function (s) { return document.querySelector(s); };
      var m = function (n) { var e = q('meta[property="' + n + '"],meta[name="' + n + '"]'); return e ? e.content || '' : ''; };
      var t = function (e) { return e ? e.textContent.trim() : ''; };
      var ld = {};
      document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
        try {
          var j = JSON.parse(s.textContent);
          [].concat(j['@graph'] || j).forEach(function (o) { if (o && [].concat(o['@type']).indexOf('Product') >= 0) ld = o; });
        } catch (e) { /* JSON-LD roto */ }
      });
      var of = [].concat(ld.offers || [])[0] || {};
      var li = q('#landingImage');
      var img = (li && (li.getAttribute('data-old-hires') || li.src)) || m('og:image') || [].concat(ld.image || [])[0] || '';
      if (img && img.url) img = img.url;
      var price = t(q('#corePrice_feature_div .a-offscreen')) || t(q('#corePriceDisplay_desktop_feature_div .a-price [aria-hidden=true]')) || t(q('.a-price .a-offscreen'))
        || (of.price || of.lowPrice ? (of.price || of.lowPrice) + ' ' + (of.priceCurrency === 'EUR' || !of.priceCurrency ? '€' : of.priceCurrency) : '')
        || (m('product:price:amount') ? m('product:price:amount') + ' €' : '');
      var d = {
        u: location.href.slice(0, 1500),
        t: (t(q('#productTitle')) || ld.name || m('og:title') || document.title || '').slice(0, 200),
        d: (m('og:description') || m('description') || (typeof ld.description === 'string' ? ld.description : '') || '').slice(0, 600),
        p: String(price).replace(/\s+/g, ' ').slice(0, 40),
        i: String(img || '').slice(0, 1500),
      };
      location.href = O + '/#/add=' + encodeURIComponent(JSON.stringify(d));
    };
    return `javascript:(${fn.toString().replace(/\s*\n\s*/g, ' ')})(${JSON.stringify(location.origin)})`;
  }

  // ---------- Configuración (admin) ----------
  async function renderConfig() {
    show(spinner());
    const [{ lists }, { blocked }] = await Promise.all([api('GET', '/api/lists'), api('GET', '/api/admin/blocked')]);
    const blockInput = h('input', { class: 'form-control', type: 'tel', inputmode: 'tel', maxlength: '20', required: true, placeholder: '600 000 000', 'aria-label': 'Número a bloquear' });
    const blockedCard = h('div', { class: 'card mt-4' }, h('div', { class: 'card-body' },
      h('h2', { class: 'h5' }, 'Números bloqueados'),
      h('p', { class: 'mb-3' }, 'Un número bloqueado no puede entrar en ninguna lista, y si estaba dentro se le cierra la sesión.'),
      h('form', {
        class: 'input-group mb-3',
        onsubmit: async (ev) => {
          ev.preventDefault();
          try { await api('POST', '/api/admin/blocked', { phone: blockInput.value }); notify('Número bloqueado.'); } catch (e) { return notify(e.message, 'danger'); }
          renderConfig();
        },
      }, blockInput, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Bloquear')),
      blocked.length
        ? h('div', { class: 'list-group' }, blocked.map((b) => h('div', { class: 'list-group-item d-flex justify-content-between align-items-center gap-2' },
          h('span', null, h('strong', null, b.phone), h('span', { class: 'small text-body-secondary' }, ` · desde ${fmtDate(b.at)}`)),
          h('button', {
            class: 'btn btn-sm btn-outline-secondary', type: 'button',
            onclick: async () => {
              try { await api('DELETE', `/api/admin/blocked/${encodeURIComponent(b.phone)}`); notify(`${b.phone} desbloqueado.`); } catch (e) { notify(e.message, 'danger'); }
              renderConfig();
            },
          }, 'Desbloquear'))))
        : h('p', { class: 'small text-body-secondary mb-0' }, 'No hay ningún número bloqueado.')));
    const card = (l) => {
      const name = h('input', { class: 'form-control', maxlength: '80', required: true, value: l.name, id: `n${l.id}` });
      const desc = h('input', { class: 'form-control', maxlength: '300', value: l.description, id: `d${l.id}` });
      const wl = h('textarea', { class: 'form-control font-monospace', rows: '5', id: `w${l.id}`, disabled: !l.whitelistEnabled });
      wl.value = l.whitelist.join('\n');
      const listed = h('input', { class: 'form-check-input', type: 'checkbox', role: 'switch', id: `p${l.id}`, checked: l.listed });
      const sw = h('input', { class: 'form-check-input', type: 'checkbox', role: 'switch', id: `s${l.id}`, checked: l.whitelistEnabled, onchange: () => { wl.disabled = !sw.checked; } });
      return h('div', { class: 'col' }, h('form', {
        class: 'card h-100',
        onsubmit: async (ev) => {
          ev.preventDefault();
          try {
            const r = await api('PUT', `/api/admin/lists/${l.id}`, { name: name.value, description: desc.value, whitelistEnabled: sw.checked, listed: listed.checked, whitelist: wl.value.split(/[\n,;]+/) });
            if (r.invalid.length) notify(`Guardado, pero estos números no son válidos y se han ignorado: ${r.invalid.join(', ')}`, 'warning');
            else notify(`«${name.value}» guardada.`);
            renderConfig();
          } catch (e) { notify(e.message, 'danger'); }
        },
      },
        h('div', { class: 'card-body' },
          h('div', { class: 'mb-3' }, h('label', { class: 'form-label', for: `n${l.id}` }, 'Nombre'), name),
          h('div', { class: 'mb-3' }, h('label', { class: 'form-label', for: `d${l.id}` }, 'Descripción'), desc),
          h('label', { class: 'form-label', for: `u${l.id}` }, 'Enlace para compartir solo esta lista'),
          h('div', { class: 'input-group mb-1' },
            h('input', { class: 'form-control', id: `u${l.id}`, readonly: true, value: shareUrl(l), onfocus: (ev) => ev.currentTarget.select() }),
            h('button', { class: 'btn btn-primary', type: 'button', onclick: () => shareList(l) }, 'Compartir')),
          h('div', { class: 'form-text mb-2' }, 'Quien entre con este enlace solo verá esta lista. ',
            h('button', {
              class: 'btn btn-link btn-sm p-0 align-baseline', type: 'button',
              onclick: async () => {
                if (!confirm('¿Cambiar el enlace? El anterior dejará de funcionar y quien entró con él perderá el acceso.')) return;
                try { await api('POST', `/api/admin/lists/${l.id}/share`); notify('Enlace nuevo creado. El anterior ya no funciona.'); } catch (e) { notify(e.message, 'danger'); }
                renderConfig();
              },
            }, 'Cambiar el enlace')),
          h('div', { class: 'form-check form-switch mb-1' }, listed, h('label', { class: 'form-check-label', for: `p${l.id}` }, 'Mostrar en la portada')),
          h('div', { class: 'form-text mb-3' }, 'Si lo apagas, la lista no aparece al entrar por la dirección general: solo se llega con su enlace.'),
          h('div', { class: 'form-check form-switch mb-2' }, sw, h('label', { class: 'form-check-label', for: `s${l.id}` }, 'Limitar esta lista por whitelist')),
          h('label', { class: 'form-label small', for: `w${l.id}` }, 'Móviles que pueden verla (uno por línea)'),
          wl,
          h('div', { class: 'form-text' }, 'Con la whitelist activada, solo estos números (y los admins) verán la lista. El resto ni sabrá que existe.')),
        h('div', { class: 'card-footer d-flex justify-content-between' },
          h('button', {
            class: 'btn btn-outline-danger btn-sm', type: 'button',
            onclick: async () => {
              if (!confirm(`¿Borrar la lista «${l.name}» con sus ${l.total} artículos y su registro de compras? No se puede deshacer.`)) return;
              try { await api('DELETE', `/api/admin/lists/${l.id}`); notify('Lista borrada.'); } catch (e) { notify(e.message, 'danger'); }
              renderConfig();
            },
          }, 'Borrar lista'),
          h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Guardar'))));
    };
    show(
      h('div', { class: 'd-flex flex-wrap align-items-center justify-content-between gap-2 mb-3' },
        h('h1', { class: 'h3 mb-0' }, 'Configuración'),
        h('div', { class: 'd-grid d-sm-block col-12 col-sm-auto' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: openListModal }, '+ Nueva lista'))),
      h('div', { class: 'row row-cols-1 row-cols-lg-2 g-3' }, lists.map(card)),
      blockedCard,
      h('div', { class: 'card mt-4' }, h('div', { class: 'card-body' },
        h('h2', { class: 'h5' }, 'Botón «Añadir a mi lista»'),
        h('p', { class: 'mb-2' }, 'Algunas tiendas (Amazon entre ellas) no dejan que un servidor lea sus fichas. Con este botón la ficha se captura desde tu propio navegador, así que funciona en cualquier tienda:'),
        h('ol', { class: 'mb-3' },
          h('li', null, 'Arrastra este botón a tu barra de marcadores (en el ordenador): ',
            h('a', { class: 'btn btn-sm btn-warning', href: bookmarklet(), onclick: (ev) => { ev.preventDefault(); notify('No se pulsa aquí: arrástralo a la barra de marcadores del navegador.', 'info'); } }, '🎁 Añadir a mi lista')),
          h('li', null, 'Abre el producto en la tienda y pulsa el marcador.'),
          h('li', null, 'Vuelves aquí con título, descripción, precio y foto ya rellenos: eliges la lista y guardas.')),
        h('p', { class: 'small text-body-secondary mb-0' }, 'Desde el móvil, usa «+ Añadir artículo» y pega el enlace; si la tienda no deja leer la ficha, rellena título y precio a mano.'))));
  }

  // ---------- Navegación ----------
  async function render() {
    if (!state.me) return renderLogin();
    chrome();
    const hash = location.hash.replace(/^#/, '') || '/';
    const collapse = bootstrap.Collapse.getInstance($('navMenu'));
    if (collapse) collapse.hide();
    const userMenu = bootstrap.Dropdown.getInstance($('navUser'));
    if (userMenu) userMenu.hide();
    try {
      let m;
      if (state.lock) {
        if (hash !== `/l/${state.lock}`) history.replaceState(null, '', `#/l/${state.lock}`);
        await renderList(state.lock);
      } else if ((m = hash.match(/^\/l\/(\d+)$/))) await renderList(Number(m[1]));
      else if (hash === '/registro' && state.me.admin) await renderRegistro();
      else if (hash === '/config' && state.me.admin) await renderConfig();
      else await renderLists();
    } catch (e) {
      if (state.me) show(h('div', { class: 'alert alert-danger' }, e.message, ' ', state.lock ? 'Pide un enlace nuevo a quien te lo envió.' : h('a', { href: '#/', class: 'alert-link' }, 'Volver a las listas')));
    }
  }
  async function start() {
    try { state.me = await api('GET', '/api/me'); } catch { state.me = null; }
    $('alerts').replaceChildren();
    state.lock = null;
    if (state.me && SHARE) {
      try {
        const r = await api('POST', '/api/share', { share: SHARE });
        if (state.me.admin) {
          if (!location.hash || location.hash === '#/' || location.hash === '#') history.replaceState(null, '', `#/l/${r.id}`);
        } else state.lock = r.id; // los invitados quedan fijados a la lista del enlace
      } catch (e) { if (state.me) notify(e.message, 'warning'); }
    } else if (state.me && state.me.scoped) {
      // Entró en su día por un enlace y vuelve por la dirección general: si solo tiene una lista, va directo a ella.
      try { const { lists } = await api('GET', '/api/lists'); if (lists.length === 1) state.lock = lists[0].id; } catch { /* se verá la portada */ }
    }
    render();
  }
  window.addEventListener('hashchange', () => { takeCapture(); $('alerts').replaceChildren(); render(); });
  $('logoutBtn').addEventListener('click', async () => {
    try { await api('POST', '/api/logout'); } catch { /* da igual: salimos */ }
    state.me = null;
    location.hash = '#/';
    renderLogin();
  });
  start();
})();

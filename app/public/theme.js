'use strict';
// Modo claro/oscuro. Se carga en <head> para aplicar el tema antes de pintar (sin parpadeo).
// 'auto' sigue al sistema; la elección manual se guarda solo en este navegador.
(function () {
  var KEY = 'theme';
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  function get() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; } catch (e) { return 'auto'; }
  }
  function apply() {
    var pref = get();
    var theme = pref === 'auto' ? (mq.matches ? 'dark' : 'light') : pref;
    document.documentElement.setAttribute('data-bs-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#071323' : '#f6eedf');
  }
  function set(pref) {
    try { pref === 'auto' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, pref); } catch (e) { /* almacenamiento bloqueado */ }
    apply();
  }
  if (mq.addEventListener) mq.addEventListener('change', apply);
  apply();
  window.appTheme = { get: get, set: set, next: function () { var o = ['auto', 'light', 'dark']; set(o[(o.indexOf(get()) + 1) % 3]); return get(); } };
})();

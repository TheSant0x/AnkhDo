// Ankh Do — options. The popup listens for the change and restyles live.
const $light = document.getElementById('light');
document.getElementById('emblem').innerHTML = `<svg viewBox="0 0 512 512">${GLYPHS.ankh}</svg>`;

// Firefox exposes `browser`; Chromium browsers expose `chrome`.
const ext = globalThis.browser ?? globalThis.chrome;
const hasStorage = !!ext?.storage?.local;
const show = light => {
  $light.checked = light;
  document.body.classList.toggle('light', light);
};

(async () => {
  let light = false;
  try {
    light = hasStorage ? !!(await ext.storage.local.get('lightTheme')).lightTheme
                       : localStorage.getItem('lightTheme') === 'true';
  } catch {}
  show(light);
})();

$light.addEventListener('change', () => {
  const light = $light.checked;
  show(light);
  try { if (hasStorage) ext.storage.local.set({ lightTheme: light }); } catch {}
  try { localStorage.setItem('lightTheme', String(light)); } catch {}
});

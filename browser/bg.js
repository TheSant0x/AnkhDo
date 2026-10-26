// Keeps the toolbar badge showing the number of open tasks, like the count
// beside the GNOME panel icon. Runs only on startup and when tasks change.

// Firefox exposes `browser`; Chromium browsers expose `chrome`.
const ext = globalThis.browser ?? globalThis.chrome;

async function updateBadge(tasks) {
  if (tasks === undefined) tasks = (await ext.storage.local.get('tasks')).tasks;
  const open = Array.isArray(tasks) ? tasks.filter(t => !t.done).length : 0;
  await ext.action.setBadgeText({ text: String(open) });
}

function init() {
  ext.action.setBadgeBackgroundColor({ color: '#E2B957' });
  ext.action.setBadgeTextColor?.({ color: '#121832' });
  updateBadge();
}

ext.runtime.onInstalled.addListener(init);
ext.runtime.onStartup.addListener(init);
ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.tasks) updateBadge(changes.tasks.newValue);
});

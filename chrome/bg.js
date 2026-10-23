// Keeps the toolbar badge showing the number of open tasks, like the count
// beside the GNOME panel icon. Runs only on startup and when tasks change.

async function updateBadge(tasks) {
  if (tasks === undefined) tasks = (await chrome.storage.local.get('tasks')).tasks;
  const open = Array.isArray(tasks) ? tasks.filter(t => !t.done).length : 0;
  await chrome.action.setBadgeText({ text: String(open) });
}

function init() {
  chrome.action.setBadgeBackgroundColor({ color: '#E2B957' });
  chrome.action.setBadgeTextColor?.({ color: '#121832' });
  updateBadge();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.tasks) updateBadge(changes.tasks.newValue);
});

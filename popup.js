const cb = document.getElementById('enabled');

chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
  cb.checked = enabled !== false;
});

cb.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: cb.checked });
});

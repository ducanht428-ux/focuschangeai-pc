// The only bridge between the page and the app's own disk. The renderer stays sandboxed and
// context-isolated: it gets three named calls, never require, never a path it can choose itself.
// The database file is userData/focuschange.db - the same ten-table file the Python camera leg
// writes - and main.js decides where that is, not the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fcDb', {
  // bytes: Uint8Array exported by sql.js. Resolves {ok, bytes, path} or rejects.
  save: (bytes) => ipcRenderer.invoke('fc-db-save', bytes),
  // Resolves the stored Uint8Array, or null when this machine has never written one.
  load: () => ipcRenderer.invoke('fc-db-load'),
  // Resolves the absolute file path, for the status line to print.
  path: () => ipcRenderer.invoke('fc-db-path'),
});
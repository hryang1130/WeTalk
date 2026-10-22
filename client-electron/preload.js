const { contextBridge, ipcRenderer } = require('electron');
const { MSG_IDS, ERROR_CODES } = require('./core/protocol');

contextBridge.exposeInMainWorld('wetalk', {
  MSG_IDS, ERROR_CODES,
  httpPost: (apiPath, body, baseUrl) => ipcRenderer.invoke('http:post', { path: apiPath, body, baseUrl }),
  tcpConnect: (opts) => ipcRenderer.invoke('tcp:connect', opts),
  tcpSend: (msgid, data) => ipcRenderer.invoke('tcp:send', { msgid, data }),
  tcpClose: () => ipcRenderer.invoke('tcp:close'),
  onFrame: (cb) => ipcRenderer.on('tcp:frame', (_e, frame) => cb(frame)),
  onClosed: (cb) => ipcRenderer.on('tcp:closed', (_e, info) => cb(info)),
  onError: (cb) => ipcRenderer.on('tcp:error', (_e, info) => cb(info)),
});

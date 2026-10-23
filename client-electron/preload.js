const { contextBridge, ipcRenderer } = require('electron');
const { MSG_IDS, RES_IDS, ERROR_CODES } = require('./core/protocol');
const { md5 } = require('./core/md5');

contextBridge.exposeInMainWorld('wetalk', {
  MSG_IDS, RES_IDS, ERROR_CODES,
  md5Hex: (bytes) => md5(bytes),
  httpPost: (apiPath, body, baseUrl) => ipcRenderer.invoke('http:post', { path: apiPath, body, baseUrl }),
  tcpConnect: (opts) => ipcRenderer.invoke('tcp:connect', opts),
  tcpSend: (msgid, data) => ipcRenderer.invoke('tcp:send', { msgid, data }),
  tcpClose: () => ipcRenderer.invoke('tcp:close'),
  resConnect: (host, port) => ipcRenderer.invoke('res:connect', { host, port }),
  resClose: () => ipcRenderer.invoke('res:close'),
  resUpload: (uid, msgid, name, dataB64) => ipcRenderer.invoke('res:upload', { uid, msgid, name, dataB64 }),
  resDownload: (uid, token, name) => ipcRenderer.invoke('res:download', { uid, token, name }),
  onFrame: (cb) => ipcRenderer.on('tcp:frame', (_e, frame) => cb(frame)),
  onClosed: (cb) => ipcRenderer.on('tcp:closed', (_e, info) => cb(info)),
  onError: (cb) => ipcRenderer.on('tcp:error', (_e, info) => cb(info)),
});

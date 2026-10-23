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
  // 聊天文件落盘：传 base64，弹系统另存为，返回保存路径（取消返回空串）
  saveFile: (name, dataB64) => ipcRenderer.invoke('file:save', { name, dataB64 }),
  refocus: () => ipcRenderer.invoke('win:refocus'),
  setSize: (width, height) => ipcRenderer.invoke('win:set-size', { width, height }),
  onFrame: (cb) => ipcRenderer.on('tcp:frame', (_e, frame) => cb(frame)),
  onClosed: (cb) => ipcRenderer.on('tcp:closed', (_e, info) => cb(info)),
  onError: (cb) => ipcRenderer.on('tcp:error', (_e, info) => cb(info)),
  // 断线自动重连进行中（attempt=第几次尝试，max=最多几次）。注意重连期间不会收到 onClosed，
  // 只有重连彻底失败（tcp:closed reason=reconnect-failed）或重连认证被拒才回登录页
  onReconnecting: (cb) => ipcRenderer.on('tcp:reconnecting', (_e, info) => cb(info)),
});

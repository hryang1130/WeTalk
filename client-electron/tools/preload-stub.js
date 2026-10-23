// 仅用于 tools/shot.js 的假 preload：把 window.wetalk 用桩函数填上，
// 让 renderer/index.html 能在不连服务端的情况下渲染出完整界面（用于看 UI / 截图）。
const { contextBridge } = require('electron');
const { MSG_IDS, RES_IDS, ERROR_CODES } = require('../core/protocol');

const noop = () => {};
const resolved = () => Promise.resolve({ error: 0 });

contextBridge.exposeInMainWorld('wetalk', {
  MSG_IDS, RES_IDS, ERROR_CODES,
  md5Hex: () => 'stub',
  httpPost: resolved,
  tcpConnect: resolved,
  tcpSend: noop,
  tcpClose: resolved,
  resConnect: resolved,
  resClose: resolved,
  resUpload: resolved,
  resDownload: resolved,
  refocus: resolved,
  setSize: resolved,
  onFrame: noop,
  onClosed: noop,
  onError: noop,
});

// Electron 主进程：持有 HTTP 与 TCP 长连接，渲染进程通过 IPC 调用。
// 服务端协议见 core/protocol.js 顶部注释；GateServer HTTP 端点见 server/GateServer/LogicSystem.cpp。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const net = require('net');
const { encodeFrame, decodeFrames, MSG_IDS } = require('./core/protocol');
const { ResClient } = require('./core/resClient');

let win = null;
let tcp = null;            // net.Socket (ChatServer)
let rxState = null;        // 拆包状态机
let heartbeatTimer = null;
let session = null;        // {uid, token, chathost, chatport}
let res = new ResClient((m) => console.log('[res]', m));  // ResourceServer 数据面连接

function createWindow() {
  win = new BrowserWindow({
    width: 1060, height: 700, minWidth: 900, minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 需要 require 本地模块(core/protocol.js)，Electron 20+ 默认 sandbox 会禁掉
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  // 渲染进程 console/报错转发到主进程 stdout，便于日志排查
  win.webContents.on('console-message', (_e, _level, message, line, sourceId) => {
    console.log('[renderer]', message, (sourceId || '').split(/[\\/]/).pop() + ':' + line);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function teardownTcp(reason) {
  stopHeartbeat();
  if (tcp) { try { tcp.destroy(); } catch (_) {} tcp = null; }
  rxState = null;
  session = null;
  // reconnect 是连接前的主动清理、logout 是用户主动退出，都不是"断线"，不通知渲染层
  if (reason !== 'reconnect' && reason !== 'logout') {
    sendToRenderer('tcp:closed', { reason });
  }
}

ipcMain.handle('http:post', async (_e, { path: apiPath, body, baseUrl }) => {
  const base = baseUrl || 'http://127.0.0.1:8080';
  try {
    const res = await fetch(base + apiPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return await res.json();
  } catch (err) {
    console.log('[http:post] FAIL', base + apiPath, err.message);
    return { error: -1, detail: `无法连接 ${base}：${err.message}` };
  }
});

ipcMain.handle('tcp:connect', (_e, { host, port, uid, token }) => {
  return new Promise((resolve, reject) => {
    teardownTcp('reconnect');
    const sock = net.createConnection({ host, port });
    rxState = { buf: Buffer.alloc(0) };
    let settled = false;

    sock.on('connect', () => {
      console.log('[tcp] connected', host + ':' + port);
      tcp = sock;
      session = { uid, token, chathost: host, chatport: port };
      // TCP 登录认证：服务端 MSG_CHAT_LOGIN(1005) 校验 {uid, token}
      sock.write(encodeFrame(MSG_IDS.MSG_CHAT_LOGIN, { uid, token }));
      console.log('[tcp] sent MSG_CHAT_LOGIN');
      // 心跳：服务端 ID_HEART_BEAT_REQ(1023) -> 1024
      heartbeatTimer = setInterval(() => {
        if (tcp) tcp.write(encodeFrame(MSG_IDS.ID_HEART_BEAT_REQ, {}));
      }, 30000);
      settled = true;
      resolve(true);
    });

    sock.on('data', (chunk) => {
      console.log('[tcp] recv', chunk.length, 'bytes');
      const frames = decodeFrames(rxState, chunk, (err) => {
        sendToRenderer('tcp:error', { message: err.message });
      });
      for (const f of frames) sendToRenderer('tcp:frame', f);
    });

    sock.on('error', (err) => {
      if (!settled) { settled = true; reject(new Error(err.message)); }
      else teardownTcp('network-error: ' + err.message);
    });

    sock.on('close', () => { if (settled) teardownTcp('closed'); });
    sock.setTimeout(10000, () => { if (!settled) { sock.destroy(); reject(new Error('connect timeout')); } });
  });
});

ipcMain.handle('tcp:send', (_e, { msgid, data }) => {
  if (!tcp) throw new Error('not connected');
  tcp.write(encodeFrame(msgid, data));
  return true;
});

ipcMain.handle('tcp:close', () => { teardownTcp('logout'); return true; });
ipcMain.handle('session:get', () => session);

/* ---------- ResourceServer 数据面 ---------- */
ipcMain.handle('res:connect', (_e, { host, port }) => res.connect(host, port));
ipcMain.handle('res:close', () => { res.close(); return true; });
// dataB64: 文件内容 base64（renderer 读 File 后转码传过来）
ipcMain.handle('res:upload', (_e, { uid, msgid, name, dataB64 }) =>
  res.upload(uid, msgid, name, Buffer.from(dataB64, 'base64')));
ipcMain.handle('res:download', async (_e, { uid, token, name }) => {
  const r = await res.download(uid, token, name);
  return { name: r.name, dataB64: r.buffer.toString('base64') };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { teardownTcp('app-quit'); app.quit(); });

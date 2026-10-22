// 本地演示服务：模拟 GateServer HTTP + ChatServer TCP 协议，
// 让客户端在没有 Docker/真实服务端时也能跑通 登录→好友→单聊 的完整 UI 流程。
// 用法: node mock-server.js   （登录页随便填邮箱密码即可登录；给好友发消息会收到自动回复）
const http = require('http');
const net = require('net');
const { encodeFrame, decodeFrames, MSG_IDS } = require('./core/protocol');

const FRIENDS = [
  { uid: 1001, name: 'xiaoming', nick: '小明', desc: 'C++ 后端开发', icon: '1', sex: '1' },
  { uid: 1002, name: 'xiaohong', nick: '小红', desc: 'Go 开发', icon: '2', sex: '2' },
];

/* ---------- HTTP: GateServer :8080 ---------- */
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    console.log('[HTTP]', req.method, req.url, body);
    const json = (o) => { res.setHeader('Content-Type', 'text/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/get_varifycode') return json({ error: 0, email: JSON.parse(body).email, name: 'demo' });
    if (req.url === '/user_register') return json({ error: 0, uid: 6666, email: JSON.parse(body).email });
    if (req.url === '/user_login') return json({
      error: 0, uid: 6666, token: 'demo-token',
      chathost: '127.0.0.1', chatport: 8090, reshost: '127.0.0.1', resport: 9090,
    });
    json({ error: 1001 });
  });
}).listen(8080, () => console.log('mock GateServer on :8080'));

/* ---------- TCP: ChatServer :8090 ---------- */
const rxBySocket = new WeakMap();
net.createServer((sock) => {
  const rx = { buf: Buffer.alloc(0) };
  rxBySocket.set(sock, rx);
  let selfUid = 0;
  console.log('[TCP] client connected');

  const send = (msgid, obj) => sock.write(encodeFrame(msgid, obj));

  sock.on('data', (chunk) => {
    for (const { msgid, obj } of decodeFrames(rx, chunk)) {
      console.log('[TCP] <-', msgid, JSON.stringify(obj).slice(0, 120));
      switch (msgid) {
        case MSG_IDS.MSG_CHAT_LOGIN:
          selfUid = obj.uid;
          send(MSG_IDS.MSG_CHAT_LOGIN_RSP, {
            error: 0, uid: selfUid, pwd: '', name: 'demo', email: 'demo@wetalk.local',
            nick: '演示用户', desc: '', sex: '1', icon: '1', token: obj.token,
            apply_list: [], friend_list: FRIENDS,
          });
          break;
        case MSG_IDS.ID_HEART_BEAT_REQ:
          send(MSG_IDS.ID_HEARTBEAT_RSP, {});
          break;
        case MSG_IDS.ID_SEARCH_USER_REQ: {
          const hit = FRIENDS.find((f) => f.name === obj.uid || String(f.uid) === obj.uid);
          if (hit) send(MSG_IDS.ID_SEARCH_USER_RSP, { error: 0, ...hit, back: '' });
          else send(MSG_IDS.ID_SEARCH_USER_RSP, { error: 1011 });
          break;
        }
        case MSG_IDS.ID_ADD_FRIEND_REQ:
          send(MSG_IDS.ID_ADD_FRIEND_RSP, { error: 0 });
          send(MSG_IDS.ID_NOTIFY_AUTH_FRIEND_REQ, {
            error: 0, fromuid: obj.touid, touid: obj.uid, name: 'xiaoming', nick: '小明',
          });
          break;
        case MSG_IDS.ID_TEXT_CHAT_MSG_REQ: {
          // 1) 送达回执（回执里带服务端分配的 thread_id）
          const chat_datas = (obj.text_array || []).map((t) => ({
            message_id: Math.floor(Math.random() * 100000),
            unique_id: t.unique_id, content: t.content, status: 2,
            chat_time: String(Math.floor(Date.now() / 1000)),
          }));
          const thread_id = obj.thread_id || 8888;
          send(MSG_IDS.ID_TEXT_CHAT_MSG_RSP, {
            error: 0, fromuid: obj.fromuid, touid: obj.touid, thread_id, chat_datas,
          });
          // 2) 1 秒后模拟对方自动回复（1019 推送）
          setTimeout(() => {
            send(MSG_IDS.ID_NOTIFY_TEXT_CHAT_MSG_REQ, {
              error: 0, fromuid: obj.touid, touid: obj.fromuid, thread_id,
              chat_datas: [{
                message_id: Math.floor(Math.random() * 100000),
                unique_id: require('crypto').randomUUID(),
                content: '（演示模式）收到啦！服务端是 mock-server，真实服务端见 DEPLOY.md',
                status: 2, chat_time: String(Math.floor(Date.now() / 1000)),
              }],
            });
          }, 1000);
          break;
        }
      }
    }
  });
  sock.on('close', () => console.log('[TCP] client closed'));
}).listen(8090, () => console.log('mock ChatServer on :8090'));

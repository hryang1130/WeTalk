// 本地演示服务：模拟 GateServer HTTP + ChatServer TCP + ResourceServer TCP，
// 让客户端在没有 Docker/真实服务端时也能跑通 登录→好友→单聊→历史→图片 的完整 UI 流程。
// 用法: node mock-server.js   （登录页随便填邮箱密码即可登录；给好友发消息会收到自动回复）
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { encodeFrame, decodeFrames, MSG_IDS, RES_IDS } = require('./core/protocol');

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
// 一张 90x90 的演示 PNG（历史消息里的图片）
const DEMO_IMG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAFoAAABaCAYAAAAdEUnkAAAAmklEQVR4nO3PMQHAIBDAsAO4' +
  'gFu4gVs4cODAgQMHDhw4cODAgQMHnm9wd7Pv7uzM/z8YMHTo0KFDhw4dOnTo0KFDhw4dOnTo' +
  '0KFDhw4dOnTo0KFDhw4dOnTo0KFDhw4dOnTo0KFDhw4dOnTo0KFDhw4dOnTo0KFDhw4dOnTo' +
  '0KFDhw4dOnTo0KHj5TuH0Q0Kl3xIHgAAAABJRU5ErkJggg==', 'base64');

net.createServer((sock) => {
  const rx = { buf: Buffer.alloc(0) };
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
        case MSG_IDS.ID_LOAD_CHAT_MSG_REQ: {
          // 演示假历史：第一页（message_id=0）给一条文本 + 一条图片，之后无更多
          const first = obj.message_id === 0;
          send(MSG_IDS.ID_LOAD_CHAT_MSG_RSP, {
            error: 0, thread_id: obj.thread_id,
            last_message_id: first ? 2 : 0, load_more: false,
            chat_datas: first ? [
              { sender: 1001, msg_id: 2, thread_id: obj.thread_id, unique_id: 'demo-img',
                msg_content: 'demo-history.png', chat_time: String(Math.floor(Date.now() / 1000) - 600), status: 0 },
              { sender: 1001, msg_id: 1, thread_id: obj.thread_id, unique_id: 'demo-txt',
                msg_content: '你好，这是历史消息（演示数据）', chat_time: String(Math.floor(Date.now() / 1000) - 700), status: 0 },
            ] : [],
          });
          break;
        }
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
                unique_id: crypto.randomUUID(),
                content: '（演示模式）收到啦！服务端是 mock-server，真实服务端见 DEPLOY.md',
                status: 2, chat_time: String(Math.floor(Date.now() / 1000)),
              }],
            });
          }, 1000);
          break;
        }
        case MSG_IDS.ID_IMG_CHAT_MSG_REQ:
          send(MSG_IDS.ID_IMG_CHAT_MSG_RSP, {
            error: 0, fromuid: obj.fromuid, touid: obj.touid,
            thread_id: obj.thread_id || 8889, md5: obj.md5, unique_name: obj.name,
            unique_id: obj.unique_id, chat_time: obj.chat_time, status: 3,
          });
          break;
      }
    }
  });
  sock.on('close', () => console.log('[TCP] client closed'));
}).listen(8090, () => console.log('mock ChatServer on :8090'));

/* ---------- TCP: ResourceServer :9090（文件/图片分片上传下载，data=base64） ---------- */
const fileStore = new Map(); // name -> Buffer
net.createServer((sock) => {
  const rx = { buf: Buffer.alloc(0) };
  console.log('[RES] client connected');
  const send = (msgid, obj) => sock.write(encodeFrame(msgid, obj));
  sock.on('data', (chunk) => {
    for (const { msgid, obj } of decodeFrames(rx, chunk)) {
      if (msgid === RES_IDS.ID_IMG_CHAT_UPLOAD_REQ || msgid === RES_IDS.ID_UPLOAD_FILE_REQ) {
        const part = Buffer.from(obj.data, 'base64');
        const prev = fileStore.get(obj.name) || Buffer.alloc(0);
        fileStore.set(obj.name, Buffer.concat([prev, part]));
        console.log('[RES] upload', obj.name, 'seq', obj.seq, 'last', obj.last);
        send(msgid + 1, { error: 0, md5: obj.md5, seq: obj.seq, name: obj.name,
          total_size: String(obj.total_size), trans_size: obj.trans_size, last: obj.last, uid: obj.uid });
      } else if (msgid === RES_IDS.ID_DOWN_LOAD_FILE_REQ) {
        const buf = fileStore.get(obj.name) || DEMO_IMG; // demo-history.png 直接给演示图
        const off = (obj.seq - 1) * 32 * 1024;
        const slice = buf.slice(off, off + 32 * 1024);
        const last = off + slice.length >= buf.length ? 1 : 0;
        console.log('[RES] download', obj.name, 'seq', obj.seq, 'last', last);
        send(RES_IDS.ID_DOWN_LOAD_FILE_RSP, { error: 0, seq: obj.seq, name: obj.name,
          data: slice.toString('base64'), total_size: String(buf.length), last });
      }
    }
  });
  sock.on('close', () => console.log('[RES] client closed'));
}).listen(9090, () => console.log('mock ResourceServer on :9090'));
// 端到端验证脚本：HTTP 登录 -> TCP 认证 -> 表情文本消息(1017) -> 图片上传(1037)+图片消息(1035)
//                  -> 历史拉取(1029) 验证表情/图片落库 -> 图片下载回读比对。
// 仅用于联调验证，不进打包。用法：node test-e2e.js [email] [passwd]
const net = require('net');
const { encodeFrame, decodeFrames, MSG_IDS } = require('./core/protocol');
const { ResClient } = require('./core/resClient');
const { md5 } = require('./core/md5');

const GATE = 'http://127.0.0.1:8080';
const EMAIL = process.argv[2] || 'hao@wetalk.com';
const PASSWD = process.argv[3] || '123456';
const PEER = Number(process.argv[4] || 1099); // 对方 uid（xm=1099）

const log = (...a) => console.log('[e2e]', ...a);
const fail = (m) => { console.error('[e2e][FAIL]', m); process.exit(1); };

// 1x1 红色像素 PNG
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080200000090775' +
  '3de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082', 'hex');

function tcpSession(host, port) {
  const sock = net.createConnection({ host, port });
  const rx = { buf: Buffer.alloc(0) };
  const waiters = [];
  sock.on('data', (c) => {
    for (const f of decodeFrames(rx, c)) {
      const i = waiters.findIndex((w) => w.msgid === f.msgid);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(f.obj);
      else log('(unhandled msgid ' + f.msgid + ')');
    }
  });
  const wait = (msgid, ms = 8000) => new Promise((res, rej) => {
    waiters.push({ msgid, resolve: res });
    setTimeout(() => {
      const i = waiters.findIndex((w) => w.msgid === msgid);
      if (i >= 0) { waiters.splice(i, 1); rej(new Error('timeout waiting msgid ' + msgid)); }
    }, ms);
  });
  const send = (msgid, obj) => sock.write(encodeFrame(msgid, obj));
  return { sock, wait, send };
}

(async () => {
  // 1. HTTP 登录
  const hr = await fetch(GATE + '/user_login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, passwd: PASSWD }),
  });
  const r = await hr.json();
  if (r.error !== 0) fail('HTTP login failed: ' + JSON.stringify(r));
  log('HTTP login ok uid=' + r.uid, 'chat=' + r.chathost + ':' + r.chatport, 'res=' + r.reshost + ':' + r.resport);

  // 2. TCP 认证
  const s = tcpSession(r.chathost, Number(r.chatport));
  await new Promise((res, rej) => { s.sock.on('connect', res); s.sock.on('error', rej); });
  s.send(MSG_IDS.MSG_CHAT_LOGIN, { uid: r.uid, token: r.token });
  const lr = await s.wait(MSG_IDS.MSG_CHAT_LOGIN_RSP);
  if (lr.error !== 0) fail('TCP auth failed: ' + JSON.stringify(lr));
  log('TCP auth ok, friends=', (lr.friend_list || []).length);

  // 3. 表情文本消息（thread_id=0 触发服务端自动建线程）
  const emojiText = '你好 😀🎉 中文emoji混合 test';
  s.send(MSG_IDS.ID_TEXT_CHAT_MSG_REQ, {
    fromuid: r.uid, touid: PEER, thread_id: 0,
    text_array: [{ content: emojiText, unique_id: 'e2e-emoji-1' }],
  });
  const tr = await s.wait(MSG_IDS.ID_TEXT_CHAT_MSG_RSP);
  if (tr.error !== 0) fail('text msg failed: ' + JSON.stringify(tr));
  const threadId = tr.thread_id;
  const savedText = tr.chat_datas && tr.chat_datas[0];
  log('text RSP thread_id=' + threadId, 'message_id=' + (savedText && savedText.message_id));
  if (!threadId) fail('thread_id not resolved (expected >0)');
  if (!savedText || savedText.content !== emojiText) fail('emoji content mismatch: ' + JSON.stringify(savedText));

  // 4. 图片上传到 ResourceServer
  const res = new ResClient((m) => log('[res]', m));
  await res.connect(r.reshost, Number(r.resport) || 9090);
  const name = md5(PNG) + '.png';
  await res.upload(r.uid, 1037, name, PNG);
  log('image uploaded:', name, PNG.length + 'B');

  // 5. 图片消息(1035)入库
  s.send(1035, {
    fromuid: r.uid, touid: PEER, thread_id: threadId,
    md5: md5(PNG), name, token: r.token,
    unique_id: 'e2e-img-1', chat_time: new Date().toISOString().slice(0, 19).replace('T', ' '),
    status: 0,
  });
  const ir = await s.wait(1036, 10000);
  if (ir.error !== 0) fail('image msg failed: ' + JSON.stringify(ir));
  log('image msg ok thread_id=' + ir.thread_id, 'unique_name=' + ir.unique_name);

  // 6. 历史拉取验证落库
  s.send(MSG_IDS.ID_LOAD_CHAT_MSG_REQ, { thread_id: threadId, message_id: 0 });
  const h = await s.wait(MSG_IDS.ID_LOAD_CHAT_MSG_RSP);
  if (h.error !== 0) fail('history failed: ' + JSON.stringify(h));
  const rows = h.chat_datas || [];
  log('history rows=' + rows.length);
  const hasEmoji = rows.some((x) => x.msg_content === emojiText);
  const hasImg = rows.some((x) => x.msg_content === name);
  if (!hasEmoji) fail('emoji message missing from history: ' + JSON.stringify(rows));
  if (!hasImg) fail('image message missing from history: ' + JSON.stringify(rows));
  log('history contains emoji text and image message: OK');

  // 7. 图片下载回读比对
  const dl = await res.download(r.uid, r.token, name);
  if (!dl.buffer.equals(PNG)) fail('downloaded image bytes mismatch (' + dl.buffer.length + 'B vs ' + PNG.length + 'B)');
  log('image roundtrip bytes identical: OK');

  // 8. 已读上报(1046)验证（只上报，不做删除好友测试以免破坏测试数据）
  s.send(1046, { uid: r.uid, touid: PEER, thread_id: threadId, last_message_id: savedText.message_id });
  const rr = await s.wait(1047);
  if (rr.error !== 0) fail('read report failed: ' + JSON.stringify(rr));
  log('read report ok (last_message_id=' + rr.last_message_id + ')');

  res.close(); s.sock.destroy();
  console.log('\n[e2e] ALL PASS ✅  (emoji text, image upload/store/history/download)');
  process.exit(0);
})().catch((e) => fail(e.stack || e.message));

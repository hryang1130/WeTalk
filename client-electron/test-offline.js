// 离线消息场景复现：B 不在线时 A 发消息 → B 重新登录 → B 能否拉到这条消息？
// 对应用户反馈："在 B 用户不登录的情况下 A 给他发了一个消息，B 登录之后收不到"
// 用法：node test-offline.js [A_email] [B_email] [passwd]
const net = require('net');
const { encodeFrame, decodeFrames, MSG_IDS } = require('./core/protocol');

const GATE = 'http://127.0.0.1:8080';
const EMAIL_A = process.argv[2] || 'xm@wetalk.com';
const EMAIL_B = process.argv[3] || 'hao@wetalk.com';
const PASSWD = process.argv[4] || '123456';

const log = (...a) => console.log('[offline]', ...a);
const fail = (m) => { console.error('[offline][FAIL]', m); process.exit(1); };

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

async function login(email) {
  const hr = await fetch(GATE + '/user_login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, passwd: PASSWD }),
  });
  const r = await hr.json();
  if (r.error !== 0) fail('login failed for ' + email + ': ' + JSON.stringify(r));
  return r;
}

async function auth(r) {
  const s = tcpSession(r.chathost, Number(r.chatport));
  await new Promise((res, rej) => { s.sock.on('connect', res); s.sock.on('error', rej); });
  s.send(MSG_IDS.MSG_CHAT_LOGIN, { uid: r.uid, token: r.token });
  const lr = await s.wait(MSG_IDS.MSG_CHAT_LOGIN_RSP);
  if (lr.error !== 0) fail('TCP auth failed: ' + JSON.stringify(lr));
  return { s, lr };
}

(async () => {
  const a = await login(EMAIL_A);
  const b = await login(EMAIL_B);
  log(`A=${EMAIL_A} uid=${a.uid}  B=${EMAIL_B} uid=${b.uid}`);

  // 1. A 登录并发消息（B 全程不连 TCP = 离线）
  const { s: sa } = await auth(a);
  const content = '离线消息测试 ' + Date.now();
  sa.send(MSG_IDS.ID_TEXT_CHAT_MSG_REQ, {
    fromuid: a.uid, touid: b.uid, thread_id: 0,
    text_array: [{ content, unique_id: 'offline-' + Date.now() }],
  });
  const tr = await sa.wait(MSG_IDS.ID_TEXT_CHAT_MSG_RSP);
  if (tr.error !== 0) fail('A 发消息失败: ' + JSON.stringify(tr));
  const threadId = tr.thread_id;
  log(`A 发送成功 thread_id=${threadId} message_id=${tr.chat_datas?.[0]?.message_id}`);
  sa.sock.destroy(); // A 下线

  // 2. B 登录（此刻 B 才第一次连 TCP），模拟客户端：不点开会话前的"登录后拉历史"
  await new Promise((r) => setTimeout(r, 500)); // 等 A 的会话清理完成
  const { s: sb, lr } = await auth(b);
  // 登录响应应带 unread_list：B 离线期间 A 发的消息要变成可见的未读数
  const unreadEntry = (lr.unread_list || []).find((u) => Number(u.uid) === Number(a.uid));
  if (!unreadEntry || Number(unreadEntry.count) < 1) {
    fail(`登录响应缺 unread_list（应含 A 的未读数）: ${JSON.stringify(lr.unread_list || null)}`);
  }
  log(`登录响应带未读汇总: A(uid=${a.uid}) 未读 ${unreadEntry.count} 条 ✓`);

  sb.send(MSG_IDS.ID_LOAD_CHAT_MSG_REQ, { thread_id: 0, touid: a.uid, message_id: 0 });
  const h = await sb.wait(MSG_IDS.ID_LOAD_CHAT_MSG_RSP);
  if (h.error !== 0) fail('B 拉历史失败: ' + JSON.stringify(h));
  log(`B 拉到历史 thread_id=${h.thread_id} rows=${(h.chat_datas || []).length}`);

  const hit = (h.chat_datas || []).find((x) => x.msg_content === content);
  if (!hit) fail(`B 的历史里没有这条离线消息！(${content})`);
  log('B 的历史里找到了离线消息 ✓  sender=' + hit.sender + ' status=' + hit.status);

  // 3. 关键 UX 检查：这条消息对 B 来说应该还是未读（status=0）
  if (Number(hit.status) !== 0) {
    log(`注意：status=${hit.status}（0=未读 2=已读）—— 未读数没有按预期保留`);
  } else {
    log('消息保持未读状态（status=0）✓ —— 登录时应显示为未读数');
  }

  sb.sock.destroy();
  log('ALL PASS ✅');
  process.exit(0);
})().catch((e) => fail(e.stack || e.message));

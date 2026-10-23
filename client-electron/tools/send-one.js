// 工具：以指定账号登录并发一条文本给目标 uid（验证 GUI 端实时收信用）
// 用法：node tools/send-one.js <from_email> <to_uid> <text>
const net = require('net');
const path = require('path');
const { encodeFrame, decodeFrames, MSG_IDS } = require(path.join(__dirname, '..', 'core', 'protocol'));

const [,, EMAIL, TO, TEXT] = process.argv;
const GATE = 'http://127.0.0.1:8080';

(async () => {
  const hr = await fetch(GATE + '/user_login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, passwd: '123456' }),
  });
  const r = await hr.json();
  if (r.error !== 0) throw new Error('login failed: ' + JSON.stringify(r));
  const sock = net.createConnection({ host: r.chathost, port: Number(r.chatport) });
  await new Promise((res, rej) => { sock.on('connect', res); sock.on('error', rej); });
  const rx = { buf: Buffer.alloc(0) };
  const waiters = [];
  sock.on('data', (c) => {
    for (const f of decodeFrames(rx, c)) {
      const i = waiters.findIndex((w) => w.msgid === f.msgid);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(f.obj);
    }
  });
  const wait = (msgid, ms = 8000) => new Promise((res, rej) => {
    waiters.push({ msgid, resolve: res });
    setTimeout(() => rej(new Error('timeout ' + msgid)), ms);
  });
  sock.write(encodeFrame(MSG_IDS.MSG_CHAT_LOGIN, { uid: r.uid, token: r.token }));
  await wait(MSG_IDS.MSG_CHAT_LOGIN_RSP);
  sock.write(encodeFrame(MSG_IDS.ID_TEXT_CHAT_MSG_REQ, {
    fromuid: r.uid, touid: Number(TO), thread_id: 0,
    text_array: [{ content: TEXT, unique_id: 'sendone-' + Date.now() }],
  }));
  const tr = await wait(MSG_IDS.ID_TEXT_CHAT_MSG_RSP);
  console.log('[send-one] sent, error=' + tr.error + ' message_id=' + tr.chat_datas?.[0]?.message_id);
  sock.destroy();
  process.exit(tr.error === 0 ? 0 : 1);
})().catch((e) => { console.error('[send-one] FAIL', e.message); process.exit(1); });

// 文件消息端到端验证：
//   A 选择文件 -> 1003 分片上传到 ResourceServer -> 1035(带 fname/fsize) 通知 ChatServer 落库
//   -> B 拉历史应看到 content 为 JSON {n:存储名, f:原始文件名, s:大小}
//   -> B 用 1033 分片下载应拿回与上传一致的字节（md5 相同）
// 用法：node test-file.js [A_email] [B_email] [passwd]
const net = require('net');
const crypto = require('crypto');
const { encodeFrame, decodeFrames, MSG_IDS } = require('./core/protocol');
const { ResClient } = require('./core/resClient');

const GATE = 'http://127.0.0.1:8080';
const EMAIL_A = process.argv[2] || 'xm@wetalk.com';
const EMAIL_B = process.argv[3] || 'hao@wetalk.com';
const PASSWD = process.argv[4] || '123456';

const log = (...a) => console.log('[file]', ...a);
const fail = (m) => { console.error('[file][FAIL]', m); process.exit(1); };

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

  // 1. A 上传一个伪随机文件到 ResourceServer（1003 一般文件分片上传）
  const resA = new ResClient((m) => log('[resA]', m));
  await resA.connect(a.reshost, Number(a.resport) || 9090);
  const payload = crypto.randomBytes(80 * 1024 + 123); // 跨多个 32KB 分片
  const md5hex = crypto.createHash('md5').update(payload).digest('hex');
  const fname = '报告-' + Date.now() + '.pdf';
  const ext = '.pdf';
  const storeName = md5hex + ext;
  await resA.upload(a.uid, 1003 /* ID_UPLOAD_FILE_REQ */, storeName, payload);
  log('文件已上传 ResourceServer: ' + storeName + ' (' + payload.length + ' bytes)');

  // 2. A 发 1035（带 fname/fsize），ChatServer 落库
  const { s: sa } = await auth(a);
  const unique_id = 'file-' + Date.now();
  sa.send(MSG_IDS.ID_IMG_CHAT_MSG_REQ, {
    fromuid: a.uid, touid: b.uid, thread_id: 0,
    md5: md5hex, name: storeName, token: a.token,
    fname, fsize: payload.length,
    unique_id, chat_time: String(Math.floor(Date.now() / 1000)), status: 3,
  });
  const ir = await sa.wait(MSG_IDS.ID_IMG_CHAT_MSG_RSP);
  if (ir.error !== 0) fail('1035 落库失败: ' + JSON.stringify(ir));
  log(`1035 成功 thread_id=${ir.thread_id} message_id=${ir.message_id}`);
  sa.sock.destroy();

  // 3. B 拉历史：应看到 content = JSON {n,f,s}，且 f 是原始文件名
  await new Promise((r) => setTimeout(r, 500));
  const { s: sb } = await auth(b);
  sb.send(MSG_IDS.ID_LOAD_CHAT_MSG_REQ, { thread_id: 0, touid: a.uid, message_id: 0 });
  const h = await sb.wait(MSG_IDS.ID_LOAD_CHAT_MSG_RSP);
  if (h.error !== 0) fail('B 拉历史失败: ' + JSON.stringify(h));
  const hit = (h.chat_datas || []).find((x) => {
    if (typeof x.msg_content !== 'string' || !x.msg_content.startsWith('{')) return false;
    try { return JSON.parse(x.msg_content).n === storeName; } catch (_) { return false; }
  });
  if (!hit) fail('B 的历史里没有这条文件消息 (storeName=' + storeName + ')');
  let meta = null;
  try { meta = JSON.parse(hit.msg_content); } catch (_) { fail('content 不是合法 JSON: ' + hit.msg_content); }
  if (meta.f !== fname) fail(`原始文件名不匹配: 期望 ${fname} 实际 ${meta.f}`);
  if (Number(meta.s) !== payload.length) fail(`文件大小不匹配: 期望 ${payload.length} 实际 ${meta.s}`);
  log(`历史消息校验通过 ✓ content={n:${meta.n.slice(0, 12)}…, f:${meta.f}, s:${meta.s}}}`);

  // 4. B 分片下载并校验 md5 一致
  const resB = new ResClient((m) => log('[resB]', m));
  await resB.connect(b.reshost, Number(b.resport) || 9090);
  const dl = await resB.download(b.uid, b.token, storeName);
  const dlMd5 = crypto.createHash('md5').update(dl.buffer).digest('hex');
  if (dlMd5 !== md5hex) fail(`下载内容 md5 不一致: 上传 ${md5hex} 下载 ${dlMd5}`);
  if (dl.buffer.length !== payload.length) fail(`下载大小不一致: ${dl.buffer.length} vs ${payload.length}`);
  log(`B 下载校验通过 ✓ ${dl.buffer.length} bytes md5 一致`);
  sb.sock.destroy();
  log('ALL PASS ✅');
  process.exit(0);
})().catch((e) => fail(e.stack || e.message));

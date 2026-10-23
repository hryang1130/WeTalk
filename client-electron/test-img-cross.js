// 跨用户图片全链路验证（复刻真实使用场景）：
//   A 上传图片 -> A 发 1035 -> B 在线收到 1039 通知 -> B 用 1033 下载 -> 字节比对
//   -> B 上报已读 1046 -> A 收到 1048 已读通知
// 覆盖过的问题：图片只落库不推送（用户"收不到图片"）、下载按请求方 uid 拼路径（对端只显示文件名）。
// 用法：node test-img-cross.js [A_email] [B_email] [passwd]
const net = require('net');
const { encodeFrame, decodeFrames, MSG_IDS } = require('./core/protocol');
const { ResClient } = require('./core/resClient');
const { md5 } = require('./core/md5');

const GATE = 'http://127.0.0.1:8080';
const EMAIL_A = process.argv[2] || 'xm@wetalk.com';
const EMAIL_B = process.argv[3] || 'hao@wetalk.com';
const PASSWD = process.argv[4] || '123456';

const log = (...a) => console.log('[cross]', ...a);
const fail = (m) => { console.error('[cross][FAIL]', m); process.exit(1); };

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
  return s;
}

(async () => {
  const a = await login(EMAIL_A);
  const b = await login(EMAIL_B);
  if (a.uid === b.uid) fail('A/B 是同一账号');
  log(`A=${EMAIL_A} uid=${a.uid}  B=${EMAIL_B} uid=${b.uid}`);

  const sa = await auth(a);
  const sb = await auth(b);
  log('两端 TCP 认证完成');

  // A 上传一张图
  const name = md5(PNG) + '.png';
  const resA = new ResClient((m) => log('[A-res]', m));
  await resA.connect(a.reshost, Number(a.resport) || 9090);
  await resA.upload(a.uid, 1037, name, PNG);
  log('A 上传完成 name=' + name);

  // A 发图片消息（thread_id=0 让服务端建线程）
  const uniqueId = 'cross-img-' + Date.now();
  const notifyWait = sb.wait(MSG_IDS.ID_NOTIFY_IMG_CHAT_MSG_REQ, 10000); // 先挂上等 1039
  sa.send(MSG_IDS.ID_IMG_CHAT_MSG_REQ, {
    fromuid: a.uid, touid: b.uid, thread_id: 0,
    md5: md5(PNG), name, token: a.token,
    unique_id: uniqueId, chat_time: Math.floor(Date.now() / 1000), status: 3,
  });
  const ir = await sa.wait(MSG_IDS.ID_IMG_CHAT_MSG_RSP, 10000);
  if (ir.error !== 0) fail('1035 失败: ' + JSON.stringify(ir));
  const threadId = ir.thread_id;
  log('A 收到 1036: thread_id=' + threadId + ' message_id=' + ir.message_id);
  if (!threadId) fail('thread_id 没有回填');

  // B 应该在线收到 1039
  const n = await notifyWait;
  const cd = (n.chat_datas || [])[0];
  if (!cd) fail('1039 没有 chat_datas: ' + JSON.stringify(n));
  if (cd.content !== name) fail('1039 的图片名不对: ' + cd.content);
  if (!cd.message_id) fail('1039 缺 message_id（已读会失效）');
  log('B 在线收到 1039: content=' + cd.content + ' message_id=' + cd.message_id);

  // B 下载（这一步过去必然 FileNotExists）
  const resB = new ResClient((m) => log('[B-res]', m));
  await resB.connect(b.reshost, Number(b.resport) || 9090);
  let dl;
  try { dl = await resB.download(b.uid, b.token, name); }
  catch (e) { fail('B 下载失败（就是"只显示文件名"的根因）: ' + e.message); }
  if (!dl.buffer.equals(PNG)) fail(`B 下载字节不一致: ${dl.buffer.length}B vs ${PNG.length}B`);
  log('B 下载字节一致 (' + PNG.length + ' bytes) —— 缩略图可正常渲染');

  // B 上报已读，A 应收到 1048
  const readWait = sa.wait(MSG_IDS.ID_NOTIFY_READ_MSG_REQ, 8000);
  sb.send(MSG_IDS.ID_READ_MSG_REQ, { uid: b.uid, touid: a.uid, thread_id: threadId, last_message_id: cd.message_id });
  const rsp = await sb.wait(MSG_IDS.ID_READ_MSG_RSP);
  if (rsp.error !== 0) fail('1046 失败: ' + JSON.stringify(rsp));
  const rn = await readWait;
  log('A 收到 1048 已读通知 last_message_id=' + rn.last_message_id);

  resA.close(); resB.close(); sa.sock.destroy(); sb.sock.destroy();
  console.log('\n[cross] ALL PASS ✅  (上传→1039 在线推送→跨用户下载→已读回执)');
  process.exit(0);
})().catch((e) => fail(e.stack || e.message));

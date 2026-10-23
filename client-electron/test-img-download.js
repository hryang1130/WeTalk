// 跨用户图片下载验证：A 上传 -> B 下载。
// 之前 ResourceServer 下载时按「请求方 uid」拼路径（out/<B>/<name>），而文件存在上传方目录
// （out/<A>/<name>），所以对方永远拿到 FileNotExists，前端只显示文件名。
// 用法：node test-img-download.js [A_email] [B_email] [passwd]
const { ResClient } = require('./core/resClient');
const { md5 } = require('./core/md5');

const GATE = 'http://127.0.0.1:8080';
const EMAIL_A = process.argv[2] || 'xm@wetalk.com';   // 上传方
const EMAIL_B = process.argv[3] || 'hao@wetalk.com';  // 下载方
const PASSWD = process.argv[4] || '123456';

const log = (...a) => console.log('[img]', ...a);
const fail = (m) => { console.error('[img][FAIL]', m); process.exit(1); };

async function login(email) {
  const hr = await fetch(GATE + '/user_login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, passwd: PASSWD }),
  });
  const r = await hr.json();
  if (r.error !== 0) fail('login failed for ' + email + ': ' + JSON.stringify(r));
  return r; // {uid, token, reshost, resport, ...}
}

(async () => {
  const a = await login(EMAIL_A);
  const b = await login(EMAIL_B);
  if (a.uid === b.uid) fail('A 和 B 是同一个账号，无法验证跨用户');
  log(`A=${EMAIL_A} uid=${a.uid}  B=${EMAIL_B} uid=${b.uid}`);

  // 内容里带随机串，避免和已有文件同名冲突
  const body = Buffer.from('WETALK-IMG-TEST ' + Date.now() + ' ' + Math.random(), 'utf8');
  const name = md5(body) + '.txt';

  const resA = new ResClient((m) => log('[A]', m));
  await resA.connect(a.reshost, Number(a.resport) || 9090);
  await resA.upload(a.uid, 1037, name, body);
  log('上传成功 name=' + name + ' size=' + body.length);

  const resB = new ResClient((m) => log('[B]', m));
  await resB.connect(b.reshost, Number(b.resport) || 9090);
  let got;
  try {
    got = await resB.download(b.uid, b.token, name);
  } catch (e) {
    fail('B 下载 A 的图片失败：' + e.message);
  }
  if (Buffer.compare(got.buffer, body) !== 0) {
    fail(`字节不一致: 期望 ${body.length} 实际 ${got.buffer.length}`);
  }
  log('跨用户下载成功，字节完全一致 (' + body.length + ' bytes)');

  // 反例：B 拿 A 的 token 下载应被拒（首片校验 Redis token）
  try {
    await resB.download(b.uid, a.token, name);
    log('注意: token 校验未生效（用别人的 token 也能下）');
  } catch (e) {
    log('反例通过：伪造 token 被拒 -> ' + e.message);
  }

  resA.close(); resB.close();
  log('ALL PASS');
  process.exit(0);
})().catch((e) => fail(e.stack || e.message));

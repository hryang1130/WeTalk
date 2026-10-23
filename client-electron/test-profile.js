// /user_profile 端点联调：登录拿 token -> 更新资料 -> 校验返回
const GATE = 'http://127.0.0.1:8080';
(async () => {
  const l = await (await fetch(GATE + '/user_login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hao@wetalk.com', passwd: '123456' }),
  })).json();
  if (l.error !== 0) { console.log('login fail', l); process.exit(1); }
  console.log('login ok uid=' + l.uid);
  // 1. 错误 token 应被拒
  let p = await (await fetch(GATE + '/user_profile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: l.uid, token: 'bad-token', nick: 'hao', desc: 'x' }),
  })).json();
  console.log('bad-token case ->', 'error=' + p.error, p.error === 1010 ? '(TokenInvalid, PASS)' : '(UNEXPECTED)');
  // 2. 正确 token 保存（昵称保持 hao）
  p = await (await fetch(GATE + '/user_profile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: l.uid, token: l.token, nick: 'hao', desc: 'hello wetalk' }),
  })).json();
  console.log('save case ->', 'error=' + p.error, 'nick=' + p.nick, 'desc=' + p.desc,
    p.error === 0 ? '(PASS)' : '(FAIL)');
  process.exit(0);
})();

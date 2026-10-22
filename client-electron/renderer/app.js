// 渲染进程：仅通过 window.wetalk (preload) 与主进程通信（contextIsolation 下不能 require）。
if (!window.wetalk) {
  document.body.innerHTML =
    '<div style="padding:40px;font-family:sans-serif;color:#c0392b;line-height:1.8">' +
    '<h2>客户端初始化失败</h2><p>preload 未注入（window.wetalk 不存在）。</p>' +
    '<p>请确认 main.js 中 webPreferences.sandbox = false，且 preload 路径正确。</p></div>';
  throw new Error('preload not injected');
}
const { MSG_IDS, ERROR_CODES } = window.wetalk;

const $ = (id) => document.getElementById(id);
const errText = (r) => (r && r.detail) ? r.detail : (ERROR_CODES[r && r.error] || `错误码 ${r && r.error}`);

const state = {
  self: null,          // {uid, name, nick, icon, email, token}
  friends: [],         // [{uid, name, nick, back...}]
  applies: [],         // 好友申请
  threads: {},         // uid -> thread_id（0=未创建，由服务端 1018 RSP 回填）
  chats: {},           // uid -> [{mine, content, time, status, unique_id, pending}]
  active: null,        // 当前聊天对象 uid
};

/* ---------------- 视图切换 ---------------- */
function showAuth() { $('view-auth').classList.remove('hidden'); $('view-main').classList.add('hidden'); }
function showMain() { $('view-auth').classList.add('hidden'); $('view-main').classList.remove('hidden'); }

/* ---------------- 登录 / 注册 ---------------- */
const gateUrl = () => $('gate-url').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8080';

$('tab-login').onclick = () => {
  $('tab-login').classList.add('active'); $('tab-register').classList.remove('active');
  $('form-login').classList.remove('hidden'); $('form-register').classList.add('hidden');
};
$('tab-register').onclick = () => {
  $('tab-register').classList.add('active'); $('tab-login').classList.remove('active');
  $('form-register').classList.remove('hidden'); $('form-login').classList.add('hidden');
};

$('btn-varify').onclick = async () => {
  const email = $('reg-email').value.trim();
  if (!email) return msg('reg-msg', '请先填邮箱');
  const r = await window.wetalk.httpPost('/get_varifycode', { email }, gateUrl());
  msg('reg-msg', r.error === 0 ? '验证码已发送，请查收邮箱' : `发送失败：${errText(r)}`, r.error === 0);
};

$('form-register').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const body = {
      email: $('reg-email').value.trim(),
      user: $('reg-user').value.trim(),
      nick: $('reg-nick').value.trim() || $('reg-user').value.trim(),
      passwd: $('reg-passwd').value,
      confirm: $('reg-confirm').value,
      icon: '1',
      varifycode: $('reg-varifycode').value.trim(),
    };
    const r = await window.wetalk.httpPost('/user_register', body, gateUrl());
    if (r.error === 0) { msg('reg-msg', `注册成功，uid=${r.uid}，请切换到登录`, true); $('tab-login').click(); }
    else msg('reg-msg', `注册失败：${errText(r)}`);
  } catch (err) { msg('reg-msg', '注册异常：' + err.message); }
};

$('form-login').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const email = $('login-email').value.trim();
    const r = await window.wetalk.httpPost('/user_login', { email, passwd: $('login-passwd').value }, gateUrl());
    if (r.error !== 0) return msg('login-msg', `登录失败：${errText(r)}`);
    // HTTP 登录返回：{uid, token, chathost, chatport, reshost, resport}
    await window.wetalk.tcpConnect({ host: r.chathost, port: Number(r.chatport), uid: r.uid, token: r.token });
    state.self = { uid: r.uid, email, token: r.token };
    msg('login-msg', '已连接聊天服务器，认证中…', true);
  } catch (err) {
    msg('login-msg', '登录异常：' + err.message);
  }
};

function msg(id, text, ok = false) { const el = $(id); el.textContent = text; el.className = 'msg' + (ok ? ' ok' : ''); }

/* ---------------- TCP 帧分发 ---------------- */
window.wetalk.onFrame(({ msgid, obj }) => {
  switch (msgid) {
    case MSG_IDS.MSG_CHAT_LOGIN_RSP: onLoginRsp(obj); break;
    case MSG_IDS.ID_TEXT_CHAT_MSG_RSP: onTextRsp(obj); break;
    case MSG_IDS.ID_NOTIFY_TEXT_CHAT_MSG_REQ: onTextNotify(obj); break;
    case MSG_IDS.ID_SEARCH_USER_RSP: onSearchRsp(obj); break;
    case MSG_IDS.ID_ADD_FRIEND_RSP: onAddFriendRsp(obj); break;
    case MSG_IDS.ID_NOTIFY_ADD_FRIEND_REQ: onNotifyApply(obj); break;
    case MSG_IDS.ID_NOTIFY_AUTH_FRIEND_REQ: onNotifyAuth(obj); break;
    case MSG_IDS.ID_HEARTBEAT_RSP: break; // 心跳回包忽略
    default: console.log('unhandled msgid', msgid, obj);
  }
});
window.wetalk.onClosed(({ reason }) => { alert(`连接断开（${reason}），请重新登录`); showAuth(); });
window.wetalk.onError(({ message }) => console.warn('tcp error:', message));

function onLoginRsp(obj) {
  if (obj.error !== 0) { msg('login-msg', `TCP 认证失败：${errText(obj)}`); return; }
  state.self = { ...state.self, name: obj.name, nick: obj.nick, icon: obj.icon };
  state.friends = obj.friend_list || [];
  state.applies = obj.apply_list || [];
  $('me-name').textContent = obj.nick || obj.name;
  $('me-uid').textContent = `uid ${obj.uid}`;
  renderFriends(); renderApplies();
  msg('login-msg', '登录成功', true);
  showMain();
}

/* ---------------- 好友 / 申请 ---------------- */
function renderFriends() {
  const ul = $('friend-list'); ul.innerHTML = '';
  for (const f of state.friends) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${f.nick || f.name}</span><span class="muted">#${f.uid}</span>`;
    li.onclick = () => openChat(f.uid, f.nick || f.name);
    if (state.active === f.uid) li.classList.add('active');
    ul.appendChild(li);
  }
}

function renderApplies() {
  const ul = $('apply-list'); ul.innerHTML = '';
  for (const a of state.applies) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${a.name || a.nick || a.uid} 请求加好友</span>`;
    const btn = document.createElement('button');
    btn.className = 'tiny'; btn.textContent = '同意';
    btn.onclick = () => window.wetalk.tcpSend(MSG_IDS.ID_AUTH_FRIEND_REQ, {
      fromuid: state.self.uid, touid: a.uid, back: a.name || String(a.uid),
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function onNotifyApply(obj) { // 1011 收到好友申请
  state.applies.push({ uid: obj.applyuid, name: obj.name, nick: obj.nick });
  renderApplies();
}
function onNotifyAuth(obj) { // 1015 好友认证通过（对方同意了我的申请）
  // 对方信息在 obj.from_name 等字段（服务端构造），做防御式渲染
  const f = { uid: obj.touid === state.self.uid ? obj.fromuid : obj.touid, name: obj.name || obj.from_name || String(obj.fromuid), nick: obj.nick };
  if (!state.friends.some((x) => x.uid === f.uid)) state.friends.push(f);
  renderFriends();
}

/* ---------------- 搜索 / 添加好友 ---------------- */
$('btn-search').onclick = () => {
  const q = $('search-input').value.trim();
  if (q) window.wetalk.tcpSend(MSG_IDS.ID_SEARCH_USER_REQ, { uid: q });
};

function onSearchRsp(obj) {
  const box = $('search-result'); box.classList.remove('hidden');
  if (obj.error !== 0 || !obj.uid) { box.innerHTML = '<div>未找到该用户</div>'; return; }
  const already = state.friends.some((f) => f.uid === obj.uid);
  box.innerHTML = `<div><b>${obj.name}</b> ${obj.nick || ''} #${obj.uid}<br><span class="muted">${obj.desc || ''}</span></div>`;
  if (obj.uid !== state.self.uid && !already) {
    const btn = document.createElement('button');
    btn.className = 'ghost small'; btn.textContent = '加好友'; btn.style.marginTop = '6px';
    btn.onclick = () => window.wetalk.tcpSend(MSG_IDS.ID_ADD_FRIEND_REQ, {
      uid: state.self.uid, applyname: state.self.nick || state.self.name, bakname: '', touid: obj.uid,
    });
    box.appendChild(btn);
  }
}
function onAddFriendRsp(obj) { if (obj.error === 0) alert('申请已发送，等待对方同意'); }

/* ---------------- 聊天 ---------------- */
function openChat(uid, name) {
  state.active = uid;
  if (!state.chats[uid]) state.chats[uid] = [];
  if (state.threads[uid] === undefined) state.threads[uid] = 0;
  $('chat-title').textContent = `${name}  #${uid}`;
  $('btn-send').disabled = false;
  renderFriends(); renderMsgs();
}

function renderMsgs() {
  const box = $('msg-list'); box.innerHTML = '';
  for (const m of state.chats[state.active] || []) {
    const div = document.createElement('div');
    div.className = 'bubble ' + (m.mine ? 'mine' : 'theirs') + (m.pending ? ' pending' : '');
    div.dataset.unique = m.unique_id || '';
    div.innerHTML = `${escapeHtml(m.content)}<span class="meta">${m.time}${m.pending ? ' · 发送中' : ''}</span>`;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

function nowStr() { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function sendText() {
  const content = $('input-box').value.trim();
  if (!content || !state.active) return;
  const uid = state.active;
  const unique_id = crypto.randomUUID();
  state.chats[uid].push({ mine: true, content, time: nowStr(), pending: true, unique_id });
  $('input-box').value = '';
  renderMsgs();
  window.wetalk.tcpSend(MSG_IDS.ID_TEXT_CHAT_MSG_REQ, {
    fromuid: state.self.uid, touid: uid, thread_id: state.threads[uid] || 0,
    text_array: [{ content, unique_id }],
  });
}
$('btn-send').onclick = sendText;
$('input-box').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } });

function onTextRsp(obj) { // 1018 我发的消息的回执：更新 pending 气泡 + 回填 thread_id
  if (obj.touid && state.threads[obj.touid] !== undefined) state.threads[obj.touid] = obj.thread_id;
  const arr = state.chats[obj.touid] || [];
  for (const cd of obj.chat_datas || []) {
    const m = arr.find((x) => x.unique_id === cd.unique_id);
    if (m) { m.pending = false; m.time = fmtTime(cd.chat_time) || m.time; }
  }
  if (state.active === obj.touid) renderMsgs();
}

function onTextNotify(obj) { // 1019 收到对方消息
  const uid = obj.fromuid;
  if (state.threads[uid] !== undefined || state.friends.some((f) => f.uid === uid)) {
    state.threads[uid] = obj.thread_id || state.threads[uid] || 0;
  }
  if (!state.chats[uid]) state.chats[uid] = [];
  for (const cd of obj.chat_datas || []) {
    state.chats[uid].push({ mine: false, content: cd.content, time: fmtTime(cd.chat_time), unique_id: cd.unique_id });
  }
  if (state.active === uid) renderMsgs();
  else {
    // 未打开会话：高亮一下标题栏提示（简易实现）
    const title = $('chat-title'); title.style.color = '#e74c3c';
    setTimeout(() => (title.style.color = ''), 800);
  }
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts) * (Number(ts) > 1e12 ? 1 : 1000));
  return isNaN(d) ? String(ts) : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/* ---------------- 退出 ---------------- */
$('btn-logout').onclick = async () => { await window.wetalk.tcpClose(); location.reload(); };

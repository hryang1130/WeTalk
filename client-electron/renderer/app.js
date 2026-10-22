// 渲染进程：仅通过 window.wetalk (preload) 与主进程通信（contextIsolation 下不能 require）。
if (!window.wetalk) {
  document.body.innerHTML =
    '<div style="padding:40px;font-family:sans-serif;color:#c0392b;line-height:1.8">' +
    '<h2>客户端初始化失败</h2><p>preload 未注入（window.wetalk 不存在）。</p>' +
    '<p>请确认 main.js 中 webPreferences.sandbox = false，且 preload 路径正确。</p></div>';
  throw new Error('preload not injected');
}
const { MSG_IDS, RES_IDS, ERROR_CODES } = window.wetalk;

const $ = (id) => document.getElementById(id);
const errText = (r) => (r && r.detail) ? r.detail : (ERROR_CODES[r && r.error] || `错误码 ${r && r.error}`);
const isImgName = (s) => /\.(png|jpe?g|gif|bmp|webp)$/i.test(String(s || ''));

const state = {
  self: null,          // {uid, name, nick, icon, email, token, reshost, resport}
  friends: [],         // [{uid, name, nick, back...}]
  applies: [],         // 好友申请
  threads: {},         // uid -> thread_id（0=未创建，由服务端 1018 RSP 回填）
  chats: {},           // uid -> [{type:'text'|'img', mine, content, time, unique_id, pending, dataUrl}]
  active: null,        // 当前聊天对象 uid
  history: {},         // uid -> {last_message_id, load_more, loaded}
  loadingHistory: false,
  imgCache: {},        // 图片名 -> dataURL
  unread: {},          // uid -> 未读数
  pane: 'chats',       // 中栏当前 tab
};

const AVATAR_COLORS = ['#7d2834','#2f6f9e','#2f9e6e','#8a6d2f','#6b4fa0','#a05a2c','#3d7a86','#943e5c'];
const avatarColor = (uid) => AVATAR_COLORS[Math.abs(Number(uid) || 0) % AVATAR_COLORS.length];
function avatarEl(uid, name, cls = '') {
  const d = document.createElement('div');
  d.className = 'avatar ' + cls;
  d.style.background = avatarColor(uid);
  d.textContent = String(name || '?').trim().charAt(0).toUpperCase() || '?';
  return d;
}
const $avatar = { me: null, peer: null };

/* ---------------- 视图切换 ---------------- */
function showAuth() { $('view-auth').classList.remove('hidden'); $('view-main').classList.add('hidden'); }
function showMain() {
  $('view-auth').classList.add('hidden'); $('view-main').classList.remove('hidden');
  $avatar.me = avatarEl(state.self.uid, state.self.nick || state.self.name);
  $('me-avatar').replaceWith($avatar.me);
  $avatar.me.id = 'me-avatar';
  renderSessions(); renderApplies(); renderContacts(); updateBadges();
}

/* ---------------- 登录 / 注册 ---------------- */
const gateUrl = () => ($('pane-title') ? '' : '') || ($('gate-url').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8080');

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
    state.self = { uid: r.uid, email, token: r.token, reshost: r.reshost, resport: r.resport };
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
    case MSG_IDS.ID_LOAD_CHAT_MSG_RSP: onHistoryRsp(obj); break;
    case MSG_IDS.ID_IMG_CHAT_MSG_RSP: onImgRsp(obj); break;
    case MSG_IDS.ID_HEARTBEAT_RSP: break; // 心跳回包忽略
    default: console.log('unhandled msgid', msgid, obj);
  }
});
window.wetalk.onClosed(({ reason }) => { alert(`连接断开（${reason}），请重新登录`); location.reload(); });
window.wetalk.onError(({ message }) => console.warn('tcp error:', message));

function friendName(uid) {
  const f = state.friends.find((x) => x.uid === uid);
  return (f && (f.nick || f.name)) || String(uid);
}

function onLoginRsp(obj) {
  if (obj.error !== 0) { msg('login-msg', `TCP 认证失败：${errText(obj)}`); return; }
  state.self = { ...state.self, name: obj.name, nick: obj.nick, icon: obj.icon };
  state.friends = obj.friend_list || [];
  state.applies = obj.apply_list || [];
  msg('login-msg', '登录成功', true);
  showMain();
}

/* ---------------- 中栏 tab ---------------- */
function switchPane(pane) {
  state.pane = pane;
  $('nav-chats').classList.toggle('active', pane === 'chats');
  $('nav-contacts').classList.toggle('active', pane === 'contacts');
  $('session-list').classList.toggle('hidden', pane !== 'chats');
  $('contacts-pane').classList.toggle('hidden', pane !== 'contacts');
  $('pane-title').textContent = pane === 'chats' ? '消息' : '联系人';
}
$('nav-chats').onclick = () => switchPane('chats');
$('nav-contacts').onclick = () => switchPane('contacts');

function updateBadges() {
  const unreadTotal = Object.values(state.unread).reduce((a, b) => a + b, 0);
  $('nav-chats-badge').textContent = unreadTotal;
  $('nav-chats-badge').classList.toggle('hidden', unreadTotal === 0);
  $('nav-contacts-badge').textContent = state.applies.length;
  $('nav-contacts-badge').classList.toggle('hidden', state.applies.length === 0);
}

/* ---------------- 会话列表（消息 tab） ---------------- */
function renderSessions() {
  const ul = $('session-list'); ul.innerHTML = '';
  const uids = new Set([...Object.keys(state.chats).map(Number), ...state.friends.map((f) => f.uid)]);
  const ordered = [...uids].sort((a, b) => {
    const la = state.chats[a]?.length || 0, lb = state.chats[b]?.length || 0;
    return lb - la;
  });
  if (!ordered.length) { ul.innerHTML = '<div class="empty-tip">还没有会话<br>去「联系人」里找个好友吧</div>'; return; }
  for (const uid of ordered) {
    const li = document.createElement('li');
    if (state.active === uid) li.classList.add('active');
    li.appendChild(avatarEl(uid, friendName(uid), 'lg'));
    const main = document.createElement('div'); main.className = 'li-main';
    const msgs = state.chats[uid] || [];
    const last = msgs[msgs.length - 1];
    const preview = last ? (last.type === 'img' ? '[图片]' : last.content) : '开始聊天';
    main.innerHTML = `<div class="li-name">${escapeHtml(friendName(uid))}</div>
      <div class="li-preview">${escapeHtml(preview)}</div>`;
    li.appendChild(main);
    const side = document.createElement('div'); side.className = 'li-side';
    if (last?.time) { const t = document.createElement('div'); t.className = 'li-time'; t.textContent = last.time; side.appendChild(t); }
    if (state.unread[uid]) { const u = document.createElement('div'); u.className = 'unread-dot'; u.textContent = state.unread[uid]; side.appendChild(u); }
    li.appendChild(side);
    li.onclick = () => openChat(uid);
    ul.appendChild(li);
  }
}

/* ---------------- 联系人（联系人 tab） ---------------- */
function renderContacts() {
  const ul = $('friend-list'); ul.innerHTML = '';
  if (!state.friends.length) { ul.innerHTML = '<div class="empty-tip">暂无好友</div>'; return; }
  for (const f of state.friends) {
    const li = document.createElement('li');
    if (state.active === f.uid) li.classList.add('active');
    li.appendChild(avatarEl(f.uid, f.nick || f.name));
    const main = document.createElement('div'); main.className = 'li-main';
    main.innerHTML = `<div class="li-name">${escapeHtml(f.nick || f.name)}</div>
      <div class="li-preview muted">${escapeHtml(f.desc || '#' + f.uid)}</div>`;
    li.appendChild(main);
    li.onclick = () => { switchPane('chats'); openChat(f.uid); };
    ul.appendChild(li);
  }
}

function renderApplies() {
  const ul = $('apply-list'); ul.innerHTML = '';
  if (!state.applies.length) { ul.innerHTML = '<div class="empty-tip">暂无申请</div>'; }
  for (const a of state.applies) {
    const li = document.createElement('li');
    li.appendChild(avatarEl(a.uid, a.name || a.nick));
    const main = document.createElement('div'); main.className = 'li-main';
    main.innerHTML = `<div class="li-name">${escapeHtml(a.name || a.nick || String(a.uid))}</div>
      <div class="li-preview">请求加你为好友</div>`;
    li.appendChild(main);
    const btn = document.createElement('button');
    btn.className = 'tiny'; btn.textContent = '同意';
    btn.onclick = () => window.wetalk.tcpSend(MSG_IDS.ID_AUTH_FRIEND_REQ, {
      fromuid: state.self.uid, touid: a.uid, back: a.name || String(a.uid),
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
  updateBadges();
}

/* ---------------- 搜索 / 添加好友 ---------------- */
$('btn-search').onclick = () => {
  const q = $('search-input').value.trim();
  if (q) window.wetalk.tcpSend(MSG_IDS.ID_SEARCH_USER_REQ, { uid: q });
};
$('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-search').click(); });

function onSearchRsp(obj) {
  const box = $('search-result'); box.classList.remove('hidden');
  if (obj.error !== 0 || !obj.uid) { box.innerHTML = '<div class="muted">未找到该用户</div>'; return; }
  const already = state.friends.some((f) => f.uid === obj.uid);
  box.innerHTML = '';
  const line = document.createElement('div'); line.className = 'row-line';
  line.appendChild(avatarEl(obj.uid, obj.name, 'sm'));
  const info = document.createElement('div');
  info.innerHTML = `<b>${escapeHtml(obj.name)}</b> <span class="muted">#${obj.uid}</span><br>
    <span class="muted">${escapeHtml(obj.desc || obj.nick || '')}</span>`;
  line.appendChild(info); box.appendChild(line);
  if (obj.uid !== state.self.uid && !already) {
    const btn = document.createElement('button');
    btn.className = 'tiny'; btn.textContent = '+ 加好友'; btn.style.marginTop = '4px';
    btn.onclick = () => window.wetalk.tcpSend(MSG_IDS.ID_ADD_FRIEND_REQ, {
      uid: state.self.uid, applyname: state.self.nick || state.self.name, bakname: '', touid: obj.uid,
    });
    box.appendChild(btn);
  }
}
function onAddFriendRsp(obj) { if (obj.error === 0) alert('申请已发送，等待对方同意'); }

/* ---------------- 聊天 ---------------- */
function openChat(uid) {
  uid = Number(uid);
  state.active = uid;
  if (!state.chats[uid]) state.chats[uid] = [];
  if (state.threads[uid] === undefined) state.threads[uid] = 0;
  state.unread[uid] = 0;
  $('chat-peer-name').textContent = friendName(uid);
  $('chat-peer-uid').textContent = 'uid ' + uid;
  const pa = avatarEl(uid, friendName(uid), 'sm'); pa.id = 'chat-peer-avatar';
  $('chat-peer-avatar').replaceWith(pa);
  $('btn-send').disabled = false;
  $('btn-img').disabled = false;
  renderSessions(); renderContacts(); updateBadges(); renderMsgs();
  loadHistory(uid);
}

/* ---------------- 历史消息（1029，游标分页） ---------------- */
function loadHistory(uid) {
  const tid = state.threads[uid] || 0;
  if (!tid) return;                       // thread 未创建，无历史可拉
  const h = state.history[uid] || { last_message_id: 0, load_more: true, loaded: false };
  if (!h.load_more || state.loadingHistory) return;
  state.loadingHistory = true;
  window.wetalk.tcpSend(MSG_IDS.ID_LOAD_CHAT_MSG_REQ, { thread_id: tid, message_id: h.last_message_id });
}

function onHistoryRsp(obj) { // {error, thread_id, last_message_id, load_more, chat_datas}
  state.loadingHistory = false;
  const uid = Object.keys(state.threads).find((u) => state.threads[u] === obj.thread_id);
  if (!uid || obj.error !== 0) return;
  const uidNum = Number(uid);
  const h = state.history[uidNum] || (state.history[uidNum] = {});
  const arr = state.chats[uidNum];
  const older = (obj.chat_datas || []).map((c) => ({
    type: isImgName(c.msg_content) ? 'img' : 'text',
    mine: c.sender === state.self.uid,
    content: c.msg_content,
    time: fmtTime(c.chat_time),
    unique_id: String(c.unique_id || ''),
  })).reverse();
  arr.unshift(...older);
  h.last_message_id = obj.last_message_id;
  h.load_more = !!obj.load_more;
  h.loaded = true;
  if (state.active === uidNum) renderMsgs(true);
  for (const m of older) if (m.type === 'img' && !state.imgCache[m.content]) fetchImage(m.content);
}

function onImgRsp(obj) { // 1036 图片消息回执：thread_id 回填 + 去 pending
  if (obj.touid && state.threads[obj.touid] !== undefined) state.threads[obj.touid] = obj.thread_id;
  const arr = state.chats[obj.touid] || [];
  for (const m of arr) if (m.unique_id === obj.unique_id) m.pending = false;
  if (state.active === obj.touid) renderMsgs();
}

/* ---------------- 消息渲染 ---------------- */
function pushMsg(uid, m) {
  if (!state.chats[uid]) state.chats[uid] = [];
  state.chats[uid].push(m);
  if (state.active === uid) renderMsgs();
  else { state.unread[uid] = (state.unread[uid] || 0) + 1; renderSessions(); updateBadges(); }
}

function renderMsgs(keepScrollTop) {
  const box = $('msg-list');
  const prevHeight = box.scrollHeight;
  box.innerHTML = '';
  const msgs = state.chats[state.active] || [];
  if (!msgs.length) {
    const tip = document.createElement('div'); tip.className = 'system';
    tip.textContent = '开始你的第一次对话吧';
    box.appendChild(tip);
  }
  for (const m of msgs) {
    const row = document.createElement('div');
    row.className = 'msg-row ' + (m.mine ? 'mine' : '');
    const peer = state.active;
    row.appendChild(m.mine
      ? ($avatar.me ? $avatar.me.cloneNode(true) : avatarEl(state.self.uid, state.self.name))
      : avatarEl(peer, friendName(peer)));
    const body = document.createElement('div'); body.className = 'msg-body ' + (m.mine ? 'mine' : '');
    const div = document.createElement('div');
    div.className = 'bubble' + (m.pending ? ' pending' : '');
    if (m.unique_id) div.dataset.unique = m.unique_id;
    if (m.type === 'img') {
      const img = document.createElement('img');
      const url = m.dataUrl || state.imgCache[m.content];
      if (url) img.src = url;
      else { img.className = 'loading'; img.alt = m.content; fetchImage(m.content); }
      div.appendChild(img);
      const meta = document.createElement('span'); meta.className = 'meta';
      meta.textContent = `${m.content} ${m.time || ''}`;
      div.appendChild(meta);
    } else {
      div.innerHTML = `${escapeHtml(m.content)}<span class="meta">${m.time}${m.pending ? ' · 发送中' : ''}</span>`;
    }
    body.appendChild(div);
    row.appendChild(body);
    box.appendChild(row);
  }
  if (keepScrollTop) box.scrollTop = box.scrollHeight - prevHeight;
  else box.scrollTop = box.scrollHeight;
  const h = state.history[state.active];
  if (h && h.load_more) {
    box.onscroll = () => { if (box.scrollTop === 0) loadHistory(state.active); };
  } else box.onscroll = null;
}

function nowStr() { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts) * (Number(ts) > 1e12 ? 1 : 1000));
  return isNaN(d) ? String(ts) : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/* ---------------- 发送文本 ---------------- */
function sendText() {
  const content = $('input-box').value.trim();
  if (!content || !state.active) return;
  const uid = state.active;
  const unique_id = crypto.randomUUID();
  pushMsg(uid, { type: 'text', mine: true, content, time: nowStr(), pending: true, unique_id });
  $('input-box').value = '';
  window.wetalk.tcpSend(MSG_IDS.ID_TEXT_CHAT_MSG_REQ, {
    fromuid: state.self.uid, touid: uid, thread_id: state.threads[uid] || 0,
    text_array: [{ content, unique_id }],
  });
}
$('btn-send').onclick = sendText;
$('input-box').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } });

/* ---------------- 图片消息 ---------------- */
async function ensureRes() {
  const { reshost, resport } = state.self;
  await window.wetalk.resConnect(reshost, Number(resport) || 9090);
}

$('btn-img').onclick = () => $('img-input').click();
$('img-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.active) return;
  try {
    if (!state.imgCache._connected) { await ensureRes(); state.imgCache._connected = true; }
    const buf = new Uint8Array(await file.arrayBuffer());
    const md5hex = await window.wetalk.md5Hex(buf);
    const name = md5hex + (file.name.match(/\.\w+$/)?.[0] || '.png').toLowerCase();
    // 1) 分片上传到 ResourceServer（1037 图片上传）
    await window.wetalk.resUpload(state.self.uid, RES_IDS.ID_IMG_CHAT_UPLOAD_REQ, name, bytesToB64(buf));
    // 2) ChatServer 1035 落库通知（对方经历史消息拉取）
    const uid = state.active;
    const unique_id = crypto.randomUUID();
    state.threads[uid] = state.threads[uid] || 0;
    pushMsg(uid, { type: 'img', mine: true, content: name, time: nowStr(), unique_id, pending: true,
      dataUrl: URL.createObjectURL(new Blob([buf])) });
    window.wetalk.tcpSend(MSG_IDS.ID_IMG_CHAT_MSG_REQ, {
      fromuid: state.self.uid, touid: uid, thread_id: state.threads[uid],
      md5: md5hex, name, token: state.self.token,
      unique_id, chat_time: String(Math.floor(Date.now() / 1000)), status: 3,
    });
  } catch (err) {
    alert('图片发送失败：' + err.message);
  }
});

function bytesToB64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

async function fetchImage(name) { // 从 ResourceServer 下载图片并缓存
  if (state.imgCache[name] || !state.self) return;
  state.imgCache[name] = 'loading';
  try {
    if (!state.imgCache._connected) { await ensureRes(); state.imgCache._connected = true; }
    const r = await window.wetalk.resDownload(state.self.uid, state.self.token, name);
    const blob = new Blob([Uint8Array.from(atob(r.dataB64), (c) => c.charCodeAt(0))]);
    state.imgCache[name] = URL.createObjectURL(blob);
    if (state.active !== null) renderMsgs();
  } catch (err) {
    console.warn('fetch image failed:', name, err.message);
    delete state.imgCache[name];
  }
}

/* ---------------- 通知处理 ---------------- */
function onTextRsp(obj) { // 1018 我发的消息的回执：更新 pending 气泡 + 回填 thread_id
  if (obj.touid && state.threads[obj.touid] !== undefined) state.threads[obj.touid] = obj.thread_id;
  const arr = state.chats[obj.touid] || [];
  for (const cd of obj.chat_datas || []) {
    const m = arr.find((x) => x.unique_id === cd.unique_id);
    if (m) { m.pending = false; m.time = fmtTime(cd.chat_time) || m.time; }
  }
  if (state.active === obj.touid) renderMsgs();
  renderSessions();
}

function onTextNotify(obj) { // 1019 收到对方消息
  const uid = obj.fromuid;
  if (state.threads[uid] !== undefined || state.friends.some((f) => f.uid === uid)) {
    state.threads[uid] = obj.thread_id || state.threads[uid] || 0;
  }
  for (const cd of obj.chat_datas || []) {
    pushMsg(uid, { type: 'text', mine: false, content: cd.content, time: fmtTime(cd.chat_time), unique_id: cd.unique_id });
  }
}

function onNotifyApply(obj) { // 1011 收到好友申请
  state.applies.push({ uid: obj.applyuid, name: obj.name, nick: obj.nick });
  renderApplies();
  switchPane('contacts');
}
function onNotifyAuth(obj) { // 1015 好友认证通过（对方同意了我的申请）
  const f = { uid: obj.touid === state.self.uid ? obj.fromuid : obj.touid,
    name: obj.name || obj.from_name || String(obj.fromuid), nick: obj.nick };
  if (!state.friends.some((x) => x.uid === f.uid)) state.friends.push(f);
  renderContacts();
}

/* ---------------- 退出 ---------------- */
$('btn-logout').onclick = async () => { await window.wetalk.tcpClose(); location.reload(); };

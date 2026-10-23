// 渲染进程：仅通过 window.wetalk (preload) 与主进程通信（contextIsolation 下不能 require）。
if (!window.wetalk) {
  document.body.innerHTML =
    '<div style="padding:40px;font-family:sans-serif;color:#c0392b;line-height:1.8">' +
    '<h2>客户端初始化失败</h2><p>preload 未注入（window.wetalk 不存在）。</p>' +
    '<p>请确认 main.js 中 webPreferences.sandbox = false，且 preload 路径正确。</p></div>';
  throw new Error('preload not injected');
}
const { MSG_IDS, RES_IDS, ERROR_CODES } = window.wetalk;

/* 输入诊断：捕获阶段的鼠标/焦点/键盘事件都会打到主进程日志（排查"无法输入"用） */
document.addEventListener('mousedown', (e) =>
  console.log('[diag] mousedown ->', e.target.id || e.target.className || e.target.tagName), true);
document.addEventListener('focusin', (e) =>
  console.log('[diag] focusin ->', e.target.id || e.target.tagName), true);
document.addEventListener('keydown', (e) =>
  console.log('[diag] keydown ->', e.key, 'on', e.target.id || e.target.tagName), true);

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
  loadingHistory: {},  // uid -> true（该会话的历史请求在途）
  imgCache: {},        // 图片名 -> objectURL（'loading' 表示下载中）
  imgFailed: {},       // 图片名 -> true（下载失败，点气泡重试）
  unread: {},          // uid -> 未读数
  readUpTo: {},        // uid -> 已上报已读的 last_message_id
  lastAt: {},          // uid -> 最后一条消息时间戳（会话排序用）
  pane: 'chats',       // 中栏当前 tab
};

// 头像是「形状 + 单字」，颜色取自己的一套低饱和色板；具体渐变在 CSS 里用 --av 生成
const AVATAR_COLORS = ['#8b4a3f', '#3f6b6b', '#6d5b95', '#96703f', '#4a6fa5', '#965a6a', '#4b7a5a', '#7d6a55'];
const avatarColor = (uid) => AVATAR_COLORS[Math.abs(Number(uid) || 0) % AVATAR_COLORS.length];
function avatarEl(uid, name, cls = '') {
  const d = document.createElement('div');
  d.className = 'avatar ' + cls;
  d.style.setProperty('--av', avatarColor(uid));
  d.textContent = String(name || '?').trim().charAt(0).toUpperCase() || '?';
  return d;
}
const $avatar = { me: null, peer: null };

/* ---------------- 视图切换 ---------------- */
// Windows/Electron 已知坑：焦点元素带着中文输入法组合态被隐藏（display:none）后，
// TSF 上下文卡死，页面里所有元素都无法再获得焦点。切视图前必须先摘焦点。
function releaseFocus() {
  const el = document.activeElement;
  if (el && el !== document.body && typeof el.blur === 'function') el.blur();
}
function showAuth() {
  releaseFocus();
  if (window.wetalk.setSize) { try { window.wetalk.setSize(460, 680); } catch (_) {} } // 登录页小窗
  $('view-auth').classList.remove('hidden'); $('view-main').classList.add('hidden');
}
function showMain() {
  releaseFocus();
  if (window.wetalk.setSize) { try { window.wetalk.setSize(1060, 700); } catch (_) {} } // 主界面大窗
  $('view-auth').classList.add('hidden'); $('view-main').classList.remove('hidden');
  $avatar.me = avatarEl(state.self.uid, state.self.nick || state.self.name);
  $('me-avatar').replaceWith($avatar.me);
  $avatar.me.id = 'me-avatar';
  $avatar.me.onclick = openProfile;
  renderSessions(); renderApplies(); renderContacts(); updateBadges();
}

/* ---------------- 登录 / 注册 ---------------- */
const gateUrl = () => ($('pane-title') ? '' : '') || ($('gate-url').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8080');

$('tab-login').onclick = () => {
  $('tab-login').classList.add('active'); $('tab-register').classList.remove('active');
  $('form-login').classList.remove('hidden'); $('form-register').classList.add('hidden');
  try { window.wetalk.setSize(460, 680); } catch (_) {} // 登录表短
};
$('tab-register').onclick = () => {
  $('tab-register').classList.add('active'); $('tab-login').classList.remove('active');
  $('form-register').classList.remove('hidden'); $('form-login').classList.add('hidden');
  try { window.wetalk.setSize(460, 780); } catch (_) {} // 注册表长，窗口加高避免滚动
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
    const passwd = $('login-passwd').value;
    if (!email || !passwd) { msg('login-msg', '请先填写邮箱和密码'); return; }
    const r = await window.wetalk.httpPost('/user_login', { email, passwd }, gateUrl());
    if (r.error !== 0) return msg('login-msg', `登录失败：${errText(r)}`);
    // HTTP 登录返回：{uid, token, chathost, chatport, reshost, resport}
    await window.wetalk.tcpConnect({ host: r.chathost, port: Number(r.chatport), uid: r.uid, token: r.token });
    state.self = { uid: r.uid, email, token: r.token, reshost: r.reshost, resport: r.resport };
    msg('login-msg', '已连接聊天服务器，认证中…', true);
  } catch (err) {
    console.error('[login] exception:', err);
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
    case MSG_IDS.ID_NOTIFY_IMG_CHAT_MSG_REQ: onImgNotify(obj); break;
    case MSG_IDS.ID_DELETE_FRIEND_RSP: onDeleteFriendRsp(obj); break;
    case MSG_IDS.ID_NOTIFY_DEL_FRIEND_REQ: onNotifyDelFriend(obj); break;
    case MSG_IDS.ID_READ_MSG_RSP: break; // 已读上报回包忽略
    case MSG_IDS.ID_NOTIFY_READ_MSG_REQ: onNotifyRead(obj); break;
    case MSG_IDS.ID_HEARTBEAT_RSP: break; // 心跳回包忽略
    default: console.log('unhandled msgid', msgid, obj);
  }
});
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
  // 离线期间的未读消息：服务端登录时下发 {uid, count}，点亮会话/导航红点
  for (const u of obj.unread_list || []) {
    state.unread[u.uid] = (state.unread[u.uid] || 0) + Number(u.count || 0);
  }
  msg('login-msg', '登录成功', true);
  showMain();
  renderSessions(); updateBadges();
  // 有未读的会话直接预拉历史：会话列表立刻能看到最后一条消息和红点，
  // 不用逐个点开才知道（这正是"离线消息收不到"的体感来源）
  for (const uidStr of Object.keys(state.unread)) {
    const uid = Number(uidStr);
    if (state.friends.some((f) => f.uid === uid)) loadHistory(uid);
  }
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
  const ordered = [...uids].sort((a, b) => (state.lastAt[b] || 0) - (state.lastAt[a] || 0));
  if (!ordered.length) { ul.innerHTML = '<div class="empty-tip">还没有会话<br>去「联系人」里找个好友吧</div>'; return; }
  for (const uid of ordered) {
    const li = document.createElement('li');
    if (state.active === uid) li.classList.add('active');
    li.appendChild(avatarEl(uid, friendName(uid), 'lg'));
    const main = document.createElement('div'); main.className = 'li-main';
    const msgs = state.chats[uid] || [];
    const last = msgs[msgs.length - 1];
    const preview = last
      ? (last.type === 'img' ? (last.mine ? '我：图片' : '[图片]') : (last.mine ? '我：' : '') + last.content)
      : '开始聊天';
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
  state.lastAt[uid] = Date.now();
  if (!state.chats[uid]) state.chats[uid] = [];
  if (state.threads[uid] === undefined) state.threads[uid] = 0;
  state.unread[uid] = 0;
  $('chat-peer-name').textContent = friendName(uid);
  $('chat-peer-uid').textContent = 'uid ' + uid;
  const pa = avatarEl(uid, friendName(uid), 'sm'); pa.id = 'chat-peer-avatar';
  $('chat-peer-avatar').replaceWith(pa);
  $('btn-img').disabled = false;
  $('btn-del-friend').classList.toggle('hidden', !state.friends.some((f) => f.uid === uid));
  refreshComposer();
  renderSessions(); renderContacts(); updateBadges(); renderMsgs();
  loadHistory(uid);
  reportRead(uid); // 打开会话即上报已读（历史加载后再报一次更精确）
}

/* ---------------- 已读上报（1046） ---------------- */
function reportRead(uid) {
  if (!state.self || !state.threads[uid]) return; // thread 未建立无从上报
  const arr = state.chats[uid] || [];
  let maxId = 0;
  for (const m of arr) if (!m.mine && m.msg_id && m.msg_id > maxId) maxId = m.msg_id;
  if (!maxId || maxId <= (state.readUpTo[uid] || 0)) return;
  state.readUpTo[uid] = maxId;
  window.wetalk.tcpSend(MSG_IDS.ID_READ_MSG_REQ, {
    uid: state.self.uid, touid: uid, thread_id: state.threads[uid], last_message_id: maxId,
  });
}

function onNotifyRead(obj) { // 1048 对方读了我的消息
  const uid = obj.uid; // 已读的人 = 聊天对象
  const arr = state.chats[uid] || [];
  let changed = false;
  for (const m of arr) {
    if (m.mine && m.msg_id && m.msg_id <= obj.last_message_id && !m.read) { m.read = true; changed = true; }
  }
  if (changed && state.active === uid) renderMsgs();
}

function onImgNotify(obj) { // 1039 收到对方图片消息（消息体格式同 1019，content=图片存储名）
  const uid = obj.fromuid;
  if (state.threads[uid] !== undefined || state.friends.some((f) => f.uid === uid)) {
    state.threads[uid] = obj.thread_id || state.threads[uid] || 0;
  }
  for (const cd of obj.chat_datas || []) {
    pushMsg(uid, { type: 'img', mine: false, content: cd.content, time: fmtTime(cd.chat_time), unique_id: cd.unique_id, msg_id: cd.message_id });
    fetchImage(cd.content); // 主动下载缩略图
  }
  if (state.active === uid) reportRead(uid); // 正在看，立即上报已读
}

/* ---------------- 删除好友（1043/1045） ---------------- */
$('btn-del-friend').onclick = () => {
  const uid = state.active;
  if (!uid) return;
  if (!confirm(`确定删除好友 ${friendName(uid)} 吗？聊天记录将不再互通。`)) return;
  window.wetalk.tcpSend(MSG_IDS.ID_DELETE_FRIEND_REQ, { uid: state.self.uid, touid: uid });
};

function removeFriendLocal(uid) {
  state.friends = state.friends.filter((f) => f.uid !== uid);
  delete state.chats[uid]; delete state.threads[uid];
  delete state.history[uid]; delete state.unread[uid]; delete state.readUpTo[uid];
  if (state.active === uid) {
    state.active = null;
    $('chat-peer-name').textContent = '选择一个好友开始聊天';
    $('chat-peer-uid').textContent = '';
    $('btn-send').disabled = true; $('btn-img').disabled = true;
    $('btn-del-friend').classList.add('hidden');
    const pa = avatarEl(0, '?', 'sm'); pa.id = 'chat-peer-avatar';
    $('chat-peer-avatar').replaceWith(pa);
    renderMsgs();
  }
  renderSessions(); renderContacts(); updateBadges();
}

function onDeleteFriendRsp(obj) { // 1044 我删别人成功
  if (obj.error !== 0) { alert('删除好友失败：' + errText(obj)); return; }
  removeFriendLocal(obj.touid);
}

function onNotifyDelFriend(obj) { // 1045 我被删了（obj.uid = 删人方）
  const name = friendName(obj.uid);
  removeFriendLocal(obj.uid);
  alert(name + ' 已将你从好友列表移除');
}

/* ---------------- 历史消息（1029，游标分页） ----------------
 * 登录响应里没有 thread_id 映射，所以 thread_id=0 时带上 touid，
 * 由服务端按两人解析（或首次创建）会话线程，RSP.thread_id 回填。 */
function loadHistory(uid) {
  uid = Number(uid);
  const h = state.history[uid] || { last_message_id: 0, load_more: true, loaded: false };
  if (!h.load_more || state.loadingHistory[uid]) return;
  state.loadingHistory[uid] = true;
  state._histPeer = uid; // RSP 里靠它定位会话（thread_id 可能是服务端新解析的）
  window.wetalk.tcpSend(MSG_IDS.ID_LOAD_CHAT_MSG_REQ, {
    thread_id: state.threads[uid] || 0, touid: uid, message_id: h.last_message_id,
  });
}

function onHistoryRsp(obj) { // {error, thread_id, last_message_id, load_more, chat_datas}
  delete state.loadingHistory[state._histPeer];
  const uid = state._histPeer
    ?? Object.keys(state.threads).find((u) => state.threads[u] === obj.thread_id);
  if (uid === undefined || uid === null || obj.error !== 0) return;
  const uidNum = Number(uid);
  if (obj.thread_id) state.threads[uidNum] = obj.thread_id; // 回填线程映射
  const h = state.history[uidNum] || (state.history[uidNum] = {});
  const arr = state.chats[uidNum] || (state.chats[uidNum] = []);
  const older = (obj.chat_datas || []).map((c) => ({
    type: isImgName(c.msg_content) ? 'img' : 'text',
    mine: c.sender === state.self.uid,
    content: c.msg_content,
    time: fmtTime(c.chat_time),
    ts: c.chat_time ? Number(c.chat_time) * (Number(c.chat_time) > 1e12 ? 1 : 1000) : 0,
    unique_id: String(c.unique_id || ''),
    msg_id: c.msg_id,
    read: c.sender === state.self.uid && Number(c.status) === 2,
  })).reverse();
  arr.unshift(...older);
  h.last_message_id = obj.last_message_id;
  h.load_more = !!obj.load_more;
  h.loaded = true;
  renderSessions(); // 拉到历史后刷新会话列表（重登后列表里还没有最后一条消息）
  if (state.active === uidNum) { renderMsgs(true); reportRead(uidNum); }
  for (const m of older) if (m.type === 'img' && !state.imgCache[m.content]) fetchImage(m.content);
}

function onImgRsp(obj) { // 1036 图片消息回执：thread_id 回填 + 去 pending + 记录 message_id
  if (obj.touid && state.threads[obj.touid] !== undefined) state.threads[obj.touid] = obj.thread_id;
  const arr = state.chats[obj.touid] || [];
  for (const m of arr) if (m.unique_id === obj.unique_id) { m.pending = false; m.msg_id = obj.message_id; }
  if (state.active === obj.touid) renderMsgs();
}

/* ---------------- 消息渲染 ---------------- */
function pushMsg(uid, m) {
  if (!state.chats[uid]) state.chats[uid] = [];
  if (!m.ts) m.ts = Date.now(); // 按天分组用（历史消息会在映射时带上真实 chat_time）
  state.chats[uid].push(m);
  state.lastAt[uid] = Date.now();
  if (state.active === uid) renderMsgs();
  else { state.unread[uid] = (state.unread[uid] || 0) + 1; renderSessions(); updateBadges(); }
}

/* 已读状态用「单✓/双✓」而不是文字，气泡里更安静（title 里给中文说明） */
function readMark(m) {
  if (m.pending) return '<span class="read-no">发送中</span>';
  if (!m.mine) return '';
  return m.read
    ? '<span class="read-yes" title="已读">✓✓</span>'
    : '<span class="read-no" title="未读">✓</span>';
}

/* 消息按天分组（今天 / 昨天 / 10月21日） */
function dayStartMs(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function dayLabel(ts) {
  const now = new Date();
  const diff = Math.round((dayStartMs(now.getTime()) - dayStartMs(ts)) / 864e5);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  const d = new Date(ts);
  const y = d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '年';
  return `${y}${d.getMonth() + 1}月${d.getDate()}日`;
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
  let lastDay = null;
  msgs.forEach((m, i) => {
    if (m.ts) {
      const dk = dayStartMs(m.ts);
      if (dk !== lastDay) {
        lastDay = dk;
        const sep = document.createElement('div'); sep.className = 'day-sep';
        sep.textContent = dayLabel(m.ts);
        box.appendChild(sep);
      }
    }
    // 同一侧连续消息只在本组最后一条挂头像，其余留等宽占位（气泡更整齐，不刷屏）
    const next = msgs[i + 1];
    const sameGroupNext = next && !!next.mine === !!m.mine
      && (!next.ts || !m.ts || dayStartMs(next.ts) === dayStartMs(m.ts));

    const row = document.createElement('div');
    row.className = 'msg-row ' + (m.mine ? 'mine' : '') + (sameGroupNext ? ' group-end-off' : '');
    const peer = state.active;
    if (sameGroupNext) {
      const gap = document.createElement('div'); gap.className = 'avatar-ghost';
      row.appendChild(gap);
    } else {
      row.appendChild(m.mine
        ? ($avatar.me ? $avatar.me.cloneNode(true) : avatarEl(state.self.uid, state.self.name))
        : avatarEl(peer, friendName(peer)));
    }
    const body = document.createElement('div'); body.className = 'msg-body ' + (m.mine ? 'mine' : '');
    const div = document.createElement('div');
    div.className = 'bubble' + (m.pending ? ' pending' : '');
    if (m.unique_id) div.dataset.unique = m.unique_id;
    if (m.type === 'img') {
      const cached = state.imgCache[m.content];
      const url = m.dataUrl || (cached && cached !== 'loading' ? cached : '');
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        div.classList.add('bubble-img');
        div.appendChild(img);
      } else if (state.imgFailed[m.content]) {
        const ph = document.createElement('div'); ph.className = 'img-fail';
        ph.textContent = '图片加载失败，点击重试';
        div.appendChild(ph);
        div.style.cursor = 'pointer';
        div.onclick = () => { // 重试下载
          delete state.imgFailed[m.content];
          delete state.imgCache[m.content];
          fetchImage(m.content);
        };
      } else {
        const img = document.createElement('img');
        img.className = 'loading';
        div.appendChild(img);
        fetchImage(m.content); // 已在下载中会直接 return
      }
      div.title = m.content; // 悬停可看真实文件名，气泡里不摆 md5
    } else {
      div.textContent = m.content;
    }
    body.appendChild(div);

    // 时间/已读放在气泡外，气泡只承担内容 —— 视觉更干净
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = `${escapeHtml(m.time || '')} ${readMark(m)}`;
    body.appendChild(meta);

    row.appendChild(body);
    box.appendChild(row);
  });
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
  refreshComposer();
  window.wetalk.tcpSend(MSG_IDS.ID_TEXT_CHAT_MSG_REQ, {
    fromuid: state.self.uid, touid: uid, thread_id: state.threads[uid] || 0,
    text_array: [{ content, unique_id }],
  });
}
$('btn-send').onclick = sendText;
$('input-box').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } });

// 输入框自适应高度 + 发送按钮随内容启用/禁用
function refreshComposer() {
  const box = $('input-box');
  $('btn-send').disabled = !box.value.trim() || !state.active;
  box.style.height = 'auto';
  box.style.height = Math.min(box.scrollHeight, 120) + 'px';
}
$('input-box').addEventListener('input', refreshComposer);

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
  if (!name || !state.self) return;
  if (state.imgCache[name]) return;            // 已缓存，或正在下载（'loading'）
  if (state.imgFailed[name]) return;           // 失败过，等用户点气泡重试
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
    state.imgFailed[name] = true;
    if (state.active !== null) renderMsgs();
  }
}

/* ---------------- 通知处理 ---------------- */
function onTextRsp(obj) { // 1018 我发的消息的回执：更新 pending 气泡 + 回填 thread_id
  if (obj.touid && state.threads[obj.touid] !== undefined) state.threads[obj.touid] = obj.thread_id;
  const arr = state.chats[obj.touid] || [];
  for (const cd of obj.chat_datas || []) {
    const m = arr.find((x) => x.unique_id === cd.unique_id);
    if (m) { m.pending = false; m.msg_id = cd.message_id; m.time = fmtTime(cd.chat_time) || m.time; }
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
    pushMsg(uid, { type: 'text', mine: false, content: cd.content, time: fmtTime(cd.chat_time), unique_id: cd.unique_id, msg_id: cd.message_id });
  }
  if (state.active === uid) reportRead(uid); // 正在看这个人的聊天，立即上报已读
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

/* ---------------- 退出（原地重置，不 reload） ---------------- */
$('btn-logout').onclick = async () => {
  try {
    await window.wetalk.tcpClose();
    if (state.self && state.self.token) {
      try { await window.wetalk.resClose(); } catch (_) {} // 断开 ResourceServer 数据面
    }
  } catch (err) { console.error('[logout]', err); }
  // 清空会话状态，回到登录页
  state.self = null; state.friends = []; state.applies = [];
  state.threads = {}; state.chats = {}; state.history = {};
  state.unread = {}; state.imgCache = {}; state.imgFailed = {}; state.active = null; state.readUpTo = {}; state.lastAt = {};
  state.loadingHistory = {}; state.pane = 'chats';
  $('login-email').value = ''; $('login-passwd').value = '';
  msg('login-msg', '已退出，请重新登录', true);
  switchPane('chats');
  showAuth();
  // 主进程级焦点修复兜底（窗口失活/输入法卡死时把前台焦点要回来）
  try { await window.wetalk.refocus(); } catch (_) {}
  try { $('login-email').focus(); } catch (_) {}
};

// 断线处理：原地重置回登录页（不 reload，避免初始化/焦点问题）
window.wetalk.onClosed(async ({ reason }) => {
  console.log('[conn] closed:', reason);
  try { await window.wetalk.resClose(); } catch (_) {}
  state.self = null; state.friends = []; state.applies = [];
  state.threads = {}; state.chats = {}; state.history = {};
  state.unread = {}; state.imgCache = {}; state.imgFailed = {}; state.active = null; state.readUpTo = {}; state.lastAt = {};
  state.loadingHistory = {}; state.pane = 'chats';
  $('login-email').value = ''; $('login-passwd').value = '';
  msg('login-msg', `连接断开（${reason}），请重新登录`);
  switchPane('chats');
  showAuth();
});

// 启动时按登录页尺寸显示窗口
if (window.wetalk.setSize) { try { window.wetalk.setSize(460, 680); } catch (_) {} }

/* ---------------- 个人资料设置 ---------------- */
function openProfile() {
  $('profile-nick').value = state.self.nick || state.self.name || '';
  $('profile-desc').value = state.self.desc || '';
  $('profile-msg').textContent = '';
  $('profile-modal').classList.remove('hidden');
}
$('me-avatar').onclick = openProfile;
function refreshMeAvatar() {
  const el = avatarEl(state.self.uid, state.self.nick || state.self.name);
  el.id = 'me-avatar'; el.classList.add('nav-me');
  $('me-avatar').replaceWith(el);
  $avatar.me = el;
  el.onclick = openProfile;
}
$('profile-cancel').onclick = () => $('profile-modal').classList.add('hidden');
$('profile-save').onclick = async () => {
  const nick = $('profile-nick').value.trim();
  const desc = $('profile-desc').value.trim();
  if (!nick) { $('profile-msg').textContent = '昵称不能为空'; return; }
  try {
    const r = await window.wetalk.httpPost('/user_profile',
      { uid: state.self.uid, token: state.self.token, nick, desc }, gateUrl());
    if (r.error !== 0) { $('profile-msg').textContent = '保存失败：' + errText(r); return; }
    state.self.nick = nick; state.self.desc = desc;
    refreshMeAvatar();
    renderContacts(); renderMsgs();
    $('profile-modal').classList.add('hidden');
    alert('资料已保存，下次登录全端生效');
  } catch (err) { $('profile-msg').textContent = '保存异常：' + err.message; }
};

/* ---------------- 表情面板 ---------------- */
// 只用 Windows 自带字体覆盖得到的字形：避免 🤝/🤯/🫡 这类新版 emoji 在这台机器上显示成方框
const EMOJIS = ['😀','😁','😂','🤣','😊','😍','😘','😜','🤔','😐','😴','😭','😡',
  '👍','👎','👏','🙏','💪','👌','🤗','🥳','😎','🥺','😤','😱',
  '🎉','❤️','💔','🌹','🍺','⚽','🌈','☀️','🌙','⭐','🔥','💯','🚀','🍀','🎁','🐶','🐱'];
const panel = $('emoji-panel');
for (const e of EMOJIS) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'emoji-item'; b.textContent = e;
  b.onclick = () => {
    const ta = $('input-box');
    const s = ta.selectionStart ?? ta.value.length, en = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + e + ta.value.slice(en);
    ta.selectionStart = ta.selectionEnd = s + e.length;
    ta.focus();
    refreshComposer(); // 程序化改 value 不会触发 input 事件，手动刷新发送按钮状态
  };
  panel.appendChild(b);
}
$('btn-emoji').onclick = (ev) => { ev.stopPropagation(); panel.classList.toggle('hidden'); };
document.addEventListener('mousedown', (ev) => {
  if (!panel.classList.contains('hidden') && !panel.contains(ev.target) && ev.target !== $('btn-emoji')) {
    panel.classList.add('hidden');
  }
});

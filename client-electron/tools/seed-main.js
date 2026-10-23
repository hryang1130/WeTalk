// 在页面上下文里执行：灌入一套假会话数据，用于 UI 预览截图（tools/shot.js 读取本文件）。
// 注意：这里能直接访问 app.js 顶层的 state / showMain / render*（同一全局词法环境）。
(function seed() {
  const DAY = 864e5;
  const now = Date.now();
  const today = new Date(); today.setHours(20, 41, 0, 0);
  const t0 = today.getTime();
  const y0 = t0 - DAY;

  state.self = { uid: 1001, name: 'hao', nick: 'Hao', email: 'hao@wetalk.com', token: 'tk', reshost: '127.0.0.1', resport: 9090 };
  state.friends = [
    { uid: 1099, name: 'xiaoming', nick: '小明', desc: '在写毕业论文，勿扰' },
    { uid: 1002, name: 'linman', nick: '林小满', desc: '产品 · 负责客户端' },
    { uid: 1003, name: 'zoe', nick: 'Zoe', desc: '摄影 / 随手拍' },
    { uid: 1004, name: 'kaikai', nick: '开开', desc: '后端同学' },
  ];
  state.threads = { 1099: 1, 1002: 2, 1003: 3, 1004: 4 };
  state.unread = { 1002: 2, 1003: 1 };
  state.lastAt = { 1099: t0 + 3 * 60000, 1002: t0 - 40 * 60000, 1003: t0 - 3 * 3600000, 1004: t0 - 26 * 3600000 };

  // 一张假图片（SVG data URL，避免依赖外部文件）
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="520" height="340">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#d8a08c"/><stop offset=".55" stop-color="#9d6a72"/><stop offset="1" stop-color="#4c3a52"/>' +
    '</linearGradient></defs><rect width="520" height="340" fill="url(#g)"/>' +
    '<circle cx="392" cy="86" r="44" fill="#fbeedd" opacity=".9"/>' +
    '<path d="M0 320 L120 196 L236 262 L356 168 L520 250 L520 340 L0 340Z" fill="#2c2434" opacity=".55"/>' +
    '<path d="M0 340 L96 268 L210 300 L330 246 L520 306 L520 340Z" fill="#211b28" opacity=".5"/></svg>';
  state.imgCache['sunset.png'] = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);

  state.chats[1099] = [
    { type: 'text', mine: false, content: '在吗？昨天拍的那张夕阳我修完了', time: '21:12', ts: y0 + 90 * 60000, msg_id: 11 },
    { type: 'text', mine: true, content: '在的，发我看看', time: '21:14', ts: y0 + 92 * 60000, msg_id: 12, read: true },
    { type: 'img', mine: false, content: 'sunset.png', time: '21:15', ts: y0 + 93 * 60000, msg_id: 13 },
    { type: 'text', mine: true, content: '这个色调好看，暗部再压一点就更稳了', time: '21:18', ts: y0 + 96 * 60000, msg_id: 14, read: true },
    { type: 'text', mine: false, content: '好，我调完发你原图 😀', time: '20:36', ts: t0 - 5 * 60000, msg_id: 15 },
    { type: 'text', mine: true, content: '顺便把上次那个 README 也更新一下吧，图片那条坑写清楚', time: '20:38', ts: t0 - 3 * 60000, msg_id: 16, read: true },
    { type: 'text', mine: true, content: '我这边已经推上去了', time: '20:41', ts: t0, msg_id: 17, read: false },
  ];
  state.chats[1002] = [
    { type: 'text', mine: false, content: '下个版本的交互稿我放共享盘了', time: '19:02', ts: t0 - 40 * 60000, msg_id: 21 },
    { type: 'text', mine: false, content: '重点看下会话列表的空状态 🙏', time: '19:03', ts: t0 - 39 * 60000, msg_id: 22 },
  ];
  state.chats[1003] = [
    { type: 'text', mine: true, content: '照片收到了，很棒', time: '17:20', ts: t0 - 3 * 3600000, msg_id: 31, read: true },
  ];
  state.chats[1004] = [
    { type: 'text', mine: false, content: '服务端我这边重启好了', time: '15:02', ts: y0 - 5 * 3600000, msg_id: 41 },
  ];

  state.history[1099] = { last_message_id: 11, load_more: false, loaded: true };
  state.applies = [{ uid: 1005, name: 'zhouyu', nick: '周予' }];

  showMain();
  switchPane('chats');
  openChat(1099);
})();

// UI 预览/截图工具：不连服务端，用假数据把 renderer/index.html 渲染出来并截图。
// 用法：npx electron tools/shot.js   → 输出到 client-electron/__ui/*.png
// 目的：改样式时能先看到效果，避免"改完全靠用户反馈"。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', '__ui');
const SEED = path.join(__dirname, 'seed-main.js');

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function shot(win, name) {
  await wait(500); // 等字体/布局稳定
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
  console.log('[shot]', name + '.png');
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 460, height: 680, show: true, backgroundColor: '#f6f3f0',
    webPreferences: {
      preload: path.join(__dirname, 'preload-stub.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await wait(1200); // 首帧要等窗口真正画出来，否则 capturePage 可能拿到空图

  // 1) 登录页（默认就是）
  await shot(win, '01-auth');

  // 2) 注册页（表单更长，窗口加高）
  win.setSize(460, 780);
  await wait(300);
  await win.webContents.executeJavaScript("document.getElementById('tab-register').click()");
  await shot(win, '02-register');
  await win.webContents.executeJavaScript("document.getElementById('tab-login').click()");
  win.setSize(460, 680);
  await wait(300);

  // 3) 主界面：灌假数据后切大窗
  win.setSize(1060, 700);
  await wait(500); // 等布局按新尺寸重排，否则滚动位置按旧视口算
  await win.webContents.executeJavaScript(fs.readFileSync(SEED, 'utf8'));
  await win.webContents.executeJavaScript(
    "const b=document.getElementById('msg-list'); b.scrollTop=b.scrollHeight;");
  await shot(win, '03-main');

  // 4) 联系人 tab
  await win.webContents.executeJavaScript("document.getElementById('nav-contacts').click()");
  await shot(win, '04-contacts');
  await win.webContents.executeJavaScript(
    "document.getElementById('nav-chats').click(); openChat(1099)");
  await wait(300);

  // 5) 表情面板
  await win.webContents.executeJavaScript("document.getElementById('btn-emoji').click()");
  await shot(win, '05-emoji');
  await win.webContents.executeJavaScript("document.getElementById('btn-emoji').click()");

  // 6) 个人资料弹窗
  await win.webContents.executeJavaScript("openProfile()");
  await shot(win, '06-profile');

  console.log('[shot] done ->', OUT);
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });

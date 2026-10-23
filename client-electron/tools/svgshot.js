// 渲染任意 SVG 为 PNG 供检查：node 渲染不了，借 Electron。
// 用法：electron tools/svgshot.js <input.svg> <output.png>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const [, , inSvg, outPng] = process.argv;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180, height: 580, show: false, useContentSize: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL('file://' + path.resolve(inSvg).replace(/\\/g, '/'));
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(outPng, img.toPNG());
  console.log('[svgshot] saved', outPng);
  app.quit();
});

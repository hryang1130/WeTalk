// 用 Node 内置 WebSocket 直连 Electron 的 CDP 端口，执行 JS 表达式。
// 用法：node tools/cdp-eval.js <port> '<expression>' [waitMs]
//   例：node tools/cdp-eval.js 9222 "document.title"
// 页面表达式在所有 page target 上执行，输出每个 target 的结果（截断 300 字符）。
const port = process.argv[2];
const expr = process.argv[3];
const waitMs = Number(process.argv[4] || 0);

const log = (...a) => console.log('[cdp]', ...a);

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const pages = list.filter((t) => t.type === 'page');
  if (!pages.length) { console.error('no page target'); process.exit(1); }
  for (const t of pages) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout')), 10000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
          params: { expression: expr, returnByValue: true, awaitPromise: waitMs > 0 } }));
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) { clearTimeout(timer); resolve(m.result?.result?.value ?? JSON.stringify(m.result)); }
      };
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error('ws error')); };
    });
    const s = String(result);
    log(`${t.title.slice(0, 30)} =>`, s.length > 300 ? s.slice(0, 300) + '…' : s);
    try { ws.close(); } catch (_) {}
  }
}
main().catch((e) => { console.error('[cdp] FAIL', e.message); process.exit(1); });

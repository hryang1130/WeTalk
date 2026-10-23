// 一次性 runner：以子进程跑指定测试脚本，把 stdout/stderr/exit code 落盘，绕开 PowerShell 管道吞输出的坑。
// 用法：node runner-run.js <script.js> <outfile>
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const script = process.argv[2];
const outfile = process.argv[3];
if (!script || !outfile) {
  console.error('usage: node runner-run.js <script.js> <outfile>');
  process.exit(2);
}

const r = spawnSync(process.execPath, [script], {
  cwd: __dirname,
  encoding: 'utf8',
  timeout: 150000,
});

let out = `SCRIPT: ${script}\nSTATUS: ${r.status}\n`;
if (r.error) out += `SPAWN-ERROR: ${r.error.stack || r.error}\n`;
out += `--- STDOUT ---\n${r.stdout || '(empty)'}\n--- STDERR ---\n${r.stderr || '(empty)'}\n`;
fs.writeFileSync(path.resolve(outfile), out, 'utf8');
console.log('runner done, status=' + r.status);
process.exit(0);

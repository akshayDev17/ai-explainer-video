// Load a scene page in headless chromium and print any console output or
// uncaught exceptions. A page that fails to boot reports as
// "never exposed window.VIDEO_META", which tells you nothing about WHY.
//
//   node tools/debug-page.mjs src/scene-diagram.html

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { chromiumBinOrExit } from './chromium.mjs';
import { requireNode } from './env.mjs';

requireNode();

const page = process.argv[2] || 'src/scene-diagram.html';
const BIN = chromiumBinOrExit('debug-page');
const PORT = 9444;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const proc = spawn(BIN, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--allow-file-access-from-files', `--remote-debugging-port=${PORT}`, '--window-size=1920,1080',
  'file://' + resolve(page)], { stdio: 'ignore' });

try {
  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {}
  }
  if (!target) throw new Error('no page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const logs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`console.${m.params.type}: ` + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push(`EXCEPTION: ${d.exception?.description || d.text}`);
    }
    if (m.method === 'Log.entryAdded') logs.push(`log.${m.params.entry.level}: ${m.params.entry.text}`);
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result));
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.reload');           // reload so we capture boot-time errors
  await sleep(2500);

  const state = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({meta: !!window.VIDEO_META, scenes: typeof window.SceneCore, cfg: typeof window.SCENE_CONFIG, tl: typeof window.TIMELINE})',
    returnByValue: true,
  });
  console.log('page state:', state.result.value);
  console.log('\n--- console / errors ---');
  console.log(logs.length ? logs.join('\n') : '(nothing captured)');
  ws.close();
} catch (e) {
  console.error('[debug error]', e.message);
} finally {
  proc.kill();
}

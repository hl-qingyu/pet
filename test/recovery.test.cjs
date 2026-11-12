const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { attachPetRecovery } = require('../src/pet-recovery.cjs');
const { createDiagnostics } = require('../src/runtime-diagnostics.cjs');

function fixture() {
  const window = new EventEmitter(); window.webContents = new EventEmitter();
  let quitting = false, destroyed = false, reloads = 0, recovered = 0, now = 0;
  const pending = new Map(), logs = []; let id = 0;
  window.isDestroyed = () => destroyed; window.reload = () => reloads++;
  const dispose = attachPetRecovery(window, { isQuitting: () => quitting, log: value => logs.push(value),
    onRecovered: () => recovered++, now: () => now,
    setTimer: fn => { pending.set(++id, fn); return id; }, clearTimer: key => pending.delete(key) });
  return { window, logs, pending, dispose, get reloads() { return reloads; }, get recovered() { return recovered; },
    crash: reason => window.webContents.emit('render-process-gone', {}, { reason: reason || 'crashed', exitCode: -1 }),
    load: () => window.webContents.emit('did-finish-load'), advance: ms => { now += ms; },
    quit: () => { quitting = true; }, destroy: () => { destroyed = true; window.emit('closed'); },
    fire: () => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(fn => fn()); } };
}

test('pet renderer crash reloads the same window once and records recovery', () => {
  const f = fixture(); f.crash(); assert.equal(f.reloads, 0); f.fire(); assert.equal(f.reloads, 1);
  f.load(); f.load(); assert.equal(f.recovered, 1);
  assert.ok(f.logs.includes('Pet renderer recovered')); f.dispose();
});

test('renderer recovery rate limits crash loops and allows later recovery', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) { f.crash('oom'); f.fire(); f.load(); }
  assert.equal(f.reloads, 3); assert.ok(f.logs.some(log => log.includes('paused')));
  f.advance(60000); f.crash(); f.fire(); assert.equal(f.reloads, 4); f.dispose();
});

test('normal renderer exit, application quit and destroyed windows do not restart', () => {
  const f = fixture(); f.crash('clean-exit'); assert.equal(f.pending.size, 0);
  f.crash(); f.quit(); f.fire(); assert.equal(f.reloads, 0); f.dispose();
  const g = fixture(); g.crash(); g.destroy(); g.fire(); assert.equal(g.reloads, 0);
  assert.equal(g.window.webContents.listenerCount('render-process-gone'), 0);
});

test('diagnostics identify an unclean prior run and distinguish normal process exit', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  createDiagnostics(directory, '1.0.13', { pid: 100 });
  const current = createDiagnostics(directory, '1.0.13', { pid: 101 });
  current.error(new Error('secret-token'), 'uncaughtException', ['secret-token']);
  current.quitting(); current.exit(0);
  createDiagnostics(directory, '1.0.13', { pid: 102 });
  const log = fs.readFileSync(path.join(directory, 'app.log'), 'utf8');
  assert.ok(log.includes('pid=100 startedAt=')); assert.ok(!log.includes('pid=101 startedAt='));
  assert.ok(log.includes('Process exit: code=0')); assert.ok(!log.includes('secret-token'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'runtime-session.json'), 'utf8')).status, 'running');
});

test('unwritable diagnostic storage cannot terminate the application', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const blocked = path.join(directory, 'file'); fs.writeFileSync(blocked, 'not a directory');
  assert.doesNotThrow(() => { const d = createDiagnostics(blocked, '1.0.13'); d.log('test'); d.quitting(); d.exit(1); });
});

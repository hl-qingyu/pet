const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DshObserver, LIMITS, within } = require('../src/backends/dsh-observer.cjs');
const frame = value => zlib.zstdCompressSync(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value) + '\n');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-dsh-'));
  let now = Date.now(), seq = 0;
  const updates = [];
  const observer = new DshObserver({ sessionsRoot: root, ...options }, value => updates.push(value), { now: () => now });
  observer.start({ schedule: false });
  t.after(async () => { await observer.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = (name = 'a') => { const directory = path.join(root, 'workspace', `session-${name}`); fs.mkdirSync(directory, { recursive: true }); return path.join(directory, 'session.v4.jsonl.zstd'); };
  const event = (type, data = {}, time = now) => ({ type, seq: ++seq, time, data });
  const append = (target, ...values) => fs.appendFileSync(target, Buffer.concat(values.map(frame)));
  return { root, observer, updates, file, event, append, advance: ms => { now += ms; } };
}

test('real event envelope: concurrent approvals, terminal state and no duplicate notifications', async t => {
  const f = fixture(t), file = f.file();
  f.append(file, f.event('turn/start', { turn: 1 })); await f.observer.tick();
  assert.equal(f.observer.snapshot().state, 'running');
  f.append(file, f.event('approval/asked', { turn: 1, approvalId: 'one' }), f.event('approval/asked', { turn: 1, approvalId: 'two' }), f.event('tool/result', { turn: 1, isError: true }));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'waiting');
  f.append(file, f.event('approval/decided', { turn: 1, approvalId: 'one' }));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'waiting');
  f.advance(601000); await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'waiting');
  f.append(file, f.event('approval/decided', { turn: 1, approvalId: 'two' }));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'running');
  f.append(file, f.event('assistant/message', { message: { content: [{ type: 'text', text: 'PRIVATE' }] } }));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'running');
  f.append(file, f.event('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'review');
  const count = f.updates.length; await f.observer.tick(); assert.equal(f.updates.length, count);
  assert.ok(!JSON.stringify(f.updates).includes('PRIVATE'));
  f.advance(4001); await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'idle');
});

test('background jobs remain active after main turn completes; old turns cannot end a new one', async t => {
  const f = fixture(t), file = f.file();
  f.append(file, f.event('turn/start', { turn: 1 }), f.event('job/registered', { jobId: 'job' }), f.event('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'running');
  f.append(file, f.event('job/settled', { jobId: 'job' })); await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'review');
  f.append(file, f.event('turn/start', { turn: 2 }), f.event('turn/end', { turn: 1, reason: { kind: 'error' } }));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'running');
});

test('partial frames are retried without retaining input buffers', async t => {
  const f = fixture(t), file = f.file();
  const a = frame(f.event('turn/start')), b = frame(f.event('approval/asked', { id: 'ask' }));
  fs.writeFileSync(file, Buffer.concat([a, b.subarray(0, b.length >> 1)]));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'running');
  assert.equal([...f.observer.sessions.values()][0].offset, a.length);
  fs.appendFileSync(file, b.subarray(b.length >> 1)); await f.observer.tick();
  assert.equal(f.observer.snapshot().state, 'waiting');
  assert.ok(Object.values([...f.observer.sessions.values()][0]).every(value => !Buffer.isBuffer(value)));
});

test('JSON and UTF-8 spanning frames are replayed and decoded correctly', async t => {
  const f = fixture(t), file = f.file(), text = Buffer.from(JSON.stringify(f.event('approval/asked', { id: '审批' })) + '\n');
  const cut = text.indexOf(Buffer.from('审')) + 1;
  fs.writeFileSync(file, frame(text.subarray(0, cut))); await f.observer.tick();
  assert.equal(f.observer.snapshot().state, 'idle');
  fs.appendFileSync(file, frame(text.subarray(cut))); await f.observer.tick();
  assert.equal(f.observer.snapshot().state, 'waiting');
});

test('skippable frames and corruption resynchronize; complete future events recover state', async t => {
  const f = fixture(t), file = f.file(), skip = Buffer.alloc(11);
  skip.writeUInt32LE(0x184d2a50); skip.writeUInt32LE(3, 4);
  fs.writeFileSync(file, Buffer.concat([skip, frame(f.event('turn/start')), Buffer.from('corrupt'), frame(f.event('turn/end', { reason: { kind: 'error' } }))]));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'failed');
});

test('old timestamps do not replay running or completion; running expires without file growth', async t => {
  const f = fixture(t), a = f.file('old'), b = f.file('new');
  f.append(a, f.event('turn/start', {}, Date.now() - 700000));
  f.append(b, f.event('turn/end', { reason: { kind: 'completed' } }, Date.now() - 5000));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'idle');
  f.append(a, f.event('turn/start')); await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'running');
  f.advance(600001); await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'idle');
});

test('truncation and same-size replacement reset sequence and state', async t => {
  const f = fixture(t), file = f.file();
  f.append(file, f.event('approval/asked', { id: 'x' })); await f.observer.tick();
  const original = fs.statSync(file);
  const replacement = file + '.new';
  fs.writeFileSync(replacement, frame({ type: 'turn/start', seq: 0, time: Date.now(), data: {} }));
  // Pad using a valid skippable frame if needed; inode replacement is checked regardless of size.
  const size = fs.statSync(replacement).size;
  if (size + 8 <= original.size) { const pad = Buffer.alloc(original.size - size); pad.writeUInt32LE(0x184d2a50); pad.writeUInt32LE(pad.length - 8, 4); fs.appendFileSync(replacement, pad); }
  fs.renameSync(replacement, file); await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'running');
  fs.writeFileSync(file, Buffer.alloc(0)); await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'idle');
});

test('aggregation and workspace filtering use directory boundaries', async t => {
  const workspace = path.join(os.tmpdir(), 'project');
  const f = fixture(t, { workspace, showBubble: false }), a = f.file('match'), b = f.file('other');
  f.append(a, { type: 'session', cwd: path.join(workspace, 'child') }, f.event('turn/start'));
  f.append(b, { type: 'session', cwd: workspace + '-other' }, f.event('approval/asked', { id: 'x' }));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'running');
  assert.equal(f.observer.snapshot().info.count, 1); assert.equal(f.observer.snapshot().bubble, undefined);
  assert.equal(within(workspace + '-other', workspace), false);
});

test('waiting wins across workspaces and falls through when finished', async t => {
  const f = fixture(t), a = f.file('a'), b = f.file('b');
  f.append(a, f.event('turn/start')); f.append(b, f.event('approval/asked', { id: 'x' }));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'waiting');
  f.append(b, f.event('turn/end', { reason: { kind: 'completed' } }));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'running');
});

test('oversized lines and highly compressed frames degrade with bounded state', async t => {
  const f = fixture(t), file = f.file();
  f.append(file, f.event('turn/start'), JSON.stringify({ type: 'assistant/message', data: 'x'.repeat(LIMITS.line + 1) }) + '\n');
  await f.observer.tick(); assert.equal(f.observer.snapshot().info.degraded, true); assert.equal(f.observer.snapshot().state, 'idle');
  f.append(file, Buffer.alloc(LIMITS.expanded + 65536, 65)); await f.observer.tick();
  assert.equal(f.observer.snapshot().info.degraded, true);
  f.append(file, f.event('turn/start')); await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'running');
  assert.equal(f.observer.snapshot().info.degraded, false);
});

test('no-id approvals and unknown completion reasons fail closed', async t => {
  const f = fixture(t), file = f.file();
  f.append(file, f.event('turn/start'), f.event('approval/asked'));
  await f.observer.tick(); assert.equal(f.observer.snapshot().info.degraded, true);
  f.append(file, f.event('turn/end', { reason: { kind: 'new-format' } }));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'idle');
});

test('missing directory recovers; stop cancels in-flight work and suppresses callbacks', async t => {
  const f = fixture(t); fs.rmdirSync(f.root);
  await f.observer.tick(); assert.equal(f.observer.snapshot().info.message, '未找到 DSH 会话目录');
  const file = f.file(); f.append(file, f.event('turn/start')); f.advance(5001);
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'running');
  f.append(file, f.event('turn/start'));
  const visit = f.observer.tick(), callbacks = f.updates.length;
  const overlap = f.observer.tick();
  await f.observer.stop(); await visit;
  await overlap;
  assert.equal(f.updates.length, callbacks); assert.equal(f.observer.sessions.size, 0);
  await f.observer.tick(); assert.equal(f.updates.length, callbacks);
});

test('lines fragmented beyond the per-visit budget cannot stall later events', async t => {
  const f = fixture(t), file = f.file();
  const parts = Array.from({ length: 20 }, (_, i) => frame(i === 0 ? '{"unused":"' : 'x'));
  fs.writeFileSync(file, Buffer.concat([...parts, frame('"}\n'), frame(f.event('turn/start'))]));
  await f.observer.tick(); assert.equal(f.observer.snapshot().info.degraded, true);
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'running');
});

test('tail bootstrap is bounded and does not replay an old completion', async t => {
  const f = fixture(t), file = f.file();
  const random = require('node:crypto').randomBytes(LIMITS.tail + 1000).toString('base64');
  f.append(file, { type: 'assistant/message', data: random }, f.event('turn/end', { reason: { kind: 'completed' } }, Date.now() - 5000));
  await f.observer.tick(); assert.equal(f.observer.snapshot().state, 'idle');
  assert.equal([...f.observer.sessions.values()][0].offset, fs.statSync(file).size);
});

test('stop during actual decompression aborts the pipeline and closes the file', async t => {
  const f = fixture(t), file = f.file(); f.append(file, f.event('turn/start'));
  const decode = f.observer.decode.bind(f.observer); let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.observer.decode = async (...args) => { const pending = decode(...args); entered(); return pending; };
  const pending = f.observer.tick(); await ready; await f.observer.stop(); await pending;
  assert.equal(f.updates.length, 0);
  fs.renameSync(file, file + '.closed');
});

test('many sessions have a bounded index and serialized decoding', async t => {
  const f = fixture(t); let current = 0, peak = 0;
  for (let i = 0; i < LIMITS.sessions + 2; i++) f.append(f.file(String(i)), f.event('turn/start'));
  const decode = f.observer.decode.bind(f.observer);
  f.observer.decode = async (...args) => { peak = Math.max(peak, ++current); try { return await decode(...args); } finally { current--; } };
  await f.observer.tick(); assert.equal(peak, 1);
  assert.equal(f.observer.sessions.size, LIMITS.sessions); assert.equal(f.observer.snapshot().info.degraded, true);
});

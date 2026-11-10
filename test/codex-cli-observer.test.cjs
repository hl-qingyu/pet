const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CodexCliObserver, Lines, applyEvent, LIMITS } = require('../src/backends/codex-cli-observer.cjs');
const { OpenaiStatus } = require('../src/backends/openai-status.cjs');
const defaults = require('../config.example.json');
const { migrate, validate } = require('../src/config.cjs');
const line = value => JSON.stringify(value) + '\n';
const event = (type, at, turn = 'turn-a', fields = {}) => ({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type, turn_id: turn, ...fields } });
async function fixture(t, source = 'cli', options = {}, metadata = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-cli-')), day = path.join(root, '2026', '11', '10');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, 'rollout-test.jsonl'), cwd = path.resolve('work/project');
  let now = Date.now();
  fs.writeFileSync(file, line({ type: 'session_meta', payload: { id: 'session-a', source, cwd, ...metadata, base_instructions: { text: 'PRIVATE'.repeat(10000) } } }) + line(event('task_started', now, 'turn-a', { started_at: Math.floor(now / 1000) })));
  const updates = [], observer = new CodexCliObserver({ sessionsRoot: root, ...options }, value => updates.push(value), { now: () => now });
  observer.active = true;
  t.after(async () => { await observer.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { observer, root, file, cwd, updates, at: () => now, advance: ms => { now += ms; }, append: value => fs.appendFileSync(file, line(value)) };
}

test('CLI config migration preserves desktop selection and supports all four combinations', () => {
  const old = structuredClone(defaults); delete old.integrations.codexCli; old.integrations.openai.enabled = true;
  const next = migrate(old);
  assert.equal(next.integrations.openai.enabled, true); assert.equal(next.integrations.codexCli.enabled, false);
  assert.equal(old.integrations.codexCli, undefined);
  for (const desktop of [true, false]) for (const cli of [true, false]) {
    next.integrations.openai.enabled = desktop; next.integrations.codexCli.enabled = cli; validate(next);
  }
  for (const [key, value] of [['enabled', 1], ['workspace', null], ['sessionsRoot', 'x'.repeat(1001)], ['pollMs', 199], ['activeSeconds', 10.5]]) {
    const config = structuredClone(defaults); config.integrations.codexCli[key] = value;
    assert.throws(() => validate(migrate(config)), /codexCli/);
  }
});

test('CLI tails growing logs with unchanged mtime, settles only the matching turn, and expires results', async t => {
  const f = await fixture(t); await f.observer.run();
  assert.equal(f.observer.snapshot().state, 'running');
  assert.ok([...f.observer.sessions.values()][0].startedAt > 1e12);
  const stat = fs.statSync(f.file); f.advance(100);
  f.append(event('task_complete', f.at(), 'old-turn')); fs.utimesSync(f.file, stat.atime, stat.mtime);
  await f.observer.run(); assert.equal(f.observer.snapshot().state, 'running');
  f.append(event('task_complete', f.at())); fs.utimesSync(f.file, stat.atime, stat.mtime);
  await f.observer.run(); assert.equal(f.observer.snapshot().state, 'review');
  f.advance(4001); assert.equal(f.observer.snapshot().state, 'idle');
  assert.ok(!JSON.stringify(f.observer.snapshot()).includes('PRIVATE'));
  assert.ok(!JSON.stringify([...f.observer.sessions.values()].map(({ lines, ...rest }) => rest)).includes('PRIVATE'));
});

test('bootstrap never replays historical completion, including records crossing input chunks', async t => {
  const f = await fixture(t);
  f.append({ type: 'response_item', payload: { type: 'message', content: '私密🐋'.repeat(50000) } });
  f.append(event('task_complete', f.at()));
  await f.observer.run(); assert.equal(f.observer.snapshot().state, 'idle');
  assert.equal(f.observer.snapshot().info.count, 1);
});

test('streaming JSONL handles split UTF-8, partial records, malformed input and oversized bodies', () => {
  const accepted = []; let faults = 0;
  const parser = new Lines(value => accepted.push(value), () => faults++);
  const text = line({ type: 'response_item', payload: { type: 'message', content: '私密🐋'.repeat(100000) } });
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += 997) parser.push(bytes.subarray(i, i + 997));
  assert.equal(faults, 0); assert.ok(JSON.stringify(accepted).length < 100);
  parser.push(Buffer.from('{"type":bad}\n')); assert.equal(faults, 1);
  parser.push(Buffer.from('{"ignored":"'));
  const chunk = Buffer.alloc(65536, 120);
  for (let i = 0; i <= LIMITS.line / chunk.length; i++) parser.push(chunk);
  parser.push(Buffer.from('"}\n' + line(event('task_started', Date.now()))));
  assert.equal(faults, 2); assert.equal(accepted.at(-1).payload.type, 'task_started');
});

test('partial appended events are applied only after newline and corrupt logs clear stale activity', async t => {
  const f = await fixture(t); await f.observer.run();
  const complete = line(event('task_complete', f.at()));
  fs.appendFileSync(f.file, complete.slice(0, -1)); await f.observer.run();
  assert.equal(f.observer.snapshot().state, 'running');
  fs.appendFileSync(f.file, '\n'); await f.observer.run(); assert.equal(f.observer.snapshot().state, 'review');
  fs.appendFileSync(f.file, '{broken}\n'); await f.observer.run();
  assert.equal(f.observer.snapshot().state, 'idle'); assert.equal(f.observer.snapshot().info.degraded, true);
  f.advance(10); f.append(event('task_started', f.at(), 'turn-b')); await f.observer.run();
  assert.equal(f.observer.snapshot().state, 'running'); assert.equal(f.observer.snapshot().info.degraded, false);
});

test('source and workspace filters exclude editor, desktop, subagent and adjacent directories', async t => {
  for (const source of ['vscode', 'app', { subagent: { thread_spawn: { parent_thread_id: 'p' } } }]) {
    const f = await fixture(t, source); await f.observer.run(); assert.equal(f.observer.snapshot().info.count, 0);
  }
  const f = await fixture(t, 'exec', { workspace: path.resolve('work/project-neighbor') });
  await f.observer.run(); assert.equal(f.observer.snapshot().info.count, 0);
  f.observer.options.workspace = path.resolve('work'); f.observer.nextDiscovery = 0;
  await f.observer.run(); assert.equal(f.observer.snapshot().info.count, 1);
});

test('local Codex TUI user sessions labeled vscode are tracked without accepting unrelated editor or subagent logs', async t => {
  const f = await fixture(t, 'vscode', {}, { originator: 'codex-tui', thread_source: 'user' });
  await f.observer.run(); assert.equal(f.observer.snapshot().state, 'running'); assert.equal(f.observer.snapshot().info.count, 1);
  f.advance(20); f.append(event('task_complete', f.at())); await f.observer.run();
  assert.equal(f.observer.snapshot().state, 'review');
  for (const metadata of [
    { originator: 'other-editor', thread_source: 'user' },
    { originator: 'codex-tui', thread_source: 'subagent' },
    { originator: 'codex-tui', thread_source: { subagent: { parent_thread_id: 'parent' } } },
  ]) {
    const excluded = await fixture(t, 'vscode', {}, metadata); await excluded.observer.run();
    assert.equal(excluded.observer.snapshot().info.count, 0);
  }
});

test('expiration is degraded rather than completion; replacement, deletion and stop release state', async t => {
  const f = await fixture(t); await f.observer.run();
  f.advance(600001); assert.equal(f.observer.snapshot().state, 'idle'); assert.equal(f.observer.snapshot().info.degraded, true);
  fs.writeFileSync(f.file, ''); await f.observer.run(); assert.equal(f.observer.snapshot().info.count, 0);
  fs.unlinkSync(f.file); await f.observer.run();
  const updates = f.updates.length; await f.observer.stop(); f.observer.publish();
  assert.equal(f.updates.length, updates); assert.equal(f.observer.sessions.size, 0); assert.equal(f.observer.timer, null);
});

test('dual source aggregation deduplicates local identity, prefers current desktop state and isolates disconnects', () => {
  const status = new OpenaiStatus();
  const session = { hostId: 'local', id: 'a', turnId: 't', startedAt: 100, state: 'running', at: 110, bubble: 'CLI' };
  status.update('codexCli', { sessions: [session] });
  let snapshot = status.update('openai', { sessions: [{ ...session, state: 'waiting', bubble: '桌面端' }] });
  assert.equal(snapshot.info.count, 1); assert.equal(snapshot.state, 'waiting'); assert.equal(snapshot.bubble, '桌面端');
  snapshot = status.update('openai', { sessions: [{ ...session, state: 'idle', settled: true }] });
  assert.equal(snapshot.state, 'idle'); // A stale CLI start cannot resurrect the same completed desktop turn.
  assert.equal(status.clear('openai').state, 'idle');
  status.update('openai', { sessions: [{ ...session, state: 'waiting', at: 120 }] });
  assert.equal(status.clear('openai').state, 'running'); // Fresh runtime evidence can supersede an earlier settlement.
  snapshot = status.update('codexCli', { sessions: [{ ...session, turnId: 'new', startedAt: 200 }] });
  assert.equal(snapshot.state, 'running'); assert.equal(snapshot.info.count, 1);
  status.update('openai', { sessions: [{ ...session, hostId: 'remote', state: 'waiting' }] });
  assert.equal(status.snapshot().info.count, 2);
  snapshot = status.clear('openai'); assert.equal(snapshot.state, 'running'); assert.equal(snapshot.info.count, 1);
  assert.equal(status.clear('codexCli').state, 'idle');
});

test('concurrent tasks retain running priority over results without queuing old completion notifications', () => {
  const status = new OpenaiStatus();
  status.update('openai', { sessions: [{ hostId: 'local', id: 'a', state: 'review', at: 10 }] });
  status.update('codexCli', { sessions: [{ hostId: 'local', id: 'b', state: 'running', at: 11 }] });
  assert.equal(status.snapshot().state, 'running');
  status.update('openai', { sessions: [{ hostId: 'local', id: 'a', state: 'idle', at: 10 }] });
  assert.equal(status.clear('codexCli').state, 'idle');
});

test('discovery caps retained sessions and stopping during discovery emits no late update', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 36; i++) fs.writeFileSync(path.join(f.root, `rollout-${i}.jsonl`),
    line({ type: 'session_meta', payload: { id: `session-${i}`, source: 'cli', cwd: f.cwd } }) + line(event('task_started', f.at() + i)));
  for (let i = 0; i < 8; i++) await f.observer.run();
  assert.equal(f.observer.sessions.size, LIMITS.sessions); assert.equal(f.observer.snapshot().info.degraded, true);
  await f.observer.stop(); f.observer.nextDiscovery = 0; f.observer.start();
  const updates = f.updates.length; await f.observer.stop();
  assert.equal(f.updates.length, updates); assert.equal(f.observer.sessions.size, 0); assert.equal(f.observer.scanner, null);
});

test('same-size rewritten logs lose their old identity and are rediscovered without replaying results', async t => {
  const f = await fixture(t); await f.observer.run();
  const content = fs.readFileSync(f.file, 'utf8').replace('session-a', 'session-b');
  const before = fs.statSync(f.file);
  fs.writeFileSync(f.file, content); fs.utimesSync(f.file, before.atime, new Date(before.mtimeMs + 1000));
  await f.observer.run(); assert.equal(f.observer.sessions.size, 0);
  f.advance(1000); await f.observer.run();
  assert.equal(f.observer.snapshot().sessions[0].id, 'session-b');
});

test('metadata for a different workspace is excluded without exposing its directory or source body', async t => {
  const f = await fixture(t, 'cli', { workspace: path.resolve('work/other') });
  await f.observer.run();
  const status = JSON.stringify(f.observer.snapshot());
  assert.ok(!status.includes(f.cwd)); assert.ok(!status.includes('PRIVATE')); assert.equal(f.observer.snapshot().state, 'idle');
});

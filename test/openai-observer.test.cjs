const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { JsonMetadata } = require('../src/backends/json-metadata.cjs');
const { OpenaiObserver, Frames, summarize, stateOf, applyPatches, LIMITS, matchesWorkspace } = require('../src/backends/openai-observer.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await delay(5); }
}
function encode(value) { const body = Buffer.from(JSON.stringify(value)), head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]); }
function project(value, slice = 7) {
  const parser = new JsonMetadata({ questions: true }), buffer = Buffer.from(JSON.stringify(value));
  for (let i = 0; i < buffer.length; i += slice) parser.feed(buffer.subarray(i, i + slice));
  return parser.finish();
}
function state(status = 'inProgress') {
  return { threadRuntimeStatus: { type: status === 'inProgress' ? 'active' : 'idle', activeFlags: [] },
    turns: [{ turnId: 'turn-a', status, turnStartedAtMs: Date.now(), durationMs: null, items: [{ content: 'PRIVATE' }] }], requests: [] };
}
const question = (id, count = 1) => ({ type: 'agentMessage', id, text: 'PRIVATE_QUESTION_BODY',
  questions: Array.from({ length: count }, () => ({ title: 'PRIVATE_QUESTION', options: ['PRIVATE_OPTION'] })) });
const reply = (id, indices, extra = {}) => ({ type: 'userMessage', id: 'reply-' + id, content: [{ type: 'text',
  text: '<send_user_message_question_reply>' + JSON.stringify(indices.map(index => ({
    questionItemId: JSON.stringify(['request_user_input_async', id, index]), question: 'PRIVATE_QUESTION', answer: 'PRIVATE_ANSWER🐉',
  }))) + '</send_user_message_question_reply>' }], ...extra });
async function fixture(t, initial = state(), options = {}, hostId = 'local') {
  let now = Date.now(), socket, incoming = Buffer.alloc(0), revision = 0;
  const sent = [], updates = [], id = 'conversation-a';
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\dragon-openai-test-${randomUUID()}` : path.join(os.tmpdir(), `dragon-${randomUUID()}.sock`);
  const server = net.createServer(client => {
    socket = client; client.on('error', () => {});
    client.on('data', chunk => {
      incoming = Buffer.concat([incoming, chunk]);
      while (incoming.length >= 4 && incoming.length >= incoming.readUInt32LE(0) + 4) {
        const length = incoming.readUInt32LE(0), message = JSON.parse(incoming.subarray(4, length + 4)); incoming = incoming.subarray(length + 4); sent.push(message);
        if (message.method === 'initialize') {
          send({ type: 'response', method: 'initialize', requestId: message.requestId, resultType: 'success', result: { clientId: 'observer-id' } }); announce();
        } else if (message.method === 'thread-owner-discovery') {
          send({ type: 'response', method: message.method, requestId: message.requestId, resultType: 'success', handledByClientId: 'owner-id', result: {} });
        } else if (message.method === 'thread-stream-following-changed' && message.params.following) snapshot();
      }
    });
  });
  function send(value) { if (socket?.writable) socket.write(encode(value)); }
  function announce(conversationId = id) { send({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: 'owner-id', version: 1, params: { hostId, conversationId, following: true } }); }
  function snapshot() { send({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner-id', version: 11,
    params: { hostId, conversationId: id, change: { type: 'snapshot', revision, conversationState: initial } } }); }
  function patches(values, base = revision) { send({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner-id', version: 11,
    params: { hostId, conversationId: id, change: { type: 'patches', baseRevision: base, revision: ++revision, patches: values } } }); }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  const observer = new OpenaiObserver({ socketPath: endpoint, ...options }, value => updates.push(value), { now: () => now });
  t.after(async () => { await observer.stop(); socket?.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { observer, sent, updates, initial, snapshot, patches, announce, send, disconnect: () => socket.destroy(), advance: ms => { now += ms; observer.maintain(); } };
}
test('streaming projection skips multi-megabyte bodies and tool arguments with split UTF-8', () => {
  const filtered = project({ params: { change: { conversationState: { ...state(), title: 'PRIVATE_TITLE',
    turns: [{ status: 'inProgress', items: [{ content: '私密🐋'.repeat(300000) }], params: { input: 'PRIVATE_INPUT' } }] } } } }, 65535);
  assert.ok(JSON.stringify(filtered).length < 500); assert.ok(!JSON.stringify(filtered).includes('PRIVATE'));
  assert.equal(filtered.params.change.conversationState.turns[0].status, 'inProgress');
  assert.equal(project({ patches: [{ op: 'replace', path: ['turns', 0, 'items', 2, 'content'], value: 'x'.repeat(1000000) }] }, 16384).patches[0].value, undefined);
});
test('projection validates JSON grammar and rejects excessive metadata', () => {
  for (const text of ['{"type":}', '{"type":"x",}', '{"ignored":"bad\\q"}', '[1,]', '{} {}']) {
    assert.throws(() => { const parser = new JsonMetadata(); parser.feed(Buffer.from(text)); parser.finish(); });
  }
  assert.throws(() => project({ method: 'x'.repeat(300) }), /limit/);
  assert.throws(() => project({ params: { requests: Array.from({ length: 5000 }, () => ({ id: 'x' })) } }), /limit/);
});
test('split framing and canonical history preserve state without retaining message entities', () => {
  const messages = [], errors = [], reader = new Frames(message => messages.push(message), () => errors.push(true));
  for (const byte of Buffer.concat([encode({ type: 'broadcast', method: 'a' }), encode({ type: 'broadcast', method: 'b' })])) reader.feed(Buffer.from([byte]));
  assert.deepEqual(messages.map(message => message.method), ['a', 'b']); assert.equal(errors.length, 0);
  const summary = summarize(project({ threadRuntimeStatus: { type: 'idle' }, requests: [], turns: [], turnHistory: { kind: 'canonical', history: {
    entitiesByKey: { 'turn:a': { turnId: 'a', status: 'failed' }, 'turn:b': { turnId: 'b', status: 'completed' }, 'item:private': { content: 'PRIVATE' } },
    islands: [{ entries: [{ key: 'one', value: 'turn:a' }, { key: 'two', value: 'turn:b' }] }] } } }));
  assert.equal(summary.turn.turnId, 'b'); assert.equal(stateOf(summary), 'idle'); assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
});
test('live local protocol is read-only, retains summaries and stops without late callbacks', async t => {
  const f = await fixture(t); assert.equal(f.sent.length, 0); f.observer.start(); await until(() => f.observer.snapshot().state === 'running');
  assert.ok(!JSON.stringify([...f.observer.sessions.values()]).includes('PRIVATE'));
  assert.ok(f.sent.every(message => ['initialize', 'thread-owner-discovery', 'thread-stream-following-changed'].includes(message.method)));
  const count = f.updates.length; await f.observer.stop(); f.snapshot(); await delay(20);
  assert.equal(f.updates.length, count); assert.equal(f.observer.sessions.size, 0); assert.equal(f.observer.timer, null);
});
test('hosted chat protocol handles concurrent approvals and questions', async t => {
  const f = await fixture(t, state(), {}, 'chatgpt'); f.observer.start(); await until(() => f.observer.snapshot().state === 'running');
  f.patches([{ op: 'replace', path: ['requests'], value: [{ id: 'one', method: 'item/commandExecution/requestApproval' }, { id: 'two', method: 'item/tool/requestUserInput' }] }]);
  await until(() => f.observer.snapshot().state === 'waiting'); f.patches([{ op: 'remove', path: ['requests', 0] }]);
  await until(() => [...f.observer.sessions.values()][0].revision === 2); assert.equal(f.observer.snapshot().state, 'waiting');
  f.patches([{ op: 'replace', path: ['requests'], value: [] }]); await until(() => f.observer.snapshot().state === 'running');
});

test('async questions wait through partial replies and resume only after all accepted answers', async t => {
  const initial = state(); initial.turns[0].items = [question('ask-a', 2), question('ask-b')];
  const f = await fixture(t, initial); f.observer.start(); await until(() => f.observer.snapshot().state === 'waiting');
  f.patches([{ op: 'add', path: ['turns', 0, 'items', 2], value: reply('ask-a', [0]) }]);
  await until(() => [...f.observer.sessions.values()][0].revision === 1); assert.equal(f.observer.snapshot().state, 'waiting');
  f.patches([{ op: 'add', path: ['turns', 0, 'items', 3], value: reply('ask-b', [0], { type: 'steeringUserMessage',
    status: 'pending', input: reply('ask-b', [0]).content, content: undefined }) }]);
  f.patches([{ op: 'add', path: ['turns', 0, 'items', 4], value: reply('ask-a', [1]) }]);
  await until(() => [...f.observer.sessions.values()][0].revision === 3); assert.equal(f.observer.snapshot().state, 'waiting');
  f.patches([{ op: 'replace', path: ['turns', 0, 'items', 3, 'status'], value: 'accepted' }]);
  await until(() => f.observer.snapshot().state === 'running');
  f.patches([{ op: 'remove', path: ['turns', 0, 'items', 2] }]);
  await until(() => f.observer.snapshot().state === 'waiting');
  f.patches([{ op: 'replace', path: ['turns', 0, 'status'], value: 'completed' },
    { op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'idle' } }]);
  await until(() => f.observer.snapshot().state === 'review');
  assert.ok(!JSON.stringify([...f.observer.sessions.values()]).includes('PRIVATE'));
});

test('canonical async question patches and full turn replacements retain only bounded question metadata', () => {
  const history = { entitiesByKey: { 'turn:a': { turnId: 'a', status: 'inProgress', items: [] } },
    islands: [{ entries: [{ value: 'turn:a' }] }] };
  const summary = summarize(project({ threadRuntimeStatus: { type: 'active' }, turnHistory: { history } }));
  const patch = (path, value, op = 'add') => applyPatches(summary, project({ patches: [{ op, path, value }] }).patches);
  const root = ['turnHistory', 'history', 'entitiesByKey', 'turn:a', 'items'];
  patch([...root, 0], question('canonical', 2)); assert.equal(stateOf(summary), 'waiting');
  patch([...root, 0, 'questions'], [{ title: 'PRIVATE' }], 'replace');
  patch([...root, 1], reply('canonical', [0])); assert.equal(stateOf(summary), 'running');
  patch(root, [question('next')], 'replace'); assert.equal(stateOf(summary), 'waiting');
  patch(root, undefined, 'remove'); assert.equal(stateOf(summary), 'running');
  const legacy = summarize(project(state()));
  applyPatches(legacy, project({ patches: [{ op: 'replace', path: ['turns'], value: [{ turnId: 'b', status: 'inProgress', items: [question('legacy')] }] }] }).patches);
  assert.equal(stateOf(legacy), 'waiting');
  assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
});

test('real desktop tail turns without server IDs retain async questions through snapshots and patches', async t => {
  const key = 'tail:0:local:unassigned-turn';
  const initial = { threadRuntimeStatus: { type: 'active', activeFlags: [] }, turns: [], requests: [],
    turnHistory: { kind: 'canonical', history: { generation: 0,
      entitiesByKey: { [key]: { turnId: null, status: 'inProgress', items: [question('tail-question', 2)] },
        'item:private': { type: 'agentMessage', text: 'PRIVATE_EXCLUDED' } },
      islands: [{ id: 'tail:0', entries: [{ key, value: key }] }] } } };
  const f = await fixture(t, initial); f.observer.start(); await until(() => f.observer.snapshot().state === 'waiting');
  const session = () => [...f.observer.sessions.values()][0];
  assert.equal(session().summary.turn.key, key); assert.equal(session().summary.turn.turnId, null);
  const root = ['turnHistory', 'history', 'entitiesByKey', key];
  f.patches([{ op: 'replace', path: [...root, 'turnId'], value: 'server-turn-a' },
    { op: 'add', path: [...root, 'items', 1], value: reply('tail-question', [0]) }]);
  await until(() => session().revision === 1); assert.equal(f.observer.snapshot().state, 'waiting');
  assert.equal(session().summary.turn.turnId, 'server-turn-a');
  f.patches([{ op: 'add', path: [...root, 'items', 2], value: reply('tail-question', [1]) }]);
  await until(() => f.observer.snapshot().state === 'running');
  f.patches([{ op: 'replace', path: [...root, 'items'], value: [question('next-tail-question')] }]);
  await until(() => f.observer.snapshot().state === 'waiting');
  f.patches([{ op: 'replace', path: [...root, 'status'], value: 'completed' },
    { op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'idle' } }]);
  await until(() => f.observer.snapshot().state === 'review');
  assert.ok(!JSON.stringify([...f.observer.sessions.values()]).includes('PRIVATE'));
});

test('async projection skips huge messages and reply text; historical and malformed replies cannot settle questions', () => {
  const initial = state();
  const answer = reply('large', [0]);
  answer.content[0].text = answer.content[0].text.replace('PRIVATE_ANSWER🐉', '私密🐉'.repeat(200000));
  initial.turns[0].items = [...Array.from({ length: 5000 }, (_, i) => ({ type: 'agentMessage', id: 'body-' + i, text: 'PRIVATE' })),
    question('large'), answer];
  const filtered = project(initial, 31), summary = summarize(filtered);
  assert.equal(stateOf(summary), 'running'); assert.ok(JSON.stringify(filtered).length < 1000);
  assert.ok(!JSON.stringify(filtered).includes('PRIVATE')); assert.ok(!JSON.stringify(filtered).includes('私密'));
  for (const suffix of ['junk', '']) {
    initial.turns[0].items = [question('large'), reply('other-turn', [0])];
    initial.turns[0].items[1].content[0].text += suffix;
    assert.equal(stateOf(summarize(project(initial))), 'waiting');
  }
  initial.turns[0].items = [question('large'), reply('large', [0])];
  initial.turns[0].items[1].content[0].text += 'junk';
  assert.equal(stateOf(summarize(project(initial))), 'waiting');
  initial.turns[0].status = 'completed'; initial.threadRuntimeStatus.type = 'idle';
  assert.equal(stateOf(summarize(project(initial))), 'idle');
  initial.turns[0].items = Array.from({ length: 65 }, (_, i) => question('limit-' + i));
  assert.throws(() => project(initial), /limit/);
});
test('completion expires; historical completion is not replayed; failure differs from interruption', async t => {
  const f = await fixture(t); f.observer.start(); await until(() => f.observer.snapshot().state === 'running');
  f.patches([{ op: 'replace', path: ['turns', 0, 'status'], value: 'completed' }, { op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'idle' } }]);
  await until(() => f.observer.snapshot().state === 'review'); f.advance(4001); assert.equal(f.observer.snapshot().state, 'idle');
  const old = state('completed'); old.turns[0].turnStartedAtMs = Date.now() - 100000; old.turns[0].durationMs = 100;
  const g = await fixture(t, old); g.observer.start(); await until(() => g.observer.snapshot().info.count === 1); assert.equal(g.observer.snapshot().state, 'idle');
  assert.equal(g.observer.snapshot().sessions[0].completedAt, old.turns[0].turnStartedAtMs + old.turns[0].durationMs);
  const summary = summarize(state());
  applyPatches(summary, [{ op: 'replace', path: ['turns', 0, 'status'], value: 'failed' }, { op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'idle' } }]);
  assert.equal(stateOf(summary), 'failed'); summary.turn.status = 'interrupted'; assert.equal(stateOf(summary), 'idle');
});
test('revision gaps request fresh snapshots', async t => {
  const f = await fixture(t); f.observer.start(); await until(() => f.observer.snapshot().state === 'running');
  f.patches([{ op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'systemError' } }], 999);
  await until(() => [...f.observer.sessions.values()][0].refreshAt); assert.equal(f.observer.snapshot().state, 'idle'); f.advance(1001);
  await until(() => f.observer.snapshot().state === 'running');
  assert.equal(f.sent.filter(message => message.params?.following).length, 2);
});

test('message completion metadata removals keep real desktop tail turns subscribed for later approvals', async t => {
  const key = 'tail:0:local:approval-turn';
  const initial = { threadRuntimeStatus: { type: 'active', activeFlags: [] }, turns: [], requests: [],
    turnHistory: { kind: 'canonical', history: { entitiesByKey: { [key]: { turnId: 'approval-turn', status: 'inProgress',
      items: [{ type: 'agentMessage', id: 'message-one', text: 'PRIVATE' }], completedItemIds: { 'message-one': true },
      agentMessageCompletedAtMsById: { 'message-one': 1 } } }, islands: [{ entries: [{ value: key }] }] } } };
  const f = await fixture(t, initial); f.observer.start(); await until(() => f.observer.snapshot().state === 'running');
  const root = ['turnHistory', 'history', 'entitiesByKey', key];
  for (let i = 0; i < 5; i++) f.patches([
    { op: 'remove', path: [...root, 'completedItemIds', 'message-one'] },
    { op: 'remove', path: [...root, 'agentMessageCompletedAtMsById'] },
    { op: 'remove', path: [...root, 'itemTimingsById', 'message-one'] },
  ]);
  await until(() => [...f.observer.sessions.values()][0].revision === 5);
  f.patches([{ op: 'add', path: ['requests', 0], value: { id: 123, method: 'item/permissions/requestApproval', params: { reason: 'PRIVATE' } } }]);
  await until(() => f.observer.snapshot().state === 'waiting');
  f.patches([{ op: 'remove', path: ['requests', 0] }]); await until(() => f.observer.snapshot().state === 'running');
  assert.equal(f.observer.snapshot().info.degraded, false);
  assert.equal(f.sent.filter(message => message.params?.following === true).length, 1);
  assert.ok(!JSON.stringify([...f.observer.sessions.values()]).includes('PRIVATE'));
  const legacy = summarize(project(state()));
  assert.doesNotThrow(() => applyPatches(legacy, [{ op: 'remove', path: ['turns', 0, 'completedItemIds', 'old'] }]));
  assert.throws(() => applyPatches(legacy, [{ op: 'remove', path: ['turns', 0] }]), /turn-removal/);
});

test('patches arriving during snapshot recovery do not exhaust the resync budget or block later approvals', async t => {
  const f = await fixture(t); f.observer.start(); await until(() => f.observer.snapshot().state === 'running');
  f.patches([{ op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'active' } }], 999);
  await until(() => [...f.observer.sessions.values()][0].refreshAt);
  for (let i = 0; i < 6; i++) f.patches([{ op: 'replace', path: ['turns', 0, 'status'], value: 'inProgress' }]);
  await delay(30);
  assert.equal([...f.observer.sessions.values()][0].resyncCount, 1);
  assert.equal(f.observer.snapshot().info.degraded, false);
  f.advance(1001); await until(() => f.observer.snapshot().state === 'running');
  f.patches([{ op: 'add', path: ['requests', 0], value: { id: 'after-recovery', method: 'item/commandExecution/requestApproval' } }]);
  await until(() => f.observer.snapshot().state === 'waiting');
  assert.equal(f.observer.snapshot().info.degraded, false);
});
test('unsupported versions unsubscribe and degrade without revealing payloads', async t => {
  const f = await fixture(t); f.observer.start(); await until(() => f.observer.snapshot().state === 'running');
  f.send({ type: 'broadcast', method: 'thread-stream-state-changed', version: 999, sourceClientId: 'owner-id', params: { hostId: 'local', conversationId: 'conversation-a', change: { type: 'snapshot', revision: 1, conversationState: { PRIVATE: 'PRIVATE' } } } });
  await until(() => f.observer.snapshot().info.degraded); assert.equal(f.observer.snapshot().state, 'idle');
  await until(() => f.sent.some(message => message.params?.following === false)); assert.ok(!JSON.stringify(f.updates).includes('PRIVATE'));
});
test('discovery stays bounded; disconnect clears running state', async t => {
  const f = await fixture(t); f.observer.start(); await until(() => f.observer.snapshot().state === 'running');
  for (let i = 0; i < LIMITS.sessions + 2; i++) f.announce(`extra-${i}`);
  await until(() => f.observer.snapshot().info.degraded); assert.equal(f.observer.sessions.size, LIMITS.sessions);
  f.disconnect(); await until(() => !f.observer.snapshot().info.connected); assert.equal(f.observer.snapshot().state, 'idle');
});
test('runtime unload clears an unfinished turn; stale revisions cannot restore it', async t => {
  const f = await fixture(t); f.observer.start(); await until(() => f.observer.snapshot().state === 'running');
  f.patches([{ op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'notLoaded' } }]);
  await until(() => [...f.observer.sessions.values()][0].revision === 1); assert.equal(f.observer.snapshot().state, 'idle');
  f.send({ type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'owner-id', params: { hostId: 'local', conversationId: 'conversation-a', change: { type: 'snapshot', revision: 0, conversationState: state() } } });
  await delay(20); assert.equal(f.observer.snapshot().state, 'idle');
});
test('waiting gets a separate one-hour deadline and a partial frame times out', async t => {
  const initial = state(); initial.requests = [{ id: 'approval', method: 'item/fileChange/requestApproval' }];
  const f = await fixture(t, initial); f.observer.start(); await until(() => f.observer.snapshot().state === 'waiting');
  f.advance(601000); assert.equal(f.observer.snapshot().state, 'waiting');
  f.advance(3000000); assert.equal(f.observer.snapshot().state, 'idle');
  // Simulate a peer that never finishes a frame without allocating its declared size.
  f.observer.frames.feed(Buffer.from([100, 0])); f.advance(5001);
  await until(() => !f.observer.snapshot().info.connected);
  assert.equal(f.observer.snapshot().info.degraded, true);
});
test('live runtime errors show immediately while active runtime overrides old failed history', async t => {
  const initial = state('failed'); initial.threadRuntimeStatus = { type: 'systemError' };
  const f = await fixture(t, initial); f.observer.start(); await until(() => f.observer.snapshot().state === 'failed');
  initial.threadRuntimeStatus = { type: 'active' }; assert.equal(stateOf(summarize(initial)), 'running');
});
test('workspace matches only local absolute directories with proper path boundaries', () => {
  const root = path.join(os.tmpdir(), 'dragon-project');
  const session = cwd => ({ hostId: 'local', summary: { cwd } });
  assert.equal(matchesWorkspace(session(root), root), true);
  assert.equal(matchesWorkspace(session(path.join(root, 'child')), root), true);
  assert.equal(matchesWorkspace(session(root + '-neighbor'), root), false);
  assert.equal(matchesWorkspace(session('child'), root), false);
  assert.equal(matchesWorkspace(session(''), root), false);
  assert.equal(matchesWorkspace({ hostId: 'chatgpt', summary: { cwd: root } }, root), false);
  assert.equal(matchesWorkspace({ hostId: 'chatgpt', summary: {} }, ''), true);
  if (process.platform === 'win32') {
    assert.equal(matchesWorkspace(session(root.toUpperCase()), root.toLowerCase()), true);
    assert.equal(matchesWorkspace(session('/home/dragon-project'), root), false);
  }
});
test('streamed cwd supports the settings path length while other metadata stays limited', () => {
  const cwd = path.join(os.tmpdir(), '项目'.repeat(160));
  const snapshot = project({ ...state(), cwd }, 13);
  assert.equal(snapshot.cwd, cwd);
  const patch = project({ patches: [{ op: 'replace', path: ['cwd'], value: cwd }] }, 17);
  const summary = summarize(state()); applyPatches(summary, patch.patches); assert.equal(summary.cwd, cwd);
  assert.throws(() => project({ ...state(), cwd: 'x'.repeat(1001) }), /limit/);
});
test('workspace filtering follows directory patches and never exposes paths in status IPC', async t => {
  const root = path.join(os.tmpdir(), 'dragon-project');
  const initial = { ...state(), cwd: path.join(root, 'child') };
  const f = await fixture(t, initial, { workspace: root }); f.observer.start();
  await until(() => f.observer.snapshot().state === 'running'); assert.equal(f.observer.snapshot().info.count, 1);
  f.patches([{ op: 'replace', path: ['requests'], value: [{ id: 'ask', method: 'item/tool/requestUserInput' }] }]);
  await until(() => f.observer.snapshot().state === 'waiting');
  f.patches([{ op: 'replace', path: ['cwd'], value: root + '-neighbor' }]);
  await until(() => [...f.observer.sessions.values()][0].revision === 2);
  assert.equal(f.observer.snapshot().state, 'idle'); assert.equal(f.observer.snapshot().info.count, 0);
  assert.equal(f.observer.snapshot().info.degraded, false);
  assert.ok(f.observer.snapshot().info.message.includes('匹配工作区'));
  f.patches([{ op: 'replace', path: ['cwd'], value: root }]); await until(() => f.observer.snapshot().state === 'waiting');
  f.patches([{ op: 'remove', path: ['cwd'] }]); await until(() => [...f.observer.sessions.values()][0].revision === 4);
  assert.equal(f.observer.snapshot().state, 'idle');
  f.patches([{ op: 'replace', path: [], value: initial }]); await until(() => f.observer.snapshot().state === 'running');
  assert.ok(!JSON.stringify(f.updates).includes('dragon-project'));
});
test('scoped workspaces exclude ordinary chats without a directory and hosted paths', async t => {
  const root = path.join(os.tmpdir(), 'dragon-project');
  for (const hostId of ['local', 'chatgpt']) {
    const f = await fixture(t, hostId === 'local' ? state() : { ...state(), cwd: root }, { workspace: root }, hostId);
    f.observer.start(); await until(() => [...f.observer.sessions.values()][0]?.summary);
    assert.equal(f.observer.snapshot().info.count, 0); assert.equal(f.observer.snapshot().state, 'idle');
  }
});
test('out-of-workspace approvals cannot override an in-workspace running task', async t => {
  const root = path.join(os.tmpdir(), 'dragon-project');
  const f = await fixture(t, { ...state(), cwd: root }, { workspace: root }); f.observer.start();
  await until(() => f.observer.snapshot().state === 'running'); f.announce('outside');
  await until(() => f.observer.sessions.get('local:outside')?.owner);
  f.send({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner-id', version: 11,
    params: { hostId: 'local', conversationId: 'outside', change: { type: 'snapshot', revision: 0,
      conversationState: { ...state(), cwd: root + '-neighbor', requests: [{ id: 'ask', method: 'item/tool/requestUserInput' }] } } } });
  await until(() => f.observer.sessions.get('local:outside')?.summary);
  assert.equal(f.observer.snapshot().state, 'running'); assert.equal(f.observer.snapshot().info.count, 1);
});

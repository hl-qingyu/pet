// Local protocol fixture for Electron smoke tests; never used in normal startup.
const net = require('node:net');
function frame(value) {
  const body = Buffer.from(JSON.stringify(value)), head = Buffer.alloc(4); head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}
async function createOpenaiFixture(endpoint, { hostId = 'chatgpt', cwd = '' } = {}) {
  const clients = new Set(); let revision = 0, startedAt = Date.now();
  const state = { cwd, threadRuntimeStatus: { type: 'active', activeFlags: [] }, requests: [],
    turns: [{ turnId: 'smoke-turn', status: 'inProgress', turnStartedAtMs: startedAt, durationMs: null, items: [{ content: 'PRIVATE_SMOKE_TEXT' }] }] };
  const send = (socket, value) => { if (socket.writable) socket.write(frame(value)); };
  const snapshot = socket => send(socket, { type: 'broadcast', sourceClientId: 'smoke-owner', method: 'thread-stream-state-changed', version: 11,
    params: { hostId, conversationId: 'smoke-chat', change: { type: 'snapshot', revision, conversationState: state } } });
  const server = net.createServer(socket => {
    clients.add(socket); let rest = Buffer.alloc(0);
    socket.on('close', () => clients.delete(socket)); socket.on('error', () => {});
    socket.on('data', chunk => {
      rest = Buffer.concat([rest, chunk]);
      while (rest.length >= 4 && rest.length >= rest.readUInt32LE(0) + 4) {
        const length = rest.readUInt32LE(0), message = JSON.parse(rest.subarray(4, length + 4)); rest = rest.subarray(length + 4);
        if (message.method === 'initialize') {
          send(socket, { type: 'response', requestId: message.requestId, method: 'initialize', resultType: 'success', result: { clientId: 'smoke-observer' } });
          send(socket, { type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: 'smoke-owner', version: 1,
            params: { hostId, conversationId: 'smoke-chat', following: true } });
        } else if (message.method === 'thread-owner-discovery') send(socket, { type: 'response', requestId: message.requestId, method: message.method, resultType: 'success', handledByClientId: 'smoke-owner', result: {} });
        else if (message.method === 'thread-stream-following-changed' && message.params.following) snapshot(socket);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  return { clients, state, update(type, pending = []) {
    revision++; state.threadRuntimeStatus = { type: type === 'failed' ? 'systemError' : type === 'completed' ? 'idle' : 'active', activeFlags: [] };
    state.requests = pending.map(id => ({ id, method: 'item/tool/requestUserInput' }));
    if (type === 'running' && state.turns[0].status !== 'inProgress') startedAt = Date.now();
    Object.assign(state.turns[0], { status: type === 'failed' ? 'failed' : type === 'completed' ? 'completed' : 'inProgress', turnStartedAtMs: startedAt,
      durationMs: ['failed', 'completed'].includes(type) ? Date.now() - startedAt : null });
    for (const client of clients) snapshot(client);
  }, async close() { for (const client of clients) client.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createOpenaiFixture };

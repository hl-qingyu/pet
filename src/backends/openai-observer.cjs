const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const { JsonMetadata } = require('./json-metadata.cjs');

const LIMITS = Object.freeze({ frame: 16 * 1024 * 1024, chunk: 64 * 1024, sessions: 32, requests: 32, timeout: 5000 });
const RANK = { idle: 0, review: 1, failed: 2, running: 3, waiting: 4 };
const WORDS = { running: 'ChatGPT 正在处理……', waiting: 'ChatGPT 正在等你确认……', review: '这一步完成了。', failed: '这一步没有完成。' };
const safeId = value => typeof value === 'string' && /^[\w:./-]{1,128}$/.test(value);
const needsInput = request => /requestApproval|requestUserInput|elicitation|planImplementation/i.test(request?.method || '') && request.completedAtMs == null;
const turnFields = new Set(['status', 'turnId', 'turnStartedAtMs', 'durationMs', 'error']);
function cwdOf(value) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > 1000) throw new Error('cwd-layout');
  return value;
}
function matchesWorkspace(session, workspace) {
  if (!workspace) return true;
  const cwd = session.summary?.cwd;
  if (session.hostId !== 'local' || !cwd || !path.isAbsolute(cwd)) return false;
  // Windows considers /home and \project rooted, but they have no local drive.
  // Do not accidentally turn an unknown/remote path into the current drive.
  if (process.platform === 'win32' && /^[\\/]$/.test(path.parse(cwd).root)) return false;
  const relative = path.relative(path.resolve(workspace), path.normalize(cwd));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function compactTurn(turn, key, index) {
  if (!turn || typeof turn !== 'object') return null;
  return { key, index, status: turn.status, turnId: turn.turnId, turnStartedAtMs: turn.turnStartedAtMs,
    durationMs: turn.durationMs, error: Boolean(turn.error) };
}
function requests(value) {
  if (!Array.isArray(value) || value.length > LIMITS.requests) throw new Error('request-limit');
  return value.map(request => ({ id: request?.id, method: request?.method, completedAtMs: request?.completedAtMs }));
}
function runtime(value) {
  if (value == null) return null;
  if (!['active', 'idle', 'notLoaded', 'systemError'].includes(value.type) ||
    (value.activeFlags != null && (!Array.isArray(value.activeFlags) || value.activeFlags.length > 16 ||
      value.activeFlags.some(flag => typeof flag !== 'string' || flag.length > 64)))) throw new Error('runtime-layout');
  return { type: value.type, activeFlags: value.activeFlags?.slice() || [] };
}
function summarize(state) {
  if (!state || typeof state !== 'object') throw new Error('snapshot-layout');
  const history = state.turnHistory?.history;
  const islands = history?.islands, entityKey = islands?.at(-1)?.entries?.at(-1)?.value;
  const turn = entityKey != null ? compactTurn(history.entitiesByKey?.[entityKey], entityKey) :
    compactTurn(state.turns?.at(-1), null, (state.turns?.length || 0) - 1);
  const result = { runtime: runtime(state.threadRuntimeStatus), turn, cwd: cwdOf(state.cwd),
    requests: requests(state.requests || []), externalRequests: requests(state.externalRequests || []),
    pending: state.unconfirmedTurnSubmissions?.some(item => item.terminal !== true) || false };
  if (!result.runtime && !result.turn) throw new Error('missing-status');
  return result;
}
function stateOf(summary) {
  const flags = summary.runtime?.activeFlags || [];
  if (summary.runtime?.type === 'notLoaded') return 'idle';
  if (summary.runtime?.type === 'systemError') return 'failed';
  if (flags.some(flag => /waiting.*(?:approval|input|question)/i.test(flag)) ||
    [...summary.requests, ...summary.externalRequests].some(needsInput)) return 'waiting';
  if (summary.runtime?.type === 'active' || summary.pending) return 'running';
  if (summary.turn?.status === 'failed') return 'failed';
  if (summary.turn?.status === 'inProgress') return 'running';
  if (summary.turn?.status === 'interrupted') return 'idle';
  if (summary.runtime && ['idle', 'notLoaded'].includes(summary.runtime.type)) return 'idle';
  if (summary.turn?.status === 'completed') return 'idle';
  throw new Error('status-layout');
}
function applyPatches(summary, patches) {
  if (!Array.isArray(patches) || patches.length > 512) throw new Error('patch-limit');
  for (const patch of patches) {
    const p = patch.path;
    if (!Array.isArray(p) || p.length > 32 || !['add', 'remove', 'replace'].includes(patch.op)) throw new Error('patch-layout');
    if (p.some(part => ['items', 'content', 'input', 'params', 'title', 'text', 'summary', 'acceptedTextChanges'].includes(part))) continue;
    const value = patch.value;
    if (p.length === 0) { Object.assign(summary, summarize(value)); continue; }
    if (p[0] === 'cwd') {
      if (p.length !== 1) throw new Error('cwd-patch');
      summary.cwd = patch.op === 'remove' ? '' : cwdOf(value);
    } else if (p[0] === 'threadRuntimeStatus') {
      if (p.length === 1) summary.runtime = runtime(value);
      else if (p.length === 2 && p[1] === 'type') summary.runtime = runtime({ ...summary.runtime, type: value });
      else if (p[1] === 'activeFlags') {
        if (!summary.runtime) throw new Error('missing-runtime');
        if (p.length === 2) summary.runtime = runtime({ ...summary.runtime, activeFlags: value });
        else {
          const index = p[2]; if (!Number.isInteger(index) || index < 0 || index > 16) throw new Error('flag-index');
          if (patch.op === 'remove') summary.runtime.activeFlags.splice(index, 1);
          else summary.runtime.activeFlags[index] = value;
          summary.runtime = runtime(summary.runtime);
        }
      } else throw new Error('runtime-patch');
    } else if (['requests', 'externalRequests'].includes(p[0])) {
      const key = p[0], index = p[1];
      if (p.length === 1) { summary[key] = requests(value); continue; }
      if (!Number.isInteger(index) || index < 0 || index > summary[key].length || index >= LIMITS.requests) throw new Error('request-index');
      if (p.length === 2) {
        if (patch.op === 'remove') summary[key].splice(index, 1);
        else if (patch.op === 'add') summary[key].splice(index, 0, requests([value])[0]);
        else summary[key][index] = requests([value])[0];
      } else if (p.length === 3 && ['id', 'method', 'completedAtMs'].includes(p[2]) && summary[key][index]) summary[key][index][p[2]] = value;
      else throw new Error('request-patch');
    } else if (p[0] === 'unconfirmedTurnSubmissions') {
      if (p.length !== 1 || !Array.isArray(value)) throw new Error('submission-patch');
      summary.pending = value.some(item => item.terminal !== true);
    } else if (p[0] === 'turns') {
      if (p.length === 1) { if (!Array.isArray(value)) throw new Error('turns-layout'); summary.turn = compactTurn(value.at(-1), null, value.length - 1); }
      else if (p.length === 2 && patch.op !== 'remove') {
        if (!summary.turn || p[1] >= summary.turn.index) summary.turn = compactTurn(value, null, p[1]);
      } else if (p[1] === summary.turn?.index && p.length === 3 && turnFields.has(p[2])) summary.turn[p[2]] = p[2] === 'error' ? Boolean(value) : value;
      else if (patch.op === 'remove') throw new Error('turn-removal');
    } else if (p[0] === 'turnHistory') {
      if (p.length === 1) { const updated = summarize({ turnHistory: value, turns: [], requests: [], threadRuntimeStatus: summary.runtime }); summary.turn = updated.turn; }
      else if (p.length === 2 && p[1] === 'history') summary.turn = summarize({ turnHistory: { history: value }, threadRuntimeStatus: summary.runtime }).turn;
      else if (p[1] === 'history' && p[2] === 'entitiesByKey') {
        const key = p[3];
        if (p.length === 4 && patch.op !== 'remove') {
          const turn = compactTurn(value, key);
          if (turn && (!summary.turn || key === summary.turn.key || turn.turnStartedAtMs >= summary.turn.turnStartedAtMs)) summary.turn = turn;
        } else if (key === summary.turn?.key) {
          if (p.length === 5 && turnFields.has(p[4])) summary.turn[p[4]] = p[4] === 'error' ? Boolean(value) : value;
          else if (patch.op === 'remove') throw new Error('turn-removal');
        }
      }
    }
  }
  return summary;
}

class Frames {
  constructor(onMessage, onFault, now = Date.now) { this.onMessage = onMessage; this.onFault = onFault; this.now = now; this.header = Buffer.alloc(4); this.headerUsed = 0; this.remaining = 0; }
  feed(buffer) {
    let position = 0;
    while (position < buffer.length) {
      if (!this.remaining) {
        if (!this.headerUsed) this.startedAt = this.now();
        const count = Math.min(4 - this.headerUsed, buffer.length - position);
        buffer.copy(this.header, this.headerUsed, position, position + count); this.headerUsed += count; position += count;
        if (this.headerUsed < 4) return;
        this.headerUsed = 0; this.remaining = this.header.readUInt32LE(); this.fault = false; this.parser = new JsonMetadata();
        if (!this.remaining || this.remaining > LIMITS.frame) { this.fault = true; this.onFault(); }
        if (!this.remaining) throw new Error('zero-frame');
      }
      const count = Math.min(this.remaining, buffer.length - position, LIMITS.chunk);
      if (!this.fault) {
        try { this.parser.feed(buffer.subarray(position, position + count)); }
        catch { this.fault = true; this.onFault(this.parser.result); this.parser = null; }
      }
      this.remaining -= count; position += count;
      if (!this.remaining && !this.fault) {
        try { const message = this.parser.finish(); this.parser = null; this.onMessage(message); }
        catch { this.onFault(); }
      }
      if (!this.remaining) this.startedAt = null;
    }
  }
}

class OpenaiObserver {
  constructor(options = {}, onUpdate = () => {}, { now = Date.now, connect = endpoint => net.createConnection(endpoint) } = {}) {
    this.options = { showBubble: true, activeSeconds: 600, workspace: '', ...options }; this.onUpdate = onUpdate; this.now = now; this.connect = connect;
    this.endpoint = options.socketPath || (process.platform === 'win32' ? '\\\\.\\pipe\\codex-ipc' :
      path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ipc', 'ipc.sock'));
    this.sessions = new Map(); this.active = false; this.ready = false; this.generation = 0; this.last = ''; this.counter = 0;
    this.retryAt = 0; this.queue = []; this.warning = ''; this.stopping = Promise.resolve();
  }
  start() {
    if (this.active) return;
    this.active = true; this.maintain(); this.timer = setInterval(() => this.maintain(), 1000); this.timer.unref?.();
  }
  stop() {
    this.active = false; ++this.generation; clearInterval(this.timer); this.timer = null;
    this.queue = []; this.pending = null; this.ready = false; this.clientId = null; this.sessions.clear();
    const socket = this.socket; this.socket = null; this.frames = null;
    if (socket && !socket.closed) this.stopping = new Promise(resolve => { socket.once('close', resolve); socket.destroy(); });
    return this.stopping;
  }
  send(message) {
    if (!this.active || !this.socket?.writable) return;
    if (this.socket.writableLength > LIMITS.chunk) { this.warning = '状态通道写入积压'; this.socket.destroy(); return; }
    const body = Buffer.from(JSON.stringify(message)), head = Buffer.alloc(4); head.writeUInt32LE(body.length);
    // All outgoing frames are tiny status/discovery messages, never user input.
    this.socket.write(Buffer.concat([head, body]));
  }
  following(session, value) {
    this.send({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: this.clientId,
      targetClientIds: [session.owner], version: 1, params: { hostId: session.hostId, conversationId: session.id, following: value } });
  }
  open() {
    const generation = ++this.generation;
    this.connectedAt = this.now(); this.warning = ''; this.ready = false;
    let socket;
    try { socket = this.connect(this.endpoint); } catch { this.retryAt = this.now() + 5000; return; }
    this.socket = socket;
    const current = () => this.active && this.generation === generation && this.socket === socket;
    this.frames = new Frames(message => { if (current()) this.message(message); }, partial => { if (current()) this.fault(partial); }, this.now);
    socket.on('connect', () => { if (current()) this.send({ type: 'request', requestId: 'initialize', sourceClientId: 'initializing-client', method: 'initialize', version: 0, params: { clientType: 'dragon-desk-observer' } }); });
    socket.on('data', chunk => { if (current()) { try { this.frames.feed(chunk); } catch { this.warning = '状态通道格式不受支持'; socket.destroy(); } } });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (!current()) return;
      this.socket = null; this.frames = null; this.ready = false; this.clientId = null; this.pending = null;
      this.queue = []; this.sessions.clear(); this.retryAt = this.now() + 5000; this.publish();
    });
  }
  fault(partial) {
    this.warning = '状态读取降级：布局、版本或资源超限';
    const p = partial?.params, session = p && this.sessions.get(`${p.hostId}:${p.conversationId}`);
    if (session) { session.summary = null; session.state = 'idle'; session.blocked = true; if (session.owner) this.following(session, false); }
    else for (const session of this.sessions.values()) { session.summary = null; session.state = 'idle'; session.blocked = true; if (session.owner) this.following(session, false); }
    this.publish();
  }
  discover(params) {
    if (!safeId(params?.conversationId) || !safeId(params.hostId)) return;
    const key = `${params.hostId}:${params.conversationId}`;
    if (this.sessions.has(key)) return;
    if (this.sessions.size >= LIMITS.sessions) {
      this.warning = '会话数量超过资源上限，优先近期会话';
      const oldest = [...this.sessions.entries()].filter(([key, item]) => item.owner &&
        (!['running', 'waiting'].includes(item.state) || (item.summary && !matchesWorkspace(item, this.options.workspace))) &&
        this.pending?.key !== key).sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) { this.publish(); return; }
      this.following(oldest[1], false); this.sessions.delete(oldest[0]); this.queue = this.queue.filter(key => key !== oldest[0]);
    }
    this.sessions.set(key, { id: params.conversationId, hostId: params.hostId, state: 'idle', at: this.now(), revision: -1, summary: null });
    this.queue.push(key); this.pump();
  }
  pump() {
    if (!this.ready || this.pending || !this.queue.length) return;
    const key = this.queue.shift(), session = this.sessions.get(key);
    if (!session) { this.pump(); return; }
    const requestId = `owner-${++this.counter}`;
    this.pending = { key, requestId, deadline: this.now() + LIMITS.timeout };
    this.send({ type: 'request', requestId, sourceClientId: this.clientId, method: 'thread-owner-discovery', version: 1,
      params: { hostId: session.hostId, conversationId: session.id }, timeoutMs: LIMITS.timeout });
  }
  message(message) {
    if (message.type === 'client-discovery-request') {
      this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } }); return;
    }
    if (message.type === 'response') {
      if (message.requestId === 'initialize' && message.resultType === 'success' && safeId(message.result?.clientId)) {
        this.clientId = message.result.clientId; this.ready = true; this.pump(); this.publish();
      } else if (message.requestId === this.pending?.requestId) {
        const session = this.sessions.get(this.pending.key); this.pending = null;
        if (session && message.resultType === 'success' && safeId(message.handledByClientId)) {
          session.owner = message.handledByClientId; session.snapshotAt = this.now(); this.following(session, true);
        } else if (session) this.sessions.delete(`${session.hostId}:${session.id}`);
        this.pump();
      }
      return;
    }
    if (message.type !== 'broadcast' || message.sourceClientId === this.clientId) return;
    if (message.method === 'thread-stream-following-changed' && message.params?.following) { this.discover(message.params); return; }
    if (message.method === 'client-status-changed' && message.params?.status === 'disconnected') {
      for (const [key, session] of this.sessions) if (session.owner === message.params.clientId) this.sessions.delete(key);
      this.publish(); return;
    }
    if (message.method !== 'thread-stream-state-changed') return;
    const p = message.params, session = p && this.sessions.get(`${p.hostId}:${p.conversationId}`);
    if (!session || session.blocked || session.owner !== message.sourceClientId) return;
    if (message.version !== 11) { this.fault(message); return; }
    try {
      const change = p.change;
      if (!Number.isSafeInteger(change?.revision) || change.revision < 0) throw new Error('revision');
      if (change.revision < session.revision || (change.type === 'patches' && change.revision === session.revision)) return;
      if (change.type === 'snapshot') session.summary = summarize(change.conversationState);
      else if (change.type === 'patches' && session.summary && change.baseRevision === session.revision) applyPatches(session.summary, change.patches);
      else { this.resnapshot(session); return; }
      const previous = session.state, next = stateOf(session.summary), now = this.now();
      const turn = session.summary.turn;
      const completedAt = Number.isFinite(turn?.turnStartedAtMs) && Number.isFinite(turn?.durationMs) ? turn.turnStartedAtMs + turn.durationMs : 0;
      const recentCompletion = completedAt > 0 && completedAt <= now + 300000 && now - completedAt < 4000;
      session.state = next;
      if (next === 'idle' && session.summary.runtime?.type !== 'notLoaded' && turn?.status !== 'interrupted' &&
        (['running', 'waiting'].includes(previous) || recentCompletion || (previous === 'review' && now - session.at < 4000))) session.state = 'review';
      if (next === 'failed' && session.summary.runtime?.type !== 'systemError' && previous === 'idle' &&
        (completedAt === 0 || now - completedAt >= 4000) && change.type === 'snapshot') session.state = 'idle';
      // Body-only patches must not extend a completion bubble indefinitely.
      if (session.state !== previous) session.at = ['review', 'failed'].includes(session.state) && session.summary.runtime?.type !== 'systemError' && change.type === 'snapshot' && completedAt ? Math.min(completedAt, now) : now;
      if (['running', 'waiting'].includes(session.state)) session.at = now;
      session.revision = change.revision; session.snapshotAt = null; session.refreshAt = null; session.refreshes = 0;
      this.publish();
    } catch { this.resnapshot(session); }
  }
  resnapshot(session) {
    const now = this.now();
    if (!session.resyncSince || now - session.resyncSince >= 60000) { session.resyncSince = now; session.resyncCount = 0; }
    session.resyncCount = (session.resyncCount || 0) + 1;
    if (session.resyncCount > 3) { this.fault({ params: { hostId: session.hostId, conversationId: session.id } }); return; }
    session.refreshes = (session.refreshes || 0) + 1;
    if (session.refreshes > 2) { this.fault({ params: { hostId: session.hostId, conversationId: session.id } }); return; }
    session.summary = null; session.state = 'idle';
    if (!session.refreshAt) session.refreshAt = this.now() + 1000;
    this.publish();
  }
  maintain() {
    if (!this.active) return;
    const now = this.now();
    if (!this.socket && now >= this.retryAt) this.open();
    if (this.socket && !this.ready && now - this.connectedAt >= LIMITS.timeout) this.socket.destroy();
    if (this.socket && this.frames?.startedAt != null && now - this.frames.startedAt >= LIMITS.timeout) {
      this.warning = '状态数据接收超时'; this.socket.destroy();
    }
    if (this.pending && now >= this.pending.deadline) { this.sessions.delete(this.pending.key); this.pending = null; this.pump(); }
    for (const session of this.sessions.values()) {
      if (session.refreshAt && now >= session.refreshAt) { session.refreshAt = null; session.snapshotAt = now; this.following(session, true); }
      if (session.snapshotAt && now - session.snapshotAt >= LIMITS.timeout) {
        session.blocked = true; session.summary = null; session.state = 'idle'; this.following(session, false); this.warning = '状态快照读取失败'; session.snapshotAt = null;
      }
    }
    this.publish();
  }
  snapshot() {
    let state = 'idle', at = 0;
    for (const session of this.sessions.values()) {
      if (!matchesWorkspace(session, this.options.workspace)) continue;
      const age = this.now() - session.at;
      let candidate = session.state;
      if ((['review', 'failed'].includes(candidate) && age >= 4000) || (candidate === 'running' && age >= this.options.activeSeconds * 1000) ||
        (candidate === 'waiting' && age >= 3600000)) candidate = 'idle';
      if (RANK[candidate] > RANK[state] || (candidate === state && session.at > at)) { state = candidate; at = session.at; }
    }
    const count = [...this.sessions.values()].filter(session => session.owner && !session.blocked && matchesWorkspace(session, this.options.workspace)).length;
    return { state, bubble: this.options.showBubble ? WORDS[state] : undefined,
      info: { count, connected: this.ready, degraded: Boolean(this.warning), message: this.warning || (!this.ready ? '等待 ChatGPT 桌面端连接……' : count ? `已连接，正在监听 ${count} 个 OpenAI 会话` : this.options.workspace ? '已连接，等待匹配工作区的本机会话……' : '已连接，等待桌面端会话……') } };
  }
  publish() {
    if (!this.active) return;
    const value = this.snapshot(), signature = JSON.stringify(value);
    if (signature !== this.last) { this.last = signature; this.onUpdate(value); }
  }
}
module.exports = { OpenaiObserver, Frames, LIMITS, summarize, applyPatches, stateOf, matchesWorkspace };

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { StringDecoder } = require('node:string_decoder');

const LIMITS = Object.freeze({ input: 64 * 1024, output: 16 * 1024, line: 256 * 1024,
  expanded: 4 * 1024 * 1024, compressed: 4 * 1024 * 1024 + 65536,
  batch: 1024 * 1024, frames: 16, sessions: 256, ids: 32, tail: 256 * 1024,
  search: 1024 * 1024, discoverMs: 5000, retentionMs: 3600000 });
const TYPES = new Set(['turn/start', 'turn/end', 'step/start', 'llm/retry', 'tool/call',
  'tool/result', 'approval/asked', 'approval/decided', 'job/registered', 'job/settled']);
const WORDS = { running: 'DSH 正在处理……', waiting: 'DSH 正在等你审批……', review: '这一步完成了。', failed: '这一步没有完成。' };
const RANK = { idle: 0, review: 1, failed: 2, running: 3, waiting: 4 };
const shortId = value => (typeof value === 'string' || typeof value === 'number') && String(value).length <= 128 ? String(value) : null;
function within(cwd, workspace) {
  const relative = path.relative(path.resolve(workspace), path.resolve(cwd));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function reset(session) {
  Object.assign(session, { offset: 0, seq: -1, at: 0, turn: null, active: false, end: '', uncertain: false,
    problem: false, approvals: new Set(), jobs: new Set(), skipping: false, anchor: null, initialized: false, cwd: '', filtered: false });
}
function invalidate(session) {
  session.uncertain = session.problem = true;
  session.active = false; session.end = ''; session.approvals.clear(); session.jobs.clear();
}
function applyEvent(session, event) {
  if (!TYPES.has(event?.type)) return;
  if (!Number.isFinite(event.time) || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) { invalidate(session); return; }
  if (Number.isSafeInteger(event.seq)) {
    if (event.seq <= session.seq) return;
    session.seq = event.seq;
  }
  const data = event.data, type = event.type, turn = shortId(data.turn);
  if (type !== 'turn/start' && !type.startsWith('job/') && turn !== null && session.turn !== null && turn !== session.turn) return;
  if (type === 'turn/start' && turn !== null && session.turn !== null && Number(turn) < Number(session.turn)) return;
  session.at = event.time;
  if (type === 'turn/start') {
    session.turn = turn; session.active = true; session.end = ''; session.approvals.clear();
    session.uncertain = session.problem = false;
  } else if (type === 'turn/end') {
    const reason = data.reason?.kind;
    if (!['completed', 'aborted', 'cancelled', 'interrupted', 'failed', 'error'].includes(reason)) { invalidate(session); return; }
    session.active = false; session.end = reason; session.approvals.clear(); session.uncertain = session.problem = false;
    if (reason === 'failed' || reason === 'error') session.jobs.clear();
  } else if (type.startsWith('approval/')) {
    const id = shortId(data.approvalId ?? data.id ?? data.approval?.id ?? data.request?.id ?? data.callId ?? data.toolCallId);
    if (id === null) { invalidate(session); return; }
    if (type === 'approval/asked') {
      if (session.approvals.size >= LIMITS.ids && !session.approvals.has(id)) { invalidate(session); return; }
      session.approvals.add(id);
    } else session.approvals.delete(id);
    session.active = true;
  } else if (type.startsWith('job/')) {
    const id = shortId(data.jobId ?? data.id ?? data.job?.id);
    if (id === null) { invalidate(session); return; }
    if (type === 'job/registered') {
      if (session.jobs.size >= LIMITS.ids && !session.jobs.has(id)) { invalidate(session); return; }
      session.jobs.add(id);
    } else session.jobs.delete(id);
  } else {
    if (session.turn === null) session.turn = turn;
    session.active = true; session.end = '';
  }
}
function stateOf(session, now, activeSeconds) {
  if (session.filtered || session.uncertain || !session.at || session.at > now + 300000) return 'idle';
  const age = now - session.at;
  if (session.approvals.size) return age < LIMITS.retentionMs ? 'waiting' : 'idle';
  if (session.active || session.jobs.size) return age < activeSeconds * 1000 ? 'running' : 'idle';
  if (age >= 4000) return 'idle';
  if (session.end === 'completed') return 'review';
  return ['failed', 'error'].includes(session.end) ? 'failed' : 'idle';
}

// Only one parser exists during a visit. An unfinished line is replayed from its
// first frame next time, so no per-session text buffers survive a polling cycle.
class Lines {
  constructor(session, accept) {
    this.session = session; this.accept = accept; this.decoder = new StringDecoder('utf8');
    this.rest = ''; this.bytes = 0; this.start = session.offset; this.skipping = session.skipping;
  }
  push(buffer, frame) {
    const text = this.decoder.write(buffer);
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline;
      const part = text.slice(start, end);
      if (!this.skipping) {
        if (!this.rest) this.start = frame;
        this.bytes += Buffer.byteLength(part);
        if (this.bytes > LIMITS.line) { this.rest = ''; this.skipping = true; invalidate(this.session); }
        else this.rest += part;
      }
      if (newline < 0) break;
      if (!this.skipping && this.rest.trim()) {
        try { this.accept(JSON.parse(this.rest)); } catch { invalidate(this.session); }
      }
      this.rest = ''; this.bytes = 0; this.skipping = false; start = newline + 1;
    }
  }
  get incomplete() { return this.rest.length > 0 || this.decoder.lastNeed > 0; }
}

class DshObserver {
  constructor(options = {}, onUpdate = () => {}, { now = Date.now } = {}) {
    this.options = { pollMs: 500, activeSeconds: 600, showBubble: true, workspace: '', ...options };
    this.root = path.resolve(options.sessionsRoot || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions'));
    this.onUpdate = onUpdate; this.now = now; this.sessions = new Map(); this.active = false;
    this.timer = null; this.flight = null; this.abort = null; this.nextDiscovery = 0; this.discoveryProblem = ''; this.last = '';
    this.header = Buffer.alloc(18); this.scan = Buffer.alloc(LIMITS.input);
  }
  start({ schedule = true } = {}) {
    if (this.active) return;
    this.active = true;
    if (schedule) this.schedule(0);
  }
  schedule(delay) {
    if (!this.active) return;
    this.timer = setTimeout(async () => { await this.tick(); this.schedule(this.options.pollMs); }, delay);
    this.timer.unref?.();
  }
  stop() {
    this.active = false; clearTimeout(this.timer); this.timer = null; this.abort?.abort();
    this.sessions.clear(); this.last = '';
    return this.flight || Promise.resolve();
  }
  async tick() {
    if (!this.active) return;
    if (this.flight) return this.flight;
    this.flight = this.run().catch(() => { this.discoveryProblem = '读取失败'; }).finally(() => { this.flight = null; });
    return this.flight;
  }
  async discover(now) {
    this.nextDiscovery = now + LIMITS.discoverMs; this.discoveryProblem = '';
    try {
      const workspaces = await fs.promises.opendir(this.root);
      for await (const workspace of workspaces) {
        if (!this.active) break;
        if (!workspace.isDirectory()) continue;
        try {
          const children = await fs.promises.opendir(path.join(this.root, workspace.name));
          for await (const child of children) {
            if (!this.active) break;
            if (!child.isDirectory()) continue;
            const file = path.join(this.root, workspace.name, child.name, 'session.v4.jsonl.zstd');
            if (this.sessions.has(file)) continue;
            let stat;
            try { stat = await fs.promises.stat(file); } catch (error) { if (error.code !== 'ENOENT') this.discoveryProblem = '部分会话无法读取'; continue; }
            if (!stat.isFile() || now - stat.mtimeMs > LIMITS.retentionMs) continue;
            if (this.sessions.size >= LIMITS.sessions) {
              this.discoveryProblem = '会话数量超过资源上限';
              const oldest = [...this.sessions.values()].reduce((a, b) => a.mtime < b.mtime ? a : b);
              if (oldest.mtime >= stat.mtimeMs || stateOf(oldest, now, this.options.activeSeconds) === 'waiting') continue;
              this.sessions.delete(oldest.file);
            }
            const session = { file, mtime: stat.mtimeMs, identity: '' }; reset(session);
            this.sessions.set(file, session);
          }
        } catch { this.discoveryProblem = '部分工作区无法读取'; }
      }
    } catch (error) { this.discoveryProblem = error.code === 'ENOENT' ? '未找到 DSH 会话目录' : '会话目录无法读取'; }
  }
  async read(handle, position, bytes = 18) {
    const { bytesRead } = await handle.read(this.header, 0, bytes, position);
    return this.header.subarray(0, bytesRead);
  }
  async frameAt(handle, position, size) {
    const h = await this.read(handle, position);
    if (h.length < 4) return { incomplete: true };
    const magic = h.readUInt32LE(0);
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      if (h.length < 8) return { incomplete: true };
      const end = position + 8 + h.readUInt32LE(4);
      return end <= size ? { end, skip: true } : { incomplete: true };
    }
    if (magic !== 0xfd2fb528) return { invalid: true };
    if (h.length < 5) return { incomplete: true };
    const d = h[4], single = (d >> 5) & 1;
    if (d & 8) return { invalid: true };
    let cursor = position + 5 + (single ? 0 : 1) + [0, 1, 2, 4][d & 3] + [single ? 1 : 0, 2, 4, 8][d >> 6];
    for (let blocks = 0; blocks < 4096 && this.active; blocks++) {
      if (cursor + 3 > size) return { incomplete: true };
      const block = await this.read(handle, cursor, 3);
      if (block.length < 3) return { incomplete: true };
      const value = block.readUIntLE(0, 3), type = (value >> 1) & 3, length = value >>> 3;
      if (type === 3 || length > 128 * 1024) return { invalid: true };
      cursor += 3 + (type === 1 ? 1 : length);
      if (cursor > size) return { incomplete: true };
      if (value & 1) {
        const end = cursor + ((d & 4) ? 4 : 0);
        return end > size ? { incomplete: true } : { end, big: end - position > LIMITS.compressed };
      }
    }
    return { invalid: true };
  }
  async seek(handle, start, size) {
    const until = Math.min(size, start + LIMITS.search);
    for (let position = start; position + 4 <= until && this.active;) {
      const { bytesRead } = await handle.read(this.scan, 0, Math.min(this.scan.length, until - position), position);
      if (bytesRead < 4) break;
      for (let i = 0; i + 4 <= bytesRead; i++) {
        const magic = this.scan.readUInt32LE(i);
        if (magic !== 0xfd2fb528 && !(magic >= 0x184d2a50 && magic <= 0x184d2a5f)) continue;
        const frame = await this.frameAt(handle, position + i, size);
        if (!frame.invalid) return position + i;
      }
      position += bytesRead - 3;
    }
    return null;
  }
  async decode(handle, start, end, parser) {
    let expanded = 0;
    const decoder = zlib.createZstdDecompress({ chunkSize: LIMITS.output,
      params: { [zlib.constants.ZSTD_d_windowLogMax]: 22 } });
    const source = fs.createReadStream('', { fd: handle.fd, autoClose: false, start, end: end - 1, highWaterMark: LIMITS.input });
    const sink = new Writable({ write(chunk, encoding, done) {
      expanded += chunk.length;
      if (expanded > LIMITS.expanded) { done(new Error('output-limit')); return; }
      try { parser.push(chunk, start); done(); } catch { done(new Error('invalid-event')); }
    } });
    await pipeline(source, decoder, sink, { signal: this.abort.signal });
  }
  async fingerprint(handle, offset) {
    if (!offset) return '';
    const buffer = Buffer.alloc(Math.min(32, offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset - buffer.length);
    return buffer.subarray(0, bytesRead).toString('hex');
  }
  async visit(session, now) {
    const handle = await fs.promises.open(session.file, 'r');
    try {
      const stat = await handle.stat(), identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      if (!stat.isFile()) return;
      if (session.identity && (identity !== session.identity || stat.size < session.size ||
        (stat.mtimeMs !== session.mtime && stat.size === session.size) ||
        (stat.mtimeMs !== session.mtime && session.anchor !== null && await this.fingerprint(handle, session.offset) !== session.anchor))) reset(session);
      session.identity = identity; session.mtime = stat.mtimeMs; session.size = stat.size;
      if (now - stat.mtimeMs > LIMITS.retentionMs && stateOf(session, now, this.options.activeSeconds) !== 'waiting') { this.sessions.delete(session.file); return; }
      if (!session.initialized) {
        if (this.options.workspace) {
          const head = await this.frameAt(handle, 0, stat.size);
          if (!head.end || head.skip || head.big) { invalidate(session); return; }
          const parser = new Lines(session, event => { if (event.type === 'session' && typeof event.cwd === 'string' && event.cwd.length <= 1000) session.cwd = event.cwd; });
          await this.decode(handle, 0, head.end, parser);
          if (!session.cwd) { invalidate(session); return; }
          session.filtered = !within(session.cwd, this.options.workspace);
        }
        if (stat.size > LIMITS.tail) {
          let offset = await this.seek(handle, Math.max(0, stat.size - LIMITS.tail), stat.size);
          if (offset === null && stat.size > LIMITS.tail) offset = await this.seek(handle, Math.max(0, stat.size - LIMITS.search), stat.size);
          if (offset === null) { invalidate(session); session.offset = Math.max(0, stat.size - 3); }
          else { session.offset = offset; session.uncertain = true; }
        }
        session.initialized = true;
      }
      if (session.filtered || stat.size === session.offset) return;
      let parser = new Lines(session, event => applyEvent(session, event));
      let cursor = session.offset, consumed = 0, frames = 0;
      for (; frames < LIMITS.frames && consumed < LIMITS.batch && cursor < stat.size && this.active; frames++) {
        const frame = await this.frameAt(handle, cursor, stat.size);
        if (frame.incomplete) break;
        if (frame.invalid) {
          invalidate(session); parser = new Lines(session, event => applyEvent(session, event));
          const next = await this.seek(handle, cursor + 1, stat.size);
          cursor = next ?? Math.min(stat.size, cursor + LIMITS.search);
          session.offset = cursor; continue;
        }
        if (!frame.skip) {
          try { if (frame.big) throw new Error('input-limit'); await this.decode(handle, cursor, frame.end, parser); }
          catch (error) {
            if (!this.active || error.name === 'AbortError') return;
            invalidate(session); parser = new Lines(session, event => applyEvent(session, event));
          }
        }
        consumed += frame.end - cursor; cursor = frame.end;
        session.offset = parser.incomplete ? parser.start : cursor;
        session.skipping = parser.skipping;
      }
      // A line split into too many frames must not replay the same batch forever.
      if (parser.incomplete && cursor < stat.size && (frames >= LIMITS.frames || consumed >= LIMITS.batch)) {
        invalidate(session); session.offset = cursor; session.skipping = true;
      }
      session.anchor = await this.fingerprint(handle, session.offset);
    } finally { await handle.close(); }
  }
  snapshot(now = this.now()) {
    let state = 'idle', at = 0, count = 0, degraded = Boolean(this.discoveryProblem);
    for (const session of this.sessions.values()) {
      if (session.filtered) continue;
      count++; degraded ||= session.problem;
      const candidate = stateOf(session, now, this.options.activeSeconds);
      if (RANK[candidate] > RANK[state] || (candidate === state && session.at > at)) { state = candidate; at = session.at; }
    }
    const message = this.discoveryProblem || (degraded ? 'DSH 状态读取降级：日志布局、损坏或资源超限' : count ? `正在监听 ${count} 个 DSH 会话` : '等待 DSH 会话……');
    return { state, bubble: this.options.showBubble ? WORDS[state] : undefined, info: { count, degraded, message } };
  }
  async run() {
    this.abort = new AbortController();
    const now = this.now();
    if (now >= this.nextDiscovery) await this.discover(now);
    for (const session of this.sessions.values()) {
      if (!this.active) return;
      try { await this.visit(session, now); }
      catch (error) {
        if (!this.active) return;
        if (error.code === 'ENOENT') this.sessions.delete(session.file);
        else invalidate(session);
      }
    }
    if (!this.active) return;
    const snapshot = this.snapshot(this.now()), signature = JSON.stringify(snapshot);
    if (signature !== this.last) { this.last = signature; this.onUpdate(snapshot); }
  }
}
module.exports = { DshObserver, LIMITS, applyEvent, stateOf, within, reset };

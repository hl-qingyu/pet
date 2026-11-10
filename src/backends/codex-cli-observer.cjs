const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { JsonMetadata } = require('./json-metadata.cjs');
const { matchesWorkspace } = require('./openai-observer.cjs');

const LIMITS = Object.freeze({ sessions: 32, chunk: 64 * 1024, batch: 1024 * 1024,
  head: 1024 * 1024, tail: 256 * 1024, line: 16 * 1024 * 1024, discoverMs: 5000, retentionMs: 3600000,
  excluded: 1024, recheckMs: 60000 });
const KEYS = new Set(['type', 'timestamp', 'payload', 'id', 'session_id', 'thread_id', 'turn_id',
  'cwd', 'source', 'originator', 'thread_source', 'started_at', 'completed_at']);
const WORDS = { running: 'Codex CLI 正在处理……', review: '这一步完成了。' };
const safeId = value => typeof value === 'string' && /^[\w:./-]{1,128}$/.test(value);
const timeOf = value => typeof value === 'number' && Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
const projection = () => new JsonMetadata({ keys: KEYS, maxNodes: 128 });
function supportedSource(meta) {
  if (['cli', 'exec'].includes(meta?.source)) return true;
  // The local Codex TUI host labels its user sessions "vscode" in 0.167.0.
  // Require both host and thread kind; unrelated editor/subagent logs stay excluded.
  return meta?.source === 'vscode' && meta.originator === 'codex-tui' && meta.thread_source === 'user';
}

// Project each line as bytes arrive; prompts, tool arguments and outputs are never accumulated.
class Lines {
  constructor(accept, fault, skip = false) { Object.assign(this, { accept, fault, skip, bytes: 0, parser: projection() }); }
  push(buffer) {
    for (let start = 0; start < buffer.length;) {
      const newline = buffer.indexOf(10, start), end = newline < 0 ? buffer.length : newline;
      this.bytes += end - start;
      if (!this.skip) {
        try {
          if (this.bytes > LIMITS.line) throw new Error('line-limit');
          this.parser.feed(buffer.subarray(start, end));
        } catch { this.skip = true; this.parser = null; this.fault(); }
      }
      if (newline < 0) break;
      if (!this.skip && this.bytes) {
        try { this.accept(this.parser.finish()); } catch { this.fault(); }
      }
      this.bytes = 0; this.skip = false; this.parser = projection(); start = end + 1;
    }
  }
}

function applyEvent(session, event, now, bootstrap = false) {
  if (event?.type !== 'event_msg') return;
  const data = event.payload;
  if (!data || typeof data !== 'object') return;
  const at = timeOf(event.timestamp);
  if (!Number.isFinite(at) || at > now + 300000 || at < session.at) return;
  const turn = data.turn_id;
  if (data.type === 'task_started') {
    if (!safeId(turn)) return;
    const startedAt = timeOf(data.started_at);
    Object.assign(session, { turnId: turn, startedAt: Number.isFinite(startedAt) ? startedAt : at,
      state: 'running', at, problem: false, finished: false });
  } else if (data.type === 'task_complete') {
    if (!safeId(turn) || (session.turnId && session.turnId !== turn)) return;
    Object.assign(session, { turnId: turn, state: bootstrap ? 'idle' : 'review', at, problem: false, finished: true });
  } else if (data.type === 'item_completed' && safeId(turn) && !session.turnId && bootstrap) {
    // A large rollout's bounded tail can start after task_started. A later
    // task_complete in that same tail will still settle this activity.
    Object.assign(session, { turnId: turn, state: 'running', at, problem: false });
  } else if (session.state === 'running' && !session.problem && (!turn || turn === session.turnId) &&
    ['item_completed', 'token_count'].includes(data.type)) session.at = at;
  // Approval, interruption and failure layouts are intentionally not guessed.
}

const identityOf = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
async function* filesIn(directory, depth = 0, maxDepth = 3) {
  const dirs = [], entries = await fs.promises.opendir(directory);
  for await (const entry of entries) {
    if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) yield path.join(directory, entry.name);
    else if (entry.isDirectory() && depth < maxDepth) {
      if (dirs.length >= 512) throw new Error('directory-limit');
      dirs.push(entry.name);
    }
  }
  // New date directories first; retain the iterator between bounded discovery batches.
  for (const name of dirs.sort().reverse()) yield* filesIn(path.join(directory, name), depth + 1, maxDepth);
}
async function* recentFilesIn(root, now) {
  const directories = new Set();
  for (const offset of [0, 86400000]) {
    const date = new Date(now - offset);
    for (const [year, month, day] of [[date.getFullYear(), date.getMonth() + 1, date.getDate()],
      [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]]) {
      directories.add(path.join(root, String(year), String(month).padStart(2, '0'), String(day).padStart(2, '0')));
    }
  }
  for (const directory of directories) {
    try { yield* filesIn(directory, 0, 0); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

class CodexCliObserver {
  constructor(options = {}, onUpdate = () => {}, { now = Date.now } = {}) {
    this.options = { workspace: '', sessionsRoot: '', showBubble: true, pollMs: 500, activeSeconds: 600, ...options };
    this.root = this.options.sessionsRoot || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    Object.assign(this, { onUpdate, now, sessions: new Map(), excluded: new Map(), active: false,
      nextDiscovery: 0, nextRecentDiscovery: 0, last: '', discoveryProblem: '' });
  }
  start() {
    if (this.active) return;
    this.active = true; this.tick();
  }
  async stop() {
    this.active = false; clearTimeout(this.timer); this.timer = null;
    await this.inflight;
    await this.scanner?.return(); await this.recentScanner?.return();
    this.scanner = this.recentScanner = null; this.sessions.clear(); this.excluded.clear();
  }
  tick() {
    if (!this.active) return;
    this.inflight = this.run().catch(() => {
      if (!this.active) return;
      this.discoveryProblem = 'CLI 日志读取降级'; this.publish();
    }).finally(() => {
      if (this.active) { this.timer = setTimeout(() => this.tick(), this.options.pollMs); this.timer.unref?.(); }
    });
  }
  invalidate(session) { session.problem = true; session.state = 'idle'; }
  async head(handle) {
    const buffer = Buffer.alloc(LIMITS.chunk), parser = projection();
    for (let offset = 0; offset < LIMITS.head && this.active;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) return null;
      const chunk = buffer.subarray(0, bytesRead), end = chunk.indexOf(10);
      parser.feed(end < 0 ? chunk : chunk.subarray(0, end));
      if (end >= 0) return parser.finish();
      offset += bytesRead;
    }
    return null;
  }
  async initialize(file, now) {
    const handle = await fs.promises.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      const head = await this.head(handle), meta = head?.payload;
      if (head?.type !== 'session_meta' || !supportedSource(meta)) return null;
      if (!safeId(meta.id) || typeof meta.cwd !== 'string' || !path.isAbsolute(meta.cwd)) throw new Error('metadata-layout');
      const session = { file, id: meta.id, hostId: 'local', summary: { cwd: meta.cwd }, turnId: null,
        startedAt: 0, state: 'idle', at: 0, problem: false, offset: 0, size: stat.size, mtime: stat.mtimeMs,
        identity: identityOf(stat) };
      if (!matchesWorkspace(session, this.options.workspace)) return null;
      const start = Math.max(0, stat.size - LIMITS.tail);
      session.offset = start;
      session.lines = new Lines(event => {
        applyEvent(session, event, this.now(), session.bootstrap || session.partialBootstrap);
        session.partialBootstrap = false;
      }, () => this.invalidate(session), start > 0);
      session.bootstrap = true;
      await this.read(handle, session, stat.size);
      // Finish any split bootstrap record before allowing result notifications.
      session.partialBootstrap = session.lines.bytes > 0; session.bootstrap = false;
      session.anchor = await this.fingerprint(handle, session.offset);
      if (!session.at || now - session.at > LIMITS.retentionMs) return null;
      return session;
    } finally { await handle.close(); }
  }
  rememberExcluded(file, stat, now, problem = false) {
    this.excluded.delete(file);
    this.excluded.set(file, { identity: stat.identity || identityOf(stat), size: stat.size,
      mtime: stat.mtimeMs ?? stat.mtime, workspace: this.options.workspace, until: now + LIMITS.recheckMs, problem });
    if (this.excluded.size > LIMITS.excluded) this.excluded.delete(this.excluded.keys().next().value);
  }
  async discover(now) {
    if (!this.scanner && now >= this.nextDiscovery) { this.scanner = filesIn(this.root); this.discoveryProblem = ''; }
    if (!this.recentScanner && now >= this.nextRecentDiscovery) this.recentScanner = recentFilesIn(this.root, now);
    try {
      let inspected = 0;
      for (let entries = 0; entries < 256 && inspected < 8 && this.active && (this.recentScanner || this.scanner); entries++) {
        const recent = Boolean(this.recentScanner), next = await (this.recentScanner || this.scanner).next();
        if (next.done) {
          if (recent) { this.recentScanner = null; this.nextRecentDiscovery = now + LIMITS.discoverMs; }
          else { this.scanner = null; this.nextDiscovery = now + LIMITS.discoverMs; }
          continue;
        }
        if (this.sessions.has(next.value)) continue;
        let session, stat;
        try {
          stat = await fs.promises.stat(next.value);
          if (!stat.isFile()) continue;
          const cached = this.excluded.get(next.value);
          if (cached && now < cached.until && cached.workspace === this.options.workspace && cached.identity === identityOf(stat) &&
            cached.size === stat.size && cached.mtime === stat.mtimeMs) {
            if (cached.problem) this.discoveryProblem = cached.problem === 'capacity' ?
              'CLI 会话数量超过资源上限' : '部分 CLI 日志布局不支持或无法读取';
            continue;
          }
          this.excluded.delete(next.value); inspected++;
          session = await this.initialize(next.value, now);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            this.discoveryProblem = '部分 CLI 日志布局不支持或无法读取';
            if (stat) this.rememberExcluded(next.value, stat, now, true);
          } else this.excluded.delete(next.value);
          continue;
        }
        if (!this.active) return;
        if (!session) { this.rememberExcluded(next.value, stat, now); continue; }
        if (this.sessions.size >= LIMITS.sessions) {
          this.discoveryProblem = 'CLI 会话数量超过资源上限';
          const oldest = [...this.sessions.values()].reduce((a, b) => a.at < b.at ? a : b);
          if (oldest.at >= session.at) { this.rememberExcluded(next.value, stat, now, 'capacity'); continue; }
          this.rememberExcluded(oldest.file, oldest, now, 'capacity');
          this.sessions.delete(oldest.file);
        }
        this.sessions.set(session.file, session);
      }
    } catch (error) {
      await this.scanner?.return(); await this.recentScanner?.return(); this.scanner = this.recentScanner = null;
      this.nextDiscovery = this.nextRecentDiscovery = now + LIMITS.discoverMs;
      this.discoveryProblem = error.code === 'ENOENT' ? '未找到 CLI 会话目录' : 'CLI 会话目录读取降级';
    }
  }
  async read(handle, session, size) {
    const buffer = Buffer.alloc(LIMITS.chunk), end = Math.min(size, session.offset + LIMITS.batch);
    while (this.active && session.offset < end) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - session.offset), session.offset);
      if (!bytesRead) break;
      session.lines.push(buffer.subarray(0, bytesRead)); session.offset += bytesRead;
    }
  }
  async fingerprint(handle, offset) {
    const buffer = Buffer.alloc(Math.min(64, offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset - buffer.length);
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
  }
  async visit(session) {
    const handle = await fs.promises.open(session.file, 'r');
    try {
      const stat = await handle.stat(), identity = identityOf(stat);
      if (!stat.isFile() || identity !== session.identity || stat.size < session.size ||
        (stat.size === session.offset && stat.mtimeMs !== session.mtime) ||
        await this.fingerprint(handle, session.offset) !== session.anchor) {
        this.sessions.delete(session.file); this.nextDiscovery = 0; return;
      }
      // Windows can leave mtime unchanged while a writer keeps its handle open.
      if (stat.size > session.offset) await this.read(handle, session, stat.size);
      session.size = stat.size; session.mtime = stat.mtimeMs;
      session.anchor = await this.fingerprint(handle, session.offset);
    } finally { await handle.close(); }
  }
  snapshot(now = this.now()) {
    const sessions = [];
    let state = 'idle', at = 0, degraded = Boolean(this.discoveryProblem), expired = false;
    for (const session of this.sessions.values()) {
      const age = now - session.at;
      degraded ||= session.problem;
      let candidate = session.problem ? 'idle' : session.state;
      if (candidate === 'running' && age >= this.options.activeSeconds * 1000) { candidate = 'idle'; expired = true; }
      if (candidate === 'review' && age >= 4000) candidate = 'idle';
      sessions.push({ hostId: 'local', id: session.id, turnId: session.turnId, startedAt: session.startedAt,
        state: candidate, at: session.at, settled: session.finished === true,
        bubble: this.options.showBubble ? WORDS[candidate] : undefined });
      if ((candidate === 'running' && state !== 'running') || (candidate === 'review' && state === 'idle') || (candidate === state && session.at > at)) {
        state = candidate; at = session.at;
      }
    }
    degraded ||= expired;
    return { state, bubble: this.options.showBubble ? WORDS[state] : undefined, sessions,
      info: { count: sessions.length, degraded, message: this.discoveryProblem || (degraded ? 'CLI 状态读取降级：日志损坏或状态已过期' :
        sessions.length ? `正在监听 ${sessions.length} 个 CLI 会话（日志模式）` : '等待 CLI 会话日志……') } };
  }
  publish() {
    if (!this.active) return;
    const snapshot = this.snapshot(), signature = JSON.stringify(snapshot);
    if (signature !== this.last) { this.last = signature; this.onUpdate(snapshot); }
  }
  async run() {
    await this.discover(this.now());
    for (const session of this.sessions.values()) {
      if (!this.active) return;
      try { await this.visit(session); }
      catch (error) { if (error.code === 'ENOENT') this.sessions.delete(session.file); else this.invalidate(session); }
      if (this.now() - session.at > LIMITS.retentionMs) {
        this.rememberExcluded(session.file, session, this.now()); this.sessions.delete(session.file);
      }
    }
    this.publish();
  }
}
module.exports = { CodexCliObserver, Lines, applyEvent, LIMITS };

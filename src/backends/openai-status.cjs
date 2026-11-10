const RANK = { idle: 0, review: 1, failed: 2, running: 3, waiting: 4 };
const active = session => ['running', 'waiting'].includes(session.state);
function prefer(candidate, previous) {
  if (previous.turnId && candidate.turnId && previous.turnId !== candidate.turnId) {
    if (previous.startedAt && candidate.startedAt && previous.startedAt !== candidate.startedAt) return candidate.startedAt > previous.startedAt;
    const desktop = candidate.source === 'openai' ? candidate : previous;
    const cli = candidate.source === 'codexCli' ? candidate : previous;
    // A bounded CLI tail may contain activity without its task_started record.
    // Actual desktop turn timestamps can still prove that the CLI turn is older.
    if (cli.at && desktop.startedAt > cli.at) return candidate === desktop;
    if (cli.at && desktop.settled && desktop.completedAt) return candidate === (desktop.completedAt >= cli.at ? desktop : cli);
    if (active(cli) !== active(desktop)) return candidate === (active(cli) ? cli : desktop);
  }
  return candidate.source === 'openai';
}

// Private main-process summaries only. Neither identities nor paths reach the renderer.
class OpenaiStatus {
  constructor() { this.sources = new Map(); this.settled = new Map(); }
  update(source, snapshot) {
    this.sources.set(source, snapshot);
    for (const session of snapshot.sessions || []) if (session.turnId) {
      const key = JSON.stringify([session.hostId, session.id]), previous = this.settled.get(key);
      if (session.settled && (!previous || session.at >= previous.at)) {
        this.settled.delete(key); this.settled.set(key, { turnId: session.turnId, at: session.at });
        if (this.settled.size > 64) this.settled.delete(this.settled.keys().next().value);
      } else if (source === 'openai' && ['running', 'waiting'].includes(session.state) &&
        previous?.turnId === session.turnId && session.at >= previous.at) {
        this.settled.delete(key);
      }
    }
    return this.snapshot();
  }
  clear(source) { this.sources.delete(source); return this.snapshot(); }
  snapshot() {
    const sessions = new Map();
    for (const [source, snapshot] of this.sources) for (const session of snapshot.sessions || []) {
      const key = JSON.stringify([session.hostId, session.id]);
      const candidate = { ...session, source }, previous = sessions.get(key);
      // A disconnect must not resurrect a CLI start already observed as settled.
      if (source === 'codexCli' && candidate.state === 'running' && candidate.turnId && candidate.turnId === this.settled.get(key)?.turnId) {
        candidate.state = 'idle'; candidate.bubble = undefined;
      }
      if (!previous) { sessions.set(key, candidate); continue; }
      if (prefer(candidate, previous)) sessions.set(key, candidate);
    }
    let view = { state: 'idle', at: 0 };
    let running = 0, waiting = 0;
    for (const session of sessions.values()) {
      if (session.state === 'running') running++;
      if (session.state === 'waiting') waiting++;
      if (RANK[session.state] > RANK[view.state] || (session.state === view.state && session.at > view.at)) view = session;
    }
    return { state: view.state, bubble: view.bubble, info: { count: sessions.size, running, waiting,
      message: sessions.size ? `共 ${sessions.size} 个会话 · ${running} 个运行 · ${waiting} 个等待确认` : '等待会话……' } };
  }
}
module.exports = { OpenaiStatus };

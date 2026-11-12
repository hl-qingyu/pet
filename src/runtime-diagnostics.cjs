const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./config.cjs');

// Diagnostics must never be another reason for the application to stop.
function createDiagnostics(directory, version, { pid = process.pid, now = () => new Date().toISOString() } = {}) {
  const logFile = path.join(directory, 'app.log'), sessionFile = path.join(directory, 'runtime-session.json');
  const session = { pid, version, startedAt: now(), status: 'running' };
  function log(message) {
    try { fs.appendFileSync(logFile, `${now()} ${String(message).slice(0, 8000)}\n`); } catch {}
  }
  function save() { try { atomicWrite(sessionFile, session); } catch {} }
  try {
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(sessionFile)) {
      const previous = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      if (previous.status === 'running') log(`Previous run ended without exit event: pid=${previous.pid} startedAt=${previous.startedAt}`);
    }
  } catch {}
  save();
  log(`Process started: pid=${pid} version=${version}`);
  return {
    log,
    quitting() { session.status = 'quitting'; session.quitAt = now(); save(); log('Application before-quit'); },
    exit(code) { session.status = 'exited'; session.exitCode = code; session.exitedAt = now(); save(); log(`Process exit: code=${code}`); },
    error(error, origin, secrets = []) {
      let detail = error?.stack || String(error);
      for (const secret of secrets) if (typeof secret === 'string' && secret.trim()) detail = detail.split(secret).join('[redacted]');
      log(`${origin}: ${detail}`);
    },
  };
}
module.exports = { createDiagnostics };

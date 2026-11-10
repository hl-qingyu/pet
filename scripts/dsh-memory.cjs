// Isolated observer measurement, with synthetic logs only. Not Electron's total RSS.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { DshObserver, LIMITS } = require('../src/backends/dsh-observer.cjs');
if (!global.gc) throw new Error('Run with node --expose-gc');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-dsh-memory-'));
const output = path.resolve(__dirname, '../work/dsh-memory-report.json');
const files = [];
function create(index, buffer, old = false) {
  const directory = path.join(root, `workspace-${index % 4}`, `session-${index}`);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'session.v4.jsonl.zstd'); fs.writeFileSync(file, buffer);
  if (old) { const time = new Date(Date.now() - 7200000); fs.utimesSync(file, time, time); }
  else files.push(file);
}
function event(type, seq, data = {}) { return zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type, seq, time: Date.now(), data }) + '\n')); }
function sample() { const value = process.memoryUsage(); delete value.heapTotal; return value; }
function collect() { global.gc(); global.gc(); return sample(); }
function difference(a, b) { return Object.fromEntries(Object.keys(a).map(key => [key, a[key] - b[key]])); }
async function main() {
  for (let i = 0; i < 100; i++) create(i, event('turn/start', 1));
  for (let i = 100; i < 600; i++) create(i, Buffer.alloc(0), true);
  let huge = zlib.zstdCompressSync(Buffer.alloc(LIMITS.expanded + 65536, 65));
  create(600, huge); huge = null;
  // Allow the temporary fixture compression input to leave the async stack.
  await new Promise(resolve => setImmediate(resolve));
  const observer = new DshObserver({ sessionsRoot: root });
  const baseline = collect(), peak = { ...baseline };
  const measure = () => { const value = sample(); for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], value[key]); };
  const timer = setInterval(measure, 5);
  try {
    observer.start({ schedule: false });
    const started = performance.now();
    await observer.tick();
    for (let round = 2; round <= 6; round++) {
      for (const file of files.slice(0, 100)) fs.appendFileSync(file, event('tool/result', round));
      await observer.tick();
    }
    measure();
    const elapsedMs = Math.round(performance.now() - started), steady = collect();
    assert.equal(observer.sessions.size, 101); // 500 historical sessions never retained.
    assert.ok(observer.snapshot().info.degraded); // Oversized compressed input is isolated.
    assert.ok([...observer.sessions.values()].every(session => Object.values(session).every(value => !Buffer.isBuffer(value))));
    await observer.stop();
    const stopped = collect();
    const report = { node: process.version, fixture: { active: 100, old: 500, oversized: 1, rounds: 6 },
      elapsedMs, baseline, steady, peak, stopped, steadyDelta: difference(steady, baseline),
      peakDelta: difference(peak, baseline), stoppedDelta: difference(stopped, baseline),
      note: 'Bytes; isolated Node observer, explicit GC at snapshots, 5 ms peak sampling. RSS includes allocator retention; not an Electron memory guarantee.' };
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { clearInterval(timer); await observer.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));

// Isolated streaming observer benchmark. The large body is fed from one reusable
// 64 KiB block, so producer-side transcript construction is not in the numbers.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { OpenaiObserver, Frames } = require('../src/backends/openai-observer.cjs');
if (!global.gc) throw new Error('Run with --expose-gc');
const sample = () => { const result = process.memoryUsage(); delete result.heapTotal; return result; };
const collect = () => { global.gc(); global.gc(); return sample(); };
const delta = (value, base) => Object.fromEntries(Object.keys(value).map(key => [key, value[key] - base[key]]));
async function main() {
  const workspace = process.cwd();
  const observer = new OpenaiObserver({ workspace }, () => {});
  observer.active = true; observer.ready = true;
  const reader = new Frames(message => observer.message(message), () => { throw new Error('Unexpected metadata degradation'); });
  const chunk = Buffer.alloc(64 * 1024, 65), bodyBytes = 8 * 1024 * 1024;
  await new Promise(resolve => setImmediate(resolve));
  const baseline = collect(), peak = { ...baseline };
  const measure = () => { const value = sample(); for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], value[key]); };
  const started = performance.now();
  for (let i = 0; i < 32; i++) {
    const id = `memory-${i}`;
    observer.sessions.set(`local:${id}`, { id, hostId: 'local', owner: 'owner', state: 'idle', at: Date.now(), revision: -1 });
    const prefix = Buffer.from(`{"type":"broadcast","method":"thread-stream-state-changed","sourceClientId":"owner","version":11,"params":{"hostId":"local","conversationId":"${id}","change":{"type":"snapshot","revision":0,"conversationState":{"cwd":${JSON.stringify(path.join(workspace, 'child-' + i))},"threadRuntimeStatus":{"type":"active","activeFlags":[]},"turns":[{"status":"inProgress","items":[{"content":"`);
    const suffix = Buffer.from('"}]}],"requests":[]}}}}');
    const header = Buffer.alloc(4); header.writeUInt32LE(prefix.length + bodyBytes + suffix.length);
    reader.feed(header); reader.feed(prefix);
    for (let bytes = 0; bytes < bodyBytes; bytes += chunk.length) { reader.feed(chunk); if (bytes % (1024 * 1024) === 0) measure(); }
    reader.feed(suffix); measure(); await new Promise(resolve => setImmediate(resolve));
  }
  const elapsedMs = Math.round(performance.now() - started), steady = collect();
  assert.equal(observer.snapshot().state, 'running'); assert.equal(observer.sessions.size, 32);
  assert.equal(observer.snapshot().info.count, 32);
  const retainedMetadataBytes = Buffer.byteLength(JSON.stringify([...observer.sessions.values()]));
  assert.ok(retainedMetadataBytes < 32 * 1024);
  await observer.stop(); const stopped = collect();
  const report = { node: process.version, fixture: { sessions: 32, workspaceFiltering: true, bodyBytesPerSnapshot: bodyBytes, totalBodyBytes: bodyBytes * 32 },
    elapsedMs, retainedMetadataBytes, baseline, peak, steady, stopped,
    peakDelta: delta(peak, baseline), steadyDelta: delta(steady, baseline), stoppedDelta: delta(stopped, baseline),
    note: 'Bytes. Same frame parser, projection and observer reducer; socket-independent synthetic stream. Explicit GC at stable snapshots; peak sampled during input. Not total Electron or OpenAI producer memory.' };
  const output = path.resolve(__dirname, '../work/openai-memory-report.json'); fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

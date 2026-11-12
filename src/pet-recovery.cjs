// Recover the pet renderer in the same window so position, visibility, config,
// active replies and integration state stay owned by the existing main process.
function attachPetRecovery(window, { isQuitting, log, onCrash = () => {}, onRecovered = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null, recovering = false, attempts = [];
  const stopped = () => isQuitting() || window.isDestroyed();
  const gone = (_event, details) => {
    if (stopped() || details.reason === 'clean-exit') return;
    clearTimer(timer); timer = null;
    onCrash();
    attempts = attempts.filter(at => now() - at < 60000);
    if (attempts.length >= 3) { log('Pet recovery paused after 3 crashes in one minute'); return; }
    attempts.push(now()); recovering = true;
    log(`Pet recovery scheduled: reason=${details.reason} exitCode=${details.exitCode} attempt=${attempts.length}`);
    timer = setTimer(() => {
      timer = null;
      if (stopped()) return;
      try { window.reload(); } catch (error) { log(`Pet recovery failed: ${error.message}`); }
    }, 400);
  };
  const loaded = () => {
    if (!recovering || stopped()) return;
    recovering = false; onRecovered(); log('Pet renderer recovered');
  };
  const dispose = () => { clearTimer(timer); timer = null; window.webContents.removeListener('render-process-gone', gone);
    window.webContents.removeListener('did-finish-load', loaded); window.removeListener('closed', dispose); };
  window.webContents.on('render-process-gone', gone);
  window.webContents.on('did-finish-load', loaded);
  window.once('closed', dispose);
  return dispose;
}
module.exports = { attachPetRecovery };

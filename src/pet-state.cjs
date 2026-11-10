// External integrations never write the visible state directly. Timers resolve the current
// sources again, instead of unconditionally replacing them with idle.
class PetState {
  constructor(emit, isBusy = () => false, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { emit, isBusy, now, setTimer, clearTimer });
    this.enabled = false; this.localView = { state: 'idle' }; this.externalView = { state: 'idle' };
    this.interactionView = null; this.last = null;
  }
  enable(value) {
    if (this.enabled === value) return;
    this.enabled = value;
    if (!value) this.externalView = { state: 'idle' };
    // A previously persistent local error should not hide DSH forever.
    if (value && ['review', 'failed'].includes(this.localView.state) && !this.localTimer) this.localView = { state: 'idle' };
    this.refresh();
  }
  local(state, bubble, resetMs = 0) {
    if (!this.enabled && this.interactionView) {
      this.clearTimer(this.interactionTimer); this.interactionTimer = null; this.interactionView = null;
    }
    this.clearTimer(this.localTimer); this.localTimer = null;
    this.localView = { state, bubble };
    if (resetMs) this.localTimer = this.setTimer(() => {
      this.localTimer = null;
      if (!this.isBusy()) this.localView = { state: 'idle' };
      this.refresh();
    }, resetMs);
    this.refresh(true);
  }
  interact(state, bubble) {
    this.clearTimer(this.interactionTimer); this.interactionTimer = null;
    if (!this.enabled) {
      // Preserve the existing disabled behavior, including interaction during a reply.
      this.local(state, bubble);
      if (!this.isBusy()) this.interactionTimer = this.setTimer(() => {
        this.interactionTimer = null;
        if (!this.isBusy()) this.localView = { state: 'idle' };
        this.refresh();
      }, 1700);
    } else {
      this.interactionView = { state, bubble };
      this.interactionTimer = this.setTimer(() => { this.interactionTimer = null; this.interactionView = null; this.refresh(); }, 1700);
      this.refresh(true);
    }
  }
  external(view) { this.externalView = view; if (this.enabled) this.refresh(); }
  refresh(force = false) {
    let view = this.interactionView || this.localView, source = this.interactionView ? 'interaction' : 'local';
    if (this.enabled) {
      if (this.isBusy()) view = { state: 'running', bubble: this.localView.state === 'running' ? this.localView.bubble : undefined };
      else if (this.interactionView) { view = this.interactionView; source = 'interaction'; }
      else if (this.localView.state !== 'idle') view = this.localView;
      else { view = this.externalView; source = view.state === 'idle' ? 'local' : 'external'; }
    }
    if (!force && this.last?.state === view.state && this.last?.bubble === view.bubble && this.last?.source === source) return;
    const clearBubble = this.last?.source === 'external' && (source !== 'external' || !view.bubble);
    this.last = { state: view.state, bubble: view.bubble, source };
    this.emit({ state: view.state, bubble: view.bubble, ...(clearBubble ? { clearBubble: true } : {}) });
  }
  dispose() { this.clearTimer(this.localTimer); this.clearTimer(this.interactionTimer); }
}
module.exports = { PetState };

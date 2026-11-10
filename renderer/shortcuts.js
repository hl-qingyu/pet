(function (root) {
  const modifiers = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'Super', 'AltGraph', 'Fn']);
  const keys = { ' ': 'Space', Spacebar: 'Space', Enter: 'Return', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Tab: 'Tab',
    AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown', AudioVolumeMute: 'VolumeMute',
    MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack', MediaStop: 'MediaStop', MediaPlayPause: 'MediaPlayPause' };
  const numpad = { NumpadDecimal: 'numdec', NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv' };
  function fromEvent(event, platform = 'win32') {
    if (event.key === 'Escape') return { kind: 'cancel' };
    if (event.repeat) return { kind: 'ignore' };
    if (modifiers.has(event.key)) return { kind: 'modifier' };
    if (event.isComposing || ['Process', 'Dead', 'Unidentified'].includes(event.key) || event.getModifierState?.('AltGraph')) {
      return { kind: 'invalid', hint: '请切换到英文输入法后再录入。' };
    }
    let key = numpad[event.code];
    if (/^Numpad\d$/.test(event.code)) key = `num${event.code.slice(-1)}`;
    if (!key && /^Digit\d$/.test(event.code)) key = event.code.slice(-1);
    if (!key && /^[a-z0-9]$/i.test(event.key)) key = event.key.toUpperCase();
    if (!key && /^F(?:[1-9]|1\d|2[0-4])$/.test(event.key)) key = event.key;
    if (!key) key = keys[event.key];
    if (!key && event.key === '+') key = 'Plus';
    if (!key && /^[,.;'`\[\]\\/\-=]$/.test(event.key)) key = event.key;
    if (!key) return { kind: 'invalid', hint: '这个按键暂不支持，请换一个组合。' };
    if (!event.ctrlKey && !event.altKey && !event.metaKey && !/^F\d+$/.test(key)) {
      return { kind: 'invalid', hint: '请同时按住 Ctrl、Alt 或 Win/Cmd；也可直接使用 F1–F24。' };
    }
    const parts = [];
    if (event.ctrlKey) parts.push('Control');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push(platform === 'darwin' ? 'Command' : 'Super');
    parts.push(key);
    return { kind: 'shortcut', accelerator: parts.join('+'), releaseKey: event.code || event.key.toLowerCase() };
  }
  function display(accelerator, platform = 'win32') {
    return accelerator.split('+').map(part => ({ CommandOrControl: platform === 'darwin' ? 'Cmd' : 'Ctrl', Control: 'Ctrl',
      Command: 'Cmd', Super: platform === 'darwin' ? 'Cmd' : platform === 'win32' ? 'Win' : 'Super', Alt: platform === 'darwin' ? 'Option' : 'Alt' }[part] || part)).join(' + ');
  }
  const api = { fromEvent, display };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.petShortcuts = api;
})(globalThis);

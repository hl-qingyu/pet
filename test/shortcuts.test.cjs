const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fromEvent, display } = require('../renderer/shortcuts.js');
const event = (key, code, modifiers = {}) => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers });
test('keyboard capture maps real modifiers and keeps logical letters across layouts', () => {
  assert.equal(fromEvent(event('k', 'KeyK', { ctrlKey: true, altKey: true })).accelerator, 'Control+Alt+K');
  assert.equal(fromEvent(event('Q', 'KeyA', { ctrlKey: true, shiftKey: true })).accelerator, 'Control+Shift+Q');
  assert.equal(fromEvent(event('d', 'KeyD', { metaKey: true }), 'win32').accelerator, 'Super+D');
  assert.equal(fromEvent(event('d', 'KeyD', { metaKey: true, altKey: true }), 'darwin').accelerator, 'Alt+Command+D');
  assert.equal(display('Control+Alt+Shift+K'), 'Ctrl + Alt + Shift + K');
  assert.equal(display('Command+Alt+K', 'darwin'), 'Cmd + Option + K');
});
test('function keys, shifted digits, plus, arrows and numpad map to valid accelerator tokens', () => {
  for (const [input, accelerator] of [
    [event('F24', 'F24'), 'F24'], [event('@', 'Digit2', { ctrlKey: true, shiftKey: true }), 'Control+Shift+2'],
    [event('+', 'Equal', { ctrlKey: true, shiftKey: true }), 'Control+Shift+Plus'],
    [event('ArrowUp', 'ArrowUp', { ctrlKey: true }), 'Control+Up'],
    [event('1', 'Numpad1', { ctrlKey: true }), 'Control+num1'],
    [event('+', 'NumpadAdd', { altKey: true }), 'Alt+numadd'],
  ]) assert.equal(fromEvent(input).accelerator, accelerator);
});
test('capture rejects incomplete chords, plain typing, IME and key repeat', () => {
  assert.equal(fromEvent(event('Control', 'ControlLeft', { ctrlKey: true })).kind, 'modifier');
  assert.equal(fromEvent(event('a', 'KeyA')).kind, 'invalid');
  assert.equal(fromEvent(event('A', 'KeyA', { shiftKey: true })).kind, 'invalid');
  assert.equal(fromEvent(event('Process', 'KeyA', { ctrlKey: true, isComposing: true })).kind, 'invalid');
  assert.equal(fromEvent(event('a', 'KeyA', { ctrlKey: true, repeat: true })).kind, 'ignore');
  assert.equal(fromEvent(event('Escape', 'Escape', { ctrlKey: true })).kind, 'cancel');
});

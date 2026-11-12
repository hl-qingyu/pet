const fs = require('node:fs');
const path = require('node:path');

async function smokeWhaleRun({ petWindow, send, status, waitFor, dataRoot, scale }) {
  const execute = code => petWindow.webContents.executeJavaScript(code);
  const input = (type, x, y, extra = {}) => petWindow.webContents.sendInputEvent({ type, x, y, ...extra });
  const sample = () => execute(`({position:sprite.style.backgroundPosition,transform:art.style.transform,
    row,frame,drag,moved,hitTransform:sprite.style.transform})`);
  const point = { x: Math.round(145 * scale), y: Math.round(210 * scale) };
  petWindow.setIgnoreMouseEvents(false); petWindow.show(); petWindow.focus();
  await waitFor(() => petWindow.isFocused());
  input('mouseMove', point.x, point.y);
  input('mouseDown', point.x, point.y, { button: 'left', clickCount: 1 });
  await waitFor(() => execute('drag'));
  // Synthetic native moves do not advance screenX on every Windows runner.
  // Supply explicit screen coordinates through the same pointermove listener.
  await execute(`sprite.dispatchEvent(new PointerEvent('pointermove', {
    pointerId:1,screenX:dragStartX+25,screenY:dragStartY,buttons:1,bubbles:true}));`);
  await waitFor(() => execute('drag && moved'));
  const evidence = [];
  try {
    for (const [direction, mirrored] of [['running-right', true], ['running-left', false]]) {
      send(petWindow, 'pet:drag-direction', direction);
      await waitFor(() => execute(`row === ${mirrored ? 1 : 2} && art.style.transform.includes('scaleX(-1)') === ${mirrored}`));
      const columns = new Set(), until = Date.now() + 2500;
      while (columns.size < 8 && Date.now() < until) {
        const view = await sample();
        const [x,y] = view.position.split(' ').map(Number.parseFloat);
        if (y !== -416 || Boolean(view.hitTransform) || view.transform.includes('scaleX(-1)') !== mirrored) throw new Error('鲸鱼跑步朝向或拖动区域错误');
        columns.add(-x / 192);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      if (columns.size !== 8) throw new Error('鲸鱼跑步没有播放完整的八帧');
      evidence.push({ direction, columns: [...columns], mirrored });
      fs.writeFileSync(path.join(dataRoot, `whale-${direction}.png`), (await petWindow.webContents.capturePage()).toPNG());
    }
    // Hold the displayed frame while a real status update crosses the main-to-renderer boundary.
    await execute('next = performance.now() + 500');
    const before = await sample();
    send(petWindow, 'pet:drag-direction', 'running-right');
    await waitFor(() => execute('row === 1 && art.style.transform.includes("scaleX(-1)")'));
    const after = await sample();
    if (before.position !== after.position) throw new Error('转向不应重置当前步态');
    status('running');
    await waitFor(() => execute('state === "running"'));
    if ((await sample()).row !== 1) throw new Error('后台运行状态不应覆盖拖动方向');
  } finally {
    input('mouseUp', point.x + 25, point.y, { button: 'left', clickCount: 1 });
    await waitFor(() => execute('!drag'));
  }
  await waitFor(() => execute('row === 7'));
  status('idle');
  await execute(`sprite.dispatchEvent(new PointerEvent('pointerleave'));`);
  return { whaleDirectionalRun: evidence, strideRetainedOnTurn: true, dragStatusPriority: true, releaseRestoresWork: true, pass: true };
}
module.exports = { smokeWhaleRun };

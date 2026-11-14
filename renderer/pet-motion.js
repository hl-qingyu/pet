(function (root) {
  const timings = [[1680,660,660,840,840,1920],[120,120,120,120,120,120,120,220],[120,120,120,120,120,120,120,220],[140,140,140,280],[140,140,140,140,280],[280,280,280,280,280,280,280,480],[300,300,300,300,300,520],[120,120,120,120,120,220],[150,150,150,150,150,280]];
  const whaleTimings = {
    0: [360,180,140,180,240,420],
    1: [120,120,120,120,120,120,120,120],
    2: [120,120,120,120,120,120,120,120],
    5: [200,160,160,160,160,160,200,360],
    6: [200,180,180,220,240,360],
    7: [260,240,260,280,240,340],
    8: [100,100,100,100,100,100],
  };
  // 工作动画的源帧缩放不一致，按桌子宽度逐帧校正，避免播放时忽大忽小。
  const whaleScales = { 7: [1, 1, 0.97, 0.949, 1, 0.956] };
  function offset(theme, row, frame) {
    return 0;
  }
  function scale(theme, row, frame) {
    return (theme === 'whale' && whaleScales[row] && whaleScales[row][frame]) || 1;
  }
  function durations(theme, row) { return (theme === 'whale' && whaleTimings[row]) || timings[row]; }
  const api = { offset, durations, scale };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.petMotion = api;
})(globalThis);

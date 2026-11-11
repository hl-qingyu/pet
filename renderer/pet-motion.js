(function (root) {
  const timings = [[1680,660,660,840,840,1920],[120,120,120,120,120,120,120,220],[120,120,120,120,120,120,120,220],[140,140,140,280],[140,140,140,140,280],[280,280,280,280,280,280,280,480],[300,300,300,300,300,520],[120,120,120,120,120,220],[150,150,150,150,150,280]];
  const whaleTimings = {
    0: [360,180,140,180,240,420],
    5: [200,160,160,160,160,160,200,360],
    6: [200,180,180,220,240,360],
    7: [150,150,170,180,150,220],
    8: [100,100,100,100,100,100],
  };
  function offset(theme, row, frame) {
    return 0;
  }
  function durations(theme, row) { return (theme === 'whale' && whaleTimings[row]) || timings[row]; }
  const api = { offset, durations };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.petMotion = api;
})(globalThis);

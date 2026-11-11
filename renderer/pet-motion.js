(function (root) {
  const timings = [[1680,660,660,840,840,1920],[120,120,120,120,120,120,120,220],[120,120,120,120,120,120,120,220],[140,140,140,280],[140,140,140,140,280],[280,280,280,280,280,280,280,480],[150,150,150,150,150,260],[120,120,120,120,120,220],[150,150,150,150,150,280]];
  const whaleTimings = {
    5: [280,280,280,280,280,280,280,480],
    6: [300,300,300,300,300,520],
    7: [260,260,260,260,260,460],
    8: [300,300,300,300,300,520],
  };
  function offset(theme, row, frame) {
    return 0;
  }
  function durations(theme, row) { return (theme === 'whale' && whaleTimings[row]) || timings[row]; }
  const api = { offset, durations };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.petMotion = api;
})(globalThis);

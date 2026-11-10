(function (root) {
  const timings = [[1680,660,660,840,840,1920],[120,120,120,120,120,120,120,220],[120,120,120,120,120,120,120,220],[140,140,140,280],[140,140,140,140,280],[140,140,140,140,140,140,140,240],[150,150,150,150,150,260],[120,120,120,120,120,220],[150,150,150,150,150,280]];
  // Measured ground anchors in the reviewed whale atlas (3a990334...de4f50).
  // Keep a standing character planted without changing the source image or
  // its clipped frame. Walking rows and the 16 look poses retain their motion.
  const whaleAnchors = {
    0: [97,96.5,98,97.5,96.5,97.5,92],
    3: [91,87,77,81],
    4: [79,95,103,88,78],
    5: [97,110.5,118,119,124,105,89,85.5],
    6: [94,99,102.5,102,92,87],
    7: [96.5,97.5,92.5,90.5,85.5,87],
    8: [88,100,87.5,81.5,70.5,73.5],
  };
  const whaleTimings = {
    5: [280,280,280,280,280,280,280,480],
    6: [300,300,300,300,300,520],
    7: [260,260,260,260,260,460],
    8: [300,300,300,300,300,520],
  };
  function offset(theme, row, frame) {
    const anchor = theme === 'whale' ? whaleAnchors[row]?.[frame] : undefined;
    return anchor === undefined ? 0 : 92 - anchor;
  }
  function durations(theme, row) { return (theme === 'whale' && whaleTimings[row]) || timings[row]; }
  const api = { offset, durations };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.petMotion = api;
})(globalThis);

function createMockCtx(width, height) {
  const calls = [];
  return {
    canvas: { width, height },
    calls,
    fillStyle: null,
    font: null,
    textAlign: null,
    textBaseline: null,
    fillRect(...args) {
      calls.push(['fillRect', ...args]);
    },
    beginPath() {
      calls.push(['beginPath']);
    },
    arc(...args) {
      calls.push(['arc', ...args]);
    },
    fill() {
      calls.push(['fill']);
    },
    fillText(...args) {
      calls.push(['fillText', ...args]);
    },
  };
}

module.exports = { createMockCtx };

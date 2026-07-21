(function (root) {
  function computeBlockGrid(imageData, blockSize) {
    const { data, width, height } = imageData;
    const blocks = [];

    for (let by = 0; by < height; by += blockSize) {
      const h = Math.min(blockSize, height - by);
      for (let bx = 0; bx < width; bx += blockSize) {
        const w = Math.min(blockSize, width - bx);
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        const count = w * h;

        for (let y = by; y < by + h; y++) {
          for (let x = bx; x < bx + w; x++) {
            const i = (y * width + x) * 4;
            rSum += data[i];
            gSum += data[i + 1];
            bSum += data[i + 2];
          }
        }

        const r = rSum / count;
        const g = gSum / count;
        const b = bSum / count;
        const brightness = 0.299 * r + 0.587 * g + 0.114 * b;

        blocks.push({ x: bx, y: by, w, h, r, g, b, brightness });
      }
    }

    return blocks;
  }

  const api = { computeBlockGrid };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Filters = api;
  }
})(typeof window !== 'undefined' ? window : global);

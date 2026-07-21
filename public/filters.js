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

  function drawHalftone(ctx, blockGrid) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#fff';

    for (const block of blockGrid) {
      const radius = (block.brightness / 255) * (Math.min(block.w, block.h) / 2);
      if (radius <= 0) continue;
      ctx.beginPath();
      ctx.arc(block.x + block.w / 2, block.y + block.h / 2, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawAscii(ctx, blockGrid, charset) {
    const chars = charset || ' .:-=+*#%@';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const block of blockGrid) {
      const idx = Math.min(chars.length - 1, Math.floor((block.brightness / 255) * chars.length));
      const ch = chars[idx];
      ctx.font = `${Math.min(block.w, block.h)}px monospace`;
      ctx.fillText(ch, block.x + block.w / 2, block.y + block.h / 2);
    }
  }

  function computeSobelGrid(imageData) {
    const { data, width, height } = imageData;
    const gray = new Float64Array(width * height);

    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    }

    const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
    const magnitudes = new Array(width * height).fill(0);

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let sx = 0;
        let sy = 0;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const val = gray[(y + dy) * width + (x + dx)];
            sx += val * gx[k];
            sy += val * gy[k];
            k++;
          }
        }
        magnitudes[y * width + x] = Math.min(255, Math.sqrt(sx * sx + sy * sy));
      }
    }

    return { width, height, magnitudes };
  }

  function computeEdgeSketchPixels(sobelGrid, threshold) {
    const { width, height, magnitudes } = sobelGrid;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let i = 0; i < width * height; i++) {
      const v = magnitudes[i] >= threshold ? 0 : 255;
      const o = i * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }

    return { data, width, height };
  }

  function drawEdgeSketch(ctx, edgePixels) {
    const imageData = new ImageData(edgePixels.data, edgePixels.width, edgePixels.height);
    ctx.putImageData(imageData, 0, 0);
  }

  const api = {
    computeBlockGrid,
    drawHalftone,
    drawAscii,
    computeSobelGrid,
    computeEdgeSketchPixels,
    drawEdgeSketch,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Filters = api;
  }
})(typeof window !== 'undefined' ? window : global);

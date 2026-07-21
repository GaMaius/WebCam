(function () {
  const video = document.getElementById('source-video');
  const canvas = document.getElementById('output-canvas');
  const ctx = canvas.getContext('2d');
  const accessCodeInput = document.getElementById('access-code');
  const blockSizeInput = document.getElementById('block-size');
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const switchCameraBtn = document.getElementById('switch-camera-btn');
  const statusText = document.getElementById('status-text');
  const filterButtons = Array.from(document.querySelectorAll('.filter-btn'));

  let currentFilter = 'halftone';
  let facingMode = 'user';
  let stream = null;
  let mediaRecorder = null;
  let sessionId = null;
  let wakeLock = null;
  let rafId = null;
  let pendingUploads = [];

  function setStatus(text) {
    statusText.textContent = text;
  }

  function getAccessCode() {
    return accessCodeInput.value || '';
  }

  filterButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      currentFilter = btn.dataset.filter;
      filterButtons.forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  function renderFrame() {
    if (video.videoWidth === 0) {
      rafId = requestAnimationFrame(renderFrame);
      return;
    }

    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const blockSize = Number(blockSizeInput.value);

    if (currentFilter === 'halftone') {
      const blocks = window.Filters.computeBlockGrid(frame, blockSize);
      window.Filters.drawHalftone(ctx, blocks);
    } else if (currentFilter === 'ascii') {
      const blocks = window.Filters.computeBlockGrid(frame, blockSize);
      window.Filters.drawAscii(ctx, blocks);
    } else if (currentFilter === 'edge') {
      const sobel = window.Filters.computeSobelGrid(frame);
      const edgePixels = window.Filters.computeEdgeSketchPixels(sobel, 80);
      window.Filters.drawEdgeSketch(ctx, edgePixels);
    }

    rafId = requestAnimationFrame(renderFrame);
  }

  async function startRecording(mediaStream) {
    pendingUploads = [];
    const candidates = ['video/webm;codecs=vp8,opus', 'video/mp4'];
    const mimeType = window.RecordingUtils.pickSupportedMimeType(
      candidates,
      (type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)
    );

    if (!mimeType) {
      throw new Error('이 브라우저는 녹화를 지원하지 않습니다.');
    }

    const format = mimeType.includes('mp4') ? 'mp4' : 'webm';

    const startRes = await fetch('/session/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-access-code': getAccessCode(),
      },
      body: JSON.stringify({ format }),
    });

    if (!startRes.ok) {
      throw new Error('세션 시작 실패: 접근 코드를 확인하세요.');
    }

    const startBody = await startRes.json();
    sessionId = startBody.sessionId;

    mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      const uploadPromise = (async () => {
        const buffer = await event.data.arrayBuffer();
        await fetch(`/upload/${sessionId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-access-code': getAccessCode(),
          },
          body: buffer,
        });
      })();
      pendingUploads.push(uploadPromise);
    };
    mediaRecorder.start(3000);
  }

  async function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      await new Promise((resolve) => {
        mediaRecorder.addEventListener('stop', resolve, { once: true });
        mediaRecorder.stop();
      });
    }
    await Promise.all(pendingUploads);
    pendingUploads = [];
    if (sessionId) {
      await fetch(`/session/end/${sessionId}`, {
        method: 'POST',
        headers: { 'x-access-code': getAccessCode() },
      });
      sessionId = null;
    }
  }

  async function start() {
    if (startBtn.disabled) return;
    startBtn.disabled = true;

    try {
      const maxWidth = Math.min(window.innerWidth, 640);
      const constraints = window.RecordingUtils.buildVideoConstraints(maxWidth, facingMode);
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();

      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameraCount = devices.filter((d) => d.kind === 'videoinput').length;
      switchCameraBtn.hidden = cameraCount < 2;

      if ('wakeLock' in navigator) {
        try {
          wakeLock = await navigator.wakeLock.request('screen');
        } catch (err) {
          wakeLock = null;
        }
      }

      renderFrame();
      await startRecording(stream);

      stopBtn.disabled = false;
      setStatus('녹화 중...');
    } catch (err) {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
      }
      startBtn.disabled = false;
      throw err;
    }
  }

  async function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    await stopRecording();
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus('중지됨');
  }

  window.addEventListener('pagehide', () => {
    if (sessionId) {
      navigator.sendBeacon(`/session/end/${sessionId}`);
    }
  });

  startBtn.addEventListener('click', () => start().catch((err) => setStatus(`오류: ${err.message}`)));
  stopBtn.addEventListener('click', () => stop().catch((err) => setStatus(`오류: ${err.message}`)));
  switchCameraBtn.addEventListener('click', async () => {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    await stop();
    await start();
  });
})();

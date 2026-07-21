(function (root) {
  function pickSupportedMimeType(candidates, isSupportedFn) {
    for (const candidate of candidates) {
      if (isSupportedFn(candidate)) return candidate;
    }
    return null;
  }

  function buildVideoConstraints(maxWidth, facingMode) {
    return {
      video: {
        width: { ideal: maxWidth },
        facingMode: facingMode || 'user',
      },
      audio: true,
    };
  }

  const api = { pickSupportedMimeType, buildVideoConstraints };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.RecordingUtils = api;
  }
})(typeof window !== 'undefined' ? window : global);

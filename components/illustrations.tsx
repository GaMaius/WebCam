// Self-contained SVG illustrations for the how-it-works modals. No external
// image assets (keeps the app dependency-free and offline-friendly). Each
// uses currentColor so it inherits its module's accent from the modal.

export function HeartPulseHowto() {
  return (
    <svg width="100%" height="132" viewBox="0 0 320 132" fill="none" role="img" aria-label="얼굴 혈류에서 심박을 읽는 원리">
      {/* face */}
      <circle cx="90" cy="66" r="42" stroke="currentColor" strokeWidth="3" opacity="0.9" />
      {/* cheeks / forehead sample points */}
      <circle cx="90" cy="44" r="5" fill="currentColor" opacity="0.55" />
      <circle cx="72" cy="72" r="5" fill="currentColor" opacity="0.55" />
      <circle cx="108" cy="72" r="5" fill="currentColor" opacity="0.55" />
      {/* light rays */}
      <path d="M40 30l-14-8M44 20l-6-14M56 16l2-15" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.5" />
      {/* arrow to waveform */}
      <path d="M142 66h26" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="M162 60l8 6-8 6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {/* pulse waveform in a rounded panel */}
      <rect x="182" y="34" width="120" height="64" rx="14" stroke="currentColor" strokeWidth="3" opacity="0.9" />
      <path
        d="M192 66h14l6-18 10 34 7-24 5 8h13l6-12 8 22 5-10h13"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PersonalFrameHowto() {
  return (
    <svg width="100%" height="132" viewBox="0 0 320 132" fill="none" role="img" aria-label="전·후면 카메라로 피부 톤과 조명을 측정하는 원리">
      {/* front camera: face */}
      <circle cx="66" cy="60" r="38" stroke="currentColor" strokeWidth="3" opacity="0.9" />
      <circle cx="66" cy="52" r="4" fill="currentColor" opacity="0.5" />
      <path d="M52 74c6 8 22 8 28 0" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <text x="66" y="118" fontSize="13" fontWeight="700" fill="currentColor" textAnchor="middle" opacity="0.8">전면</text>
      {/* swap arrows */}
      <path d="M118 50h20M138 50l-6-5m6 5l-6 5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M138 70h-20M118 70l6-5m-6 5l6 5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* back camera: light + swatches */}
      <circle cx="196" cy="42" r="13" stroke="currentColor" strokeWidth="3" />
      <path d="M196 21v-8M214 42h8M178 42h-8M209 29l6-6M183 29l-6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.6" />
      <text x="196" y="118" fontSize="13" fontWeight="700" fill="currentColor" textAnchor="middle" opacity="0.8">후면</text>
      {/* corrected color swatches */}
      <rect x="244" y="30" width="26" height="26" rx="9" fill="currentColor" opacity="0.85" />
      <rect x="276" y="30" width="26" height="26" rx="9" fill="currentColor" opacity="0.5" />
      <rect x="244" y="62" width="26" height="26" rx="9" fill="currentColor" opacity="0.35" />
      <rect x="276" y="62" width="26" height="26" rx="9" fill="currentColor" opacity="0.65" />
    </svg>
  );
}

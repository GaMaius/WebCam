"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModuleShell } from "@/components/ModuleShell";
import { CameraView, type CameraHandle } from "@/components/CameraView";
import { Card } from "@/components/Card";
import { InfoModal } from "@/components/InfoModal";
import { ResultActions } from "@/components/ResultActions";
import { usePokematchScan } from "@/hooks/usePokematchScan";
import {
  pokemonImageUrl,
  loadEncoder,
  loadGallery,
  loadPokedex,
  type PokematchMatch,
} from "@/lib/pokematch/matcher";
import { drawPokematchCard } from "@/lib/resultCard";
import { uploadCapture } from "@/lib/backgroundRecorder";
import { typeColor } from "@/lib/typeColors";
import styles from "./page.module.css";

const ACCENT = "#d64541";
const STEPS = ["원리 안내", "얼굴 스캔", "결과"];
const ONBOARD_KEY = "visionlab:pokematch:onboarded";

function stepForPhase(phase: string, started: boolean): number {
  if (!started) return 0;
  if (phase === "done" || phase === "error") return 2;
  return 1;
}

export default function PokematchPage() {
  const scan = usePokematchScan();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [started, setStarted] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);

  // Bumped on scan completion so CameraView finalizes + uploads the recording
  // as one file while the page is still active.
  const [flushKey, setFlushKey] = useState(0);
  useEffect(() => {
    if (scan.phase === "done" || scan.phase === "error") setFlushKey((k) => k + 1);
  }, [scan.phase]);

  useEffect(() => {
    try {
      if (!localStorage.getItem(ONBOARD_KEY)) setModalOpen(true);
    } catch {
      setModalOpen(true);
    }
  }, []);

  // Warm the model + gallery caches while the user reads the intro, so the
  // scan starts without waiting on the (biggest) download. Fire-and-forget;
  // the scan reuses these cached promises.
  useEffect(() => {
    void loadEncoder().catch(() => {});
    void loadGallery().catch(() => {});
    void loadPokedex().catch(() => {});
  }, []);

  const handleReady = useCallback(
    (handle: CameraHandle) => {
      videoRef.current = handle.video;
      if (started && scan.phase === "idle" && !uploadPreview) void scan.start(handle.video);
    },
    [started, scan, uploadPreview]
  );

  useEffect(() => {
    if (started && videoRef.current && scan.phase === "idle" && !uploadPreview) {
      void scan.start(videoRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  const begin = useCallback(() => {
    try {
      localStorage.setItem(ONBOARD_KEY, "1");
    } catch {
      /* ignore */
    }
    setUploadPreview(null);
    setStarted(true);
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Camera sessions are always recorded and uploaded; an uploaded photo is
      // the same capture by another route, so it goes to the same B2 prefix.
      // Fire-and-forget — a storage hiccup must never block the scan.
      void uploadCapture(file, "pokematch", file.type || "image/jpeg").catch((err) => {
        console.error("pokematch photo upload failed:", err);
      });

      const url = URL.createObjectURL(file);
      setUploadPreview(url);
      setStarted(true);

      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        void scan.startWithImage(img);
      };
      img.onerror = () => {
        scan.reset();
      };
      img.src = url;
    },
    [scan]
  );

  const triggerUpload = useCallback(() => {
    try {
      localStorage.setItem(ONBOARD_KEY, "1");
    } catch {
      /* ignore */
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
  }, []);

  // Live countdown until the rate limit lifts.
  //
  // Driven off a DEADLINE rather than by decrementing a counter: an interval
  // that subtracts one per tick drifts, and browsers throttle timers in a
  // background tab, so a user who looks away and comes back would see a number
  // frozen where they left it. Recomputing from the deadline is correct
  // whenever it happens to run.
  const [retryIn, setRetryIn] = useState(0);
  useEffect(() => {
    if (scan.phase !== "done" || scan.engine !== "local" || scan.retryAfterSec <= 0) {
      setRetryIn(0);
      return;
    }
    const deadline = Date.now() + scan.retryAfterSec * 1000;
    // Faster than 1s so the final second doesn't visibly hang on "1초".
    const id = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRetryIn(left);
      if (left === 0) clearInterval(id);
    }, 250);
    setRetryIn(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    return () => clearInterval(id);
  }, [scan.phase, scan.engine, scan.retryAfterSec]);

  const handleRetry = useCallback(() => {
    setUploadPreview(null);
    if (videoRef.current) void scan.start(videoRef.current);
    else scan.reset();
  }, [scan]);

  const cardCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderCard = useCallback(async (): Promise<HTMLCanvasElement> => {
    if (!cardCanvasRef.current) cardCanvasRef.current = document.createElement("canvas");
    if (scan.matches) await drawPokematchCard(cardCanvasRef.current, scan.matches);
    return cardCanvasRef.current;
  }, [scan.matches]);

  return (
    <ModuleShell
      eyebrow="AI · GPT-OSS 120B 판정"
      title="PokéMatch"
      accent={ACCENT}
      steps={STEPS}
      activeStep={stepForPhase(scan.phase, started)}
      onHelp={() => setModalOpen(true)}
    >
      <input
        type="file"
        ref={fileInputRef}
        accept="image/*"
        onChange={handleFileChange}
        style={{ display: "none" }}
      />

      <InfoModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        accent={ACCENT}
        eyebrow="어떻게 찾나요"
        title="닮은 포켓몬을 찾아드려요"
        illustration={<PokeballIcon />}
        primaryLabel={!started ? "이해했어요, 시작" : undefined}
        onPrimary={!started ? begin : undefined}
      >
        <p>
          카메라로 얼굴을 찍거나 사진을 업로드하면, 브라우저에서 얼굴형·눈매·피부톤 같은 특징을 측정하고 포켓몬 1000여
          종과 비교해 후보를 추려요. 그다음 <b>GPT-OSS 120B</b> 언어모델이 그 측정값을 읽고 가장 닮은 5마리를 직접
          고르고 이유까지 설명해줘요.
        </p>
        <ul className={styles.modalTips}>
          <li>재미로 보는 결과예요 — 정밀한 얼굴 분석이 아니라 전체 인상 기반이에요.</li>
          <li>밝은 곳에서 정면이 잘 보이는 사진이나 위치를 권장해요.</li>
          <li>판정에는 사진이 아니라 측정된 수치(얼굴 비율·색상 값)만 전달돼요.</li>
        </ul>
      </InfoModal>

      <CameraView
        initialFacing="user"
        guide={started ? "face" : "none"}
        guideHint={started && scan.phase === "aligning" && !uploadPreview ? "얼굴을 가이드 안에 맞춰주세요" : undefined}
        recordLabel="pokematch"
        autoStart
        flushKey={flushKey}
        onReady={handleReady}
      />

      {!started && (
        <Card className={styles.startCard}>
          <h3 className={styles.startTitle}>닮은 포켓몬 찾기</h3>
          <p className={styles.startDesc}>
            카메라로 얼굴을 스캔하거나 사진을 업로드해서 가장 닮은 포켓몬 5마리를 찾아드려요.
          </p>
          <div className={styles.startActions}>
            <button className={styles.startBtn} onClick={begin}>
              📷 카메라 스캔
            </button>
            <button className={styles.uploadBtn} onClick={triggerUpload}>
              🖼️ 사진 업로드
            </button>
            <button className={styles.linkBtn} onClick={() => setModalOpen(true)}>
              어떻게 찾나요?
            </button>
          </div>
        </Card>
      )}

      {started && (scan.phase === "idle" || scan.phase === "loading" || scan.phase === "aligning") && (
        <Card className={styles.statusCard}>
          {uploadPreview && <img src={uploadPreview} className={styles.previewThumb} alt="선택한 얼굴 사진" />}
          <span className={styles.spinner} />
          {scan.phase === "loading" || scan.phase === "idle"
            ? "카메라 및 모델을 준비하는 중이에요…"
            : uploadPreview
            ? "사진에서 얼굴을 인식하는 중이에요…"
            : "얼굴을 찾는 중이에요 — 정면을 봐주세요."}
        </Card>
      )}

      {started && scan.phase === "scanning" && (
        <Card className={styles.resultCard}>
          <span>얼굴을 분석하는 중이에요… 잠깐만 기다려주세요.</span>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${Math.round(scan.progress * 100)}%` }} />
          </div>
        </Card>
      )}

      {started && scan.phase === "analyzing" && (
        <Card className={styles.statusCard}>
          {uploadPreview && <img src={uploadPreview} className={styles.previewThumb} alt="선택한 얼굴 사진" />}
          <span className={styles.spinner} />
          AI가 닮은 포켓몬을 고르는 중이에요…
        </Card>
      )}

      {started && scan.phase === "done" && scan.matches && (
        <Card className={styles.resultCard}>
          {/* Above the matches, not below: which engine produced them changes
              how much they're worth trusting, so it has to be read first. */}
          {scan.engine === "local" ? (
            <div className={styles.engineBanner}>
              <span className={styles.engineBannerIcon} aria-hidden="true">
                ⚠️
              </span>
              <div>
                <strong className={styles.engineBannerTitle}>AI가 고른 결과가 아니에요</strong>
                <span className={styles.engineBannerBody}>
                  {scan.fallbackCause === "quota"
                    ? "오늘 쓸 수 있는 AI 사용량을 다 썼어요. 내일 다시 열리기 전까지는 기본 유사도(z-score) 방식으로 찾은 결과가 나와요 — 얼굴 특징보다 전체적인 형태에 반응해 덜 정확할 수 있어요."
                    : scan.fallbackCause === "busy"
                    ? "지금 사용량이 많아서 AI 판정을 받지 못했어요. 대신 기본 유사도(z-score) 방식으로 찾은 결과라, 얼굴 특징보다 전체적인 형태에 반응해 덜 정확할 수 있어요."
                    : "AI 판정을 불러오지 못했어요. 대신 기본 유사도(z-score) 방식으로 찾은 결과라, 얼굴 특징보다 전체적인 형태에 반응해 덜 정확할 수 있어요."}
                </span>
                {/* A daily budget doesn't come back today, so offering a retry
                    would just spend another failed request. */}
                {scan.fallbackCause !== "quota" && (
                  <button
                    className={styles.engineRetry}
                    onClick={handleRetry}
                    disabled={retryIn > 0}
                  >
                    {retryIn > 0 ? `${retryIn}초 후 다시 찾기` : "AI로 다시 찾기"}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <span className={styles.engineOk}>✨ AI가 사진을 보고 골랐어요</span>
          )}
          <h3 className={styles.resultTitle}>가장 닮은 포켓몬</h3>
          <div className={styles.matchList}>
            {scan.matches.map((m, i) => (
              <MatchRow key={m.slug} match={m} top={i === 0} />
            ))}
          </div>
          <ResultActions
            render={renderCard}
            filename={`visionlab-pokematch-${Date.now()}.png`}
            shareTitle="VisionLab · 닮은 포켓몬"
            shareText="내가 닮은 포켓몬을 찾아봤어요!"
          />
          <div className={styles.startActions}>
            <button className={styles.retryBtn} onClick={handleRetry}>
              📷 카메라로 다시 찾기
            </button>
            <button className={styles.uploadBtn} onClick={triggerUpload}>
              🖼️ 다른 사진 업로드
            </button>
          </div>

          {scan.debugText && (
            <div className={styles.debugBox}>
              <div className={styles.debugHead}>
                <span>디버그 데이터 (개발용)</span>
                <button
                  className={styles.debugCopy}
                  onClick={() => navigator.clipboard?.writeText(scan.debugText ?? "")}
                >
                  전체 복사
                </button>
              </div>
              <textarea className={styles.debugText} readOnly value={scan.debugText} onFocus={(e) => e.currentTarget.select()} />
            </div>
          )}
        </Card>
      )}

      {started && scan.phase === "error" && (
        <Card className={styles.errorCard}>
          <p>{scan.errorMessage}</p>
          <div className={styles.startActions}>
            <button className={styles.retryBtn} onClick={handleRetry}>
              📷 카메라로 다시 시도
            </button>
            <button className={styles.uploadBtn} onClick={triggerUpload}>
              🖼️ 다른 사진 업로드
            </button>
          </div>
        </Card>
      )}
    </ModuleShell>
  );
}

function MatchRow({ match, top }: { match: PokematchMatch; top: boolean }) {
  const e = match.entry;
  const nameKo = e?.nameKo ?? e?.nameEn ?? match.slug;
  const dex = e?.dex ? `#${e.dex} ` : "";
  const types = e?.typesKo ?? [];
  return (
    <div className={`${styles.match} ${top ? styles.matchTop : ""}`}>
      <img
        className={styles.thumb}
        src={pokemonImageUrl(match.slug)}
        alt={nameKo}
        loading="lazy"
        onError={(ev) => {
          ev.currentTarget.style.visibility = "hidden";
        }}
      />
      <div className={styles.matchBody}>
        <span className={styles.matchName}>
          {dex}
          {nameKo} {e?.nameEn && <span className={styles.en}>({e.nameEn.toLowerCase()})</span>}
        </span>
        <span className={styles.matchPct}>
          닮은 정도: <b>{match.percent}%</b>
        </span>
        {match.reason && <span className={styles.matchReason}>{match.reason}</span>}
        <div className={styles.badges}>
          {types.map((t) => {
            const c = typeColor(t);
            return (
              <span key={t} className={styles.badge} style={{ background: c.bg, color: c.fg }}>
                {t}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PokeballIcon() {
  return (
    <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h6M15 12h6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ModuleShell } from "@/components/ModuleShell";
import { CameraView, type CameraHandle } from "@/components/CameraView";
import { Card } from "@/components/Card";
import { InfoModal } from "@/components/InfoModal";
import { ResultActions } from "@/components/ResultActions";
import { usePokematchScan } from "@/hooks/usePokematchScan";
import { pokemonImageUrl, type PokematchMatch } from "@/lib/pokematch/matcher";
import { drawPokematchCard } from "@/lib/resultCard";
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
  const [started, setStarted] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(ONBOARD_KEY)) setModalOpen(true);
    } catch {
      setModalOpen(true);
    }
  }, []);

  const handleReady = useCallback(
    (handle: CameraHandle) => {
      videoRef.current = handle.video;
      if (started && scan.phase === "idle") void scan.start(handle.video);
    },
    [started, scan]
  );

  useEffect(() => {
    if (started && videoRef.current && scan.phase === "idle") void scan.start(videoRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  const begin = useCallback(() => {
    try {
      localStorage.setItem(ONBOARD_KEY, "1");
    } catch {
      /* ignore */
    }
    setStarted(true);
  }, []);

  const handleRetry = useCallback(() => {
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
      eyebrow="AI · 이미지 임베딩"
      title="PokéMatch"
      accent={ACCENT}
      steps={STEPS}
      activeStep={stepForPhase(scan.phase, started)}
      onHelp={() => setModalOpen(true)}
    >
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
          카메라로 얼굴을 찍으면, AI가 얼굴의 시각적 특징을 벡터로 뽑아 포켓몬 1000여 종의 특징과
          비교해 가장 닮은 순으로 5마리를 보여줘요.
        </p>
        <ul className={styles.modalTips}>
          <li>재미로 보는 결과예요 — 정밀한 얼굴 분석이 아니라 전체 인상 기반이에요.</li>
          <li>밝은 곳에서 정면을 바라봐 주세요. 잠깐 움직이지 않으면 더 정확해요.</li>
        </ul>
      </InfoModal>

      <CameraView
        initialFacing="user"
        guide={started ? "face" : "none"}
        guideHint={started && scan.phase === "aligning" ? "얼굴을 가이드 안에 맞춰주세요" : undefined}
        recordLabel="pokematch"
        autoStart
        onReady={handleReady}
      />

      {!started && !modalOpen && (
        <Card className={styles.startCard}>
          <h3 className={styles.startTitle}>닮은 포켓몬 찾기</h3>
          <p className={styles.startDesc}>얼굴을 스캔해서 가장 닮은 포켓몬 5마리를 찾아드려요.</p>
          <div className={styles.startActions}>
            <button className={styles.startBtn} onClick={begin}>
              시작하기
            </button>
            <button className={styles.linkBtn} onClick={() => setModalOpen(true)}>
              어떻게 찾나요?
            </button>
          </div>
        </Card>
      )}

      {started && (scan.phase === "loading" || scan.phase === "aligning") && (
        <Card className={styles.statusCard}>
          <span className={styles.spinner} />
          {scan.phase === "loading" ? "모델을 불러오는 중이에요…" : "얼굴을 찾는 중이에요 — 정면을 봐주세요."}
        </Card>
      )}

      {started && scan.phase === "scanning" && (
        <Card className={styles.resultCard}>
          <span>얼굴을 분석하는 중이에요… 잠깐 움직이지 마세요.</span>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${Math.round(scan.progress * 100)}%` }} />
          </div>
        </Card>
      )}

      {started && scan.phase === "analyzing" && (
        <Card className={styles.statusCard}>
          <span className={styles.spinner} />
          닮은 포켓몬을 찾는 중이에요…
        </Card>
      )}

      {started && scan.phase === "done" && scan.matches && (
        <Card className={styles.resultCard}>
          <h3 className={styles.resultTitle}>가장 닮은 포켓몬</h3>
          <div className={styles.matchList}>
            {scan.matches.map((m, i) => (
              <MatchRow key={m.slug} match={m} top={i === 0} />
            ))}
          </div>
          <ResultActions
            render={renderCard}
            filename={`visionlab-pokematch-${Date.now()}.png`}
            shareTitle="VisionLab AI · 닮은 포켓몬"
            shareText="내가 닮은 포켓몬을 찾아봤어요!"
          />
          <button className={styles.retryBtn} onClick={handleRetry}>
            다시 찾기
          </button>
        </Card>
      )}

      {started && scan.phase === "error" && (
        <Card className={styles.errorCard}>
          <p>{scan.errorMessage}</p>
          <button className={styles.retryBtn} onClick={handleRetry}>
            다시 시도
          </button>
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
          {nameKo} {e?.nameEn && <span className="en">({e.nameEn.toLowerCase()})</span>}
        </span>
        <span className={styles.matchPct}>
          닮은 정도: <b>{match.percent}%</b>
        </span>
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

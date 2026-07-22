"use client";

import { ModuleShell } from "@/components/ModuleShell";
import { CameraView } from "@/components/CameraView";
import { Card } from "@/components/Card";
import styles from "./page.module.css";

export default function HeartPulsePage() {
  return (
    <ModuleShell
      eyebrow="rPPG · 생체 신호"
      title="HeartPulse"
      accent="#f78ca0"
      steps={["카메라 정렬", "15초 스캔", "결과 리포트"]}
      activeStep={0}
    >
      <CameraView
        initialFacing="user"
        guide="face"
        guideHint="이마와 양 뺨이 가이드 안에 들어오도록 정렬하세요"
        recordModule="heartpulse"
      />

      <Card className={styles.info}>
        <h3 className={styles.infoTitle}>측정 준비</h3>
        <ul className={styles.tips}>
          <li>밝고 균일한 조명 아래에서 정면을 바라봐 주세요.</li>
          <li>측정 15초 동안 머리를 움직이지 않도록 유지합니다.</li>
          <li>이마·뺨의 미세한 혈류 변화로 심박(BPM)을 추정합니다.</li>
        </ul>
        <p className={styles.pending}>
          실시간 PPG 파형 분석 엔진은 다음 단계에서 연결됩니다.
        </p>
      </Card>
    </ModuleShell>
  );
}

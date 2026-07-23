"use client";

import { ModuleShell } from "@/components/ModuleShell";
import { CameraView } from "@/components/CameraView";
import { Card } from "@/components/Card";
import styles from "./page.module.css";

export default function PersonalFramePage() {
  return (
    <ModuleShell
      eyebrow="CIELAB · 스타일"
      title="PersonalFrame"
      accent="#92a9e1"
      steps={["전면 · 얼굴 스캔", "후면 · 조명 보정", "톤 & 골격 진단"]}
      activeStep={0}
    >
      <CameraView
        initialFacing="user"
        guide="face"
        guideHint="얼굴 전체가 가이드 안에 들어오도록 맞춰주세요"
        recordModule="personalframe"
        autoStart
      />

      <Card className={styles.info}>
        <h3 className={styles.infoTitle}>순차 스캔 방식</h3>
        <p className={styles.desc}>
          모바일 브라우저는 전·후면 카메라를 동시에 쓸 수 없어, 두 단계로 나눠 진행합니다.
        </p>
        <ol className={styles.flow}>
          <li>
            <strong>전면</strong> — 얼굴 3D 메쉬와 1차 피부 톤을 추출합니다.
          </li>
          <li>
            <strong>후면 전환</strong> — 주변 조명 색온도를 측정해 색편향을 보정(Gray World)합니다.
          </li>
          <li>
            <strong>최종 진단</strong> — 조명이 정규화된 CIELAB 톤과 얼굴 골격을 산출합니다.
          </li>
        </ol>
        <p className={styles.pending}>
          CIELAB 변환·Face Mesh 골격 연산 엔진은 다음 단계에서 연결됩니다.
        </p>
      </Card>
    </ModuleShell>
  );
}

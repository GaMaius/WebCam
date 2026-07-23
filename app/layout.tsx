import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VisionLab AI — 생체 신호 & 스타일 통합 분석",
  description:
    "카메라 하나로 심박·스트레스(rPPG)와 퍼스널 컬러·얼굴 골격을 측정하는 셀프 비전 스캔. 온디바이스 분석으로 매일의 컨디션과 스타일을 기록하세요.",
};

export const viewport: Viewport = {
  themeColor: "#f5efe0",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

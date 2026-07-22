import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VisionLab AI — 생체 신호 & 스타일 통합 분석",
  description:
    "설치·로그인 없이 웹캠으로 심박수/스트레스(rPPG)와 퍼스널 컬러·얼굴 골격을 과학적으로 분석하는 원스톱 비전 분석 웹 서비스.",
};

export const viewport: Viewport = {
  themeColor: "#16161c",
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

import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VisionLab",
  description:
    "카메라 하나로 나를 스캔하는 셀프 스캔 앱 모음 — 심박·스트레스, 퍼스널 컬러·얼굴형, 닮은 포켓몬 찾기. 브라우저에서 바로.",
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

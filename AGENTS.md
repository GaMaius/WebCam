# VisionLab — 에이전트 안내

**프로젝트 컨텍스트는 [`CLAUDE.md`](./CLAUDE.md) 한 곳에만 있다. 작업 전에 그 파일을 읽을 것.**

이 파일은 예전에 CLAUDE.md를 Codex용으로 복사해둔 미러였는데, 두 벌을 손으로 맞추다 보니
내용이 어긋나서(구버전이 최신 결론과 반대되는 서술을 담고 있었다) 포인터로 바꿨다.
컨텍스트를 갱신할 일이 있으면 **CLAUDE.md만** 고치면 된다.

빠른 요약만 필요하면:

- Next.js 15 + TypeScript 웹앱. **`visionlab` 브랜치가 실제 제품**이고 `master`는 예전 더미(Express 웹캠 필터)라 참고하지 말 것.
- 제품 컨셉 = "카메라로 나를 스캔하는 독립 앱 모음". 홈은 `lib/apps.ts` 레지스트리를 렌더링하는 런처(앱 추가 = 항목 1개 + `app/<slug>` 라우트).
- 개발: `npm run dev`, `npm run build`, `npm test`(Node 내장 `node --test`).
- 작업이 끝나면 **커밋 후 `git push origin visionlab`** 까지 진행한다(사용자 지시, 배포가 여기에 붙어 있다).

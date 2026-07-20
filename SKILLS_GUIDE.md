# 설치한 스킬 사용 가이드

2026-07-20 기준으로 설치/확인한 스킬 정리. 스킬은 대부분 Claude가 대화 맥락에 맞춰 **자동으로** 호출하며, 이름을 알고 있다면 명시적으로 "OO 스킬 써서 ~해줘"라고 요청해도 된다.

---

## 1. 프로젝트 스킬 (`C:\skill_prac\.claude\skills`)

### pptx
- **출처**: `anthropics/skills`
- **상태**: ✅ 정상 동작 확인함 (pptxgenjs로 테스트 파일 생성 → zip 무결성/슬라이드 내용 검증 완료)
- **용도**: `.pptx` 파일 생성·읽기·편집
- **트리거 예시**: "OO 주제로 PPT 만들어줘", "이 pptx에서 텍스트 추출해줘", "슬라이드 3장짜리 pptx 만들어줘"
- **주의**: 이 머신에는 LibreOffice(`soffice`)와 Poppler(`pdftoppm`)가 없어서, 스킬이 QA 단계에서 쓰는 "슬라이드 → 이미지 변환" 기능은 동작하지 않음. 텍스트 검증(`markitdown`)도 별도 설치 필요.
  - 필요 시: `pip install "markitdown[pptx]"`, LibreOffice/Poppler 설치

### grill-me
- **출처**: `mattpocock/skills`
- **상태**: ⚠️ 깨진 상태 — 내용이 `/grilling` 커맨드를 실행하라고만 되어 있는데, 그 커맨드 자체가 프로젝트 어디에도 정의되어 있지 않음
- **의도된 용도**: 계획/설계안을 집요하게 파고드는 인터뷰(레드팀 질문)로 허점을 찾아줌
- **현재는 사용 불가** — `/grilling` 커맨드 소스를 별도로 찾아 설치하거나, 이 스킬을 제거하는 게 나음

---

## 2. 전역 스킬 — Superpowers 컬렉션 (`obra/superpowers`, `~/.claude/skills`)

메타 규칙(`using-superpowers`)이 항상 먼저 로드되어, 대화 상황에 맞는 하위 스킬을 Claude가 강제로 먼저 호출하도록 유도한다. 즉 아래 스킬들은 대부분 **사람이 직접 부르지 않아도** 상황에 맞으면 자동으로 켜진다.

| 스킬 | 언제 쓰이나 |
|---|---|
| `using-superpowers` | 모든 대화 시작 시 — "관련 스킬이 있으면 반드시 먼저 써라"는 규칙을 강제하는 디스패처 |
| `brainstorming` | 기능 추가/컴포넌트 생성/동작 변경 등 **창작성 작업 전** — 요구사항과 의도를 먼저 정리 |
| `writing-plans` | 스펙이 있는 멀티스텝 작업을 시작하기 **전**, 코드를 건드리기 전에 계획서 작성 |
| `executing-plans` | 이미 작성된 구현 계획을 리뷰 체크포인트가 있는 별도 세션에서 실행할 때 |
| `subagent-driven-development` | 독립적인 작업들로 나뉜 계획을 현재 세션에서 서브에이전트로 실행할 때 |
| `dispatching-parallel-agents` | 서로 의존성 없는 작업이 2개 이상일 때 병렬 처리 |
| `test-driven-development` | 기능/버그 수정 구현 **전** — 테스트부터 작성 |
| `systematic-debugging` | 버그, 테스트 실패, 예상치 못한 동작을 마주쳤을 때 — 원인 분석 전 |
| `using-git-worktrees` | 현재 작업공간과 분리가 필요한 기능 작업 시작 시 |
| `requesting-code-review` | 작업/주요 기능 완료 후, 머지 전에 리뷰 요청 |
| `receiving-code-review` | 코드 리뷰 피드백을 받았을 때 — 무비판적 수용 대신 기술적으로 검증 |
| `verification-before-completion` | "완료했다/고쳤다/통과했다"고 주장하기 전 — 실제로 검증 명령 실행하고 결과 확인 |
| `finishing-a-development-branch` | 구현과 테스트가 끝난 후 — merge/PR/cleanup 중 어떻게 마무리할지 구조화된 선택지 제시 |
| `writing-skills` | 새 스킬을 만들거나 기존 스킬을 수정/검증할 때 |

### 사용 팁
- **자동 트리거가 기본**: `using-superpowers`가 있는 한 "간단한 질문 같아 보여도" 관련 스킬을 먼저 켜려고 시도함. 원치 않으면 "스킬 없이 바로 답해줘"라고 명시하면 됨.
- **수동 호출**: 특정 스킬을 바로 쓰고 싶으면 "brainstorming 스킬로 이 아이디어 정리해줘"처럼 이름을 언급.
- **전형적인 흐름**: `brainstorming` → `writing-plans` → (`executing-plans` 또는 `subagent-driven-development`) → `test-driven-development` → `systematic-debugging`(문제 생기면) → `requesting-code-review`/`receiving-code-review` → `verification-before-completion` → `finishing-a-development-branch`

### 참고
- `/plugin marketplace add`, `/plugin install` 커맨드는 이 환경(터미널 대화형 패널)에서 지원되지 않음 → 대신 `npx skills add <owner/repo@skill> -g -y`로 동일하게 global 설치 완료.
- 설치 시 각 스킬은 Gen/Socket/Snyk 보안 스캔에서 모두 Safe / Low Risk로 통과.

---

## 3. 그 외 이미 있던 전역 스킬

같은 설치 작업 중 `code-review`, `frontend-design`, `security-review`도 전역에 존재하는 것을 확인함 (superpowers와 별개로 이전에 설치된 것으로 보임). 각각 diff 리뷰, UI/디자인 가이드, 보안 리뷰 용도.

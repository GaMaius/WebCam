# WebCam - 실시간 웹캠 필터 & 녹화 수집 서비스

실시간으로 웹캠 영상에 하프톤(Halftone), ASCII, 엣지 스케치(Edge Sketch) 필터를 적용하고, 원본 영상을 서버에 녹화 저장하는 웹 애플리케이션입니다.

## 🚀 Render.com 배포 방법

Render(https://render.com)의 무료 플랜(Free Tier)을 사용하여 클릭 몇 번으로 쉽게 배포할 수 있습니다.

### 1단계: Render에 로그인 및 저장소 연결
1. [Render.com](https://render.com) 접속 후 GitHub 계정으로 로그인합니다.
2. Dashboard에서 **New +** 버튼을 누르고 **Web Service**를 선택합니다.
3. GitHub 저장소 중 `GaMaius/WebCam`을 연결(Connect)합니다.

### 2단계: 배포 설정 확인
Render가 프로젝트의 `render.yaml` 및 `package.json`을 자동으로 감지합니다.
* **Name**: `webcam-filter-app` (원하는 이름 설정 가능)
* **Runtime**: `Node`
* **Build Command**: `npm install`
* **Start Command**: `npm start`
* **Instance Type**: `Free`

### 3단계: 환경 변수(Environment Variable) 설정
페이지 하단의 **Environment Variables** 항목에서 보안 코드를 설정합니다:
* **Key**: `ACCESS_CODE`
* **Value**: `비밀번호` (예: `changeme` 또는 설정하고 싶은 비밀번호)

### 4단계: 배포 실행
1. **Deploy Web Service** 버튼을 누릅니다.
2. 빌드가 완료되면 `https://webcam-xxxx.onrender.com` 과 같은 무료 HTTPS 주소가 생성됩니다.
3. 해당 주소로 접속하면 브라우저에서 웹캠 카메라 권한 요청을 받고 즉시 정상 작동합니다!

---

## 🛠️ 로컬 실행 방법

```bash
# 1. 의존성 설치
npm install

# 2. .env 파일 생성 및 설정
# ACCESS_CODE=changeme

# 3. 서버 실행
npm start
# http://localhost:3000 접속
```

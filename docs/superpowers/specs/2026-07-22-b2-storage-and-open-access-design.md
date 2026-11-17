# B2 오브젝트 스토리지 연동 & 접근 방식 변경 설계

## 목적

Render.com 무료 플랜은 디스크가 휘발성이라 재배포/재시작 때마다 `recordings/` 폴더의 녹화 파일이 사라진다. 이를 해결하기 위해 녹화 데이터를 Backblaze B2(오브젝트 스토리지)에 저장하도록 서버를 변경한다. 동시에, 접근 코드를 완전히 제거하고 이름 입력으로 대체하며, 촬영 안내 문구도 제거한다.

## 배경 — 알려진 트레이드오프 (사용자 확인 완료)

- **접근 코드 제거**: 지금까지는 Render에 공개 배포된 사이트를 낯선 사람이 두드려 업로드 API를 스팸하는 것을 막는 최소한의 장치였다. 완전히 제거하면 URL만 아는 누구나 업로드 API를 호출할 수 있게 되어 B2 저장 용량/과금 리스크가 생긴다. 사용자가 이 리스크를 인지하고 무보호 공개로 진행하기로 확정했다.
- **촬영 안내 문구 제거**: 친구들이 본인이 녹화되고 있다는 사실을 화면에서 안내받지 못한다. 사용자가 이를 인지하고 제거하기로 확정했다.

## 1. 오브젝트 스토리지: Backblaze B2

- B2의 S3 호환 API를 사용한다 (`@aws-sdk/client-s3`, `endpoint`만 B2로 지정).
- 로컬 디스크(`recordings/` 폴더) 저장은 완전히 제거한다. 청크는 세션별 인메모리 버퍼에만 잠깐 머물다가 B2로 올라간다.

### 데이터 흐름

```
[브라우저] --3초 청크--> [Express 서버]
                              │
                              ▼
                    세션별 메모리 버퍼 (Buffer 배열)
                              │
                    버퍼 합계 >= 5MB ?
                         │yes         │no (계속 대기)
                         ▼
              B2에 멀티파트 파트로 업로드
              (UploadPartCommand, ETag 기록)
                              │
        세션 종료 시: 남은 버퍼(5MB 미만)를
        마지막 파트로 업로드 → CompleteMultipartUpload
```

- S3 멀티파트 업로드는 마지막 파트를 제외한 모든 파트가 최소 5MB 이상이어야 하므로, 3초 청크를 즉시 업로드하지 않고 5MB가 될 때까지 메모리에 모았다가 하나의 파트로 올린다. 마지막 파트는 5MB 미만이어도 된다.
- 파트 업로드 실패 시 최대 3회, 짧은 backoff로 재시도한다. 그래도 실패하면 서버 로그(Render 로그에서 확인 가능)에 에러를 남기고 세션은 계속 진행한다 (해당 파트만 유실, 전체 세션은 끊기지 않음). 재시도 큐 등 추가 인프라는 만들지 않는다.
- 서버가 중간에 죽어(재배포 등) `CompleteMultipartUpload`가 호출되지 못하면 B2에 미완성 멀티파트 업로드가 남을 수 있다. 이는 코드로 처리하지 않고, B2 버킷의 Lifecycle Rule(예: 7일 후 미완성 업로드 자동 삭제)로 정리하도록 사용자가 버킷 설정에서 1회 지정한다.

### 서버 변경 (`server/app.js`)

- `POST /session/start`: 로컬 파일 스트림 대신 B2에 `CreateMultipartUploadCommand`를 호출해 `uploadId`를 발급받고, 세션 상태로 `{ uploadId, key, buffer: [], bufferedBytes: 0, partNumber: 1, uploadedParts: [] }`를 저장한다. 객체 키는 `${sanitizedName}-${sessionId}.${ext}` 형태로 만든다 (아래 "이름 입력" 참고).
- `POST /upload/:sessionId`: 청크를 세션의 메모리 버퍼에 append. 버퍼 총합이 5MB 이상이면 `UploadPartCommand`로 업로드하고 `ETag`를 `uploadedParts`에 기록, 버퍼 비우고 `partNumber` 증가.
- `POST /session/end/:sessionId`: 버퍼에 남은 마지막 조각을 업로드한 뒤 `CompleteMultipartUploadCommand`로 마무리.
- `checkAccessCode` 미들웨어와 `ACCESS_CODE` 환경변수는 완전히 제거한다.

### 환경 변수 (`.env`)

```
B2_ENDPOINT=https://s3.<region>.backblazeb2.com
B2_REGION=<region>
B2_BUCKET=<버킷명>
B2_KEY_ID=<Application Key ID>
B2_APPLICATION_KEY=<Application Key>
```

`RECORDINGS_DIR`, `ACCESS_CODE` 환경변수는 더 이상 쓰이지 않으므로 제거한다.

## 2. 접근 방식 변경: 이름 입력으로 대체

- 접근 코드 입력창을 제거하고, 그 자리에 "이름" 텍스트 입력창을 둔다. 비어 있으면 "웹캠 시작" 버튼이 동작하지 않도록 간단히 막는다 (이름 없이는 어떤 녹화인지 구분할 수 없으므로).
- 입력된 이름은 `/session/start` 요청 본문(`{ format, name }`)에 실려 서버로 전달되고, 위에서 설명한 대로 B2 객체 키에 반영된다. 파일시스템/URL에 안전하지 않은 문자(공백, 슬래시 등)는 서버에서 간단히 치환한다.
- 모든 엔드포인트에서 `x-access-code` 헤더 관련 코드를 제거한다 (`main.js`의 `getAccessCode()`, 관련 fetch 헤더 전부 삭제).

## 3. 촬영 안내 문구 제거

- `public/index.html`에서 `<p class="notice">이 화면은 촬영되어 서버에 저장됩니다.</p>` 문단을 삭제한다. 관련 CSS(`.notice`)도 함께 정리한다.

## 4. 사용자가 직접 해야 할 일 (B2 계정/버킷 준비)

1. [Backblaze 가입](https://www.backblaze.com/) (본인이 직접)
2. B2 콘솔에서 Bucket 생성 (Private), 버킷 이름과 리전(예: `us-west-004`) 확인
3. Application Keys 메뉴에서 해당 버킷에 대한 읽기/쓰기 권한의 Application Key 발급 → `keyID`와 `applicationKey` 값을 받음 (화면을 벗어나면 `applicationKey`는 다시 볼 수 없으므로 바로 복사)
4. 버킷 설정에서 Lifecycle Rule을 "미완성 대용량 파일은 N일 후 삭제"로 설정
5. 위 값(`keyID`, `applicationKey`, 버킷명, 리전, 엔드포인트)을 전달하면 `.env`에 반영하고, Render 환경변수 등록 방법을 안내한다 (Render 환경변수 입력 자체는 본인 계정으로 직접 진행)

## 5. 테스트 방향

- `server/app.js`의 B2 연동 로직은 `@aws-sdk/client-s3`의 `S3Client`를 목(mock)으로 대체해 단위 테스트한다 (실제 B2 호출 없이): 5MB 미만 청크 누적 시 업로드 안 함, 5MB 이상 누적 시 `UploadPartCommand` 호출, 세션 종료 시 남은 버퍼로 마지막 파트 업로드 + `CompleteMultipartUploadCommand` 호출 확인.
- 이름 입력 검증(빈 값 처리, 특수문자 치환)은 순수 함수로 분리해 단위 테스트한다.
- 브라우저 수동 검증: 이름 입력 후 웹캠 시작 → 촬영 안내 문구가 없는지, 접근 코드 입력창이 없는지 확인 → 종료 후 B2 버킷에 실제로 파일이 생성되는지 확인.

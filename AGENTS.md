# AGENTS.md — 학습 일정 관리 웹앱 작업 규칙

## 프로젝트 소개
- 개인 일정 관리 웹앱 `check`. 날짜가 있는 일정과 날짜 없는 할 일을 관리한다.
- React와 Next.js App Router를 사용한다. 상세 기획은 `docs/plan.md`, 요청 설계는 `docs/prompt-design.md`를 참고한다.

## 파일 구성
- `app/layout.jsx`: HTML 문서 틀과 `style.css` 불러오기.
- `app/page.jsx`: 화면과 React 상태 관리.
- `app/planner.js`: 날짜·일정 계산. `app/api.js`: 서버 API 호출과 로그인 토큰.
- `api/main.py`: FastAPI 저장 API (로그인, items, settings). Postgres에 저장한다.
- `style.css`: 전역 디자인. `next.config.mjs`는 정적 내보내기와 `BASE_PATH`(배포 시 `/check`)를 설정한다.
- `Dockerfile`, `api/Dockerfile`, `compose.yml`, `deploy/`: 집 서버 배포 구성. `.github/workflows/ci.yml`은 빌드 검사만 한다.
- `index.html`과 `app.js`는 이전 버전 및 데이터 이전용이다.
- `docs/`: 기획서·설계서·점검표·기록. 앱 코드를 넣지 않는다.

## 작업 규칙
- 새 앱 코드는 `app/`과 `style.css`에서 수정한다. 기존 기능과 저장 키를 유지한다.
- 한 번에 한 기능씩 바꾸고, 바꾼 뒤에는 무엇을 왜 바꿨는지 짧게 설명한다.
- 복잡한 코드에는 고등학생이 읽을 수 있는 짧은 한국어 주석을 단다.
- 요청이 모호하면 먼저 질문한다. 파일 삭제나 Git 기록 변경은 실행 전에 허락을 받는다.

## 도구와 권한
- Node.js 20.9 이상, npm, 브라우저, Git을 사용한다.
- 의존성은 `package.json`에 명시한다. 요청하지 않은 외부 서비스나 CDN을 추가하지 않는다.
- 작업 폴더 밖의 파일을 읽거나 고치지 않는다.

## 데이터와 보안
- 예시 데이터는 가상의 내용만 쓴다. 개인정보, 비밀번호, API 키, 토큰을 코드나 문서에 넣지 않는다.
- 일정과 설정은 집 서버의 Postgres에 저장한다. 사용자는 한 명이며 `APP_PASSWORD` 하나로 로그인한다. 비밀값은 서버의 `~/check/.env`에만 두고 저장소에 넣지 않는다.
- 이전 버전의 저장 키 `study-planner-items`는 서버가 비어 있을 때 한 번 옮기는 용도로만 읽는다.

## 실행 방법
- 최초 실행: `npm ci` 다음 `npm run dev`.
- 브라우저에서 `http://localhost:3000`을 연다. `index.html` 직접 열기는 이전 버전이다.
- 정적 빌드는 `npm run build`로 `out/`에 생성한다. 배포 경로 확인은 `BASE_PATH=/check npm run build`로 한다.
- 전체 스택 확인은 `docker compose --env-file <비밀값 파일> up -d --build` 후 `http://localhost:3100/check/`.
- `main`에 푸시하면 집 서버의 cron이 `deploy/deploy.sh`로 2분 안에 자동 배포한다. 바로 배포하려면 서버에서 `~/check/src/deploy/deploy.sh --force`.

## 확인 절차 (작업을 끝냈다고 말하기 전에)
1. `npm run build`가 성공하고 브라우저 콘솔에 오류가 없다.
2. 일정을 추가하면 목록에 나타난다.
3. 상태를 완료로 바꾸면 구분되어 보인다.
4. 삭제하면 해당 일정만 사라진다.
5. 빈 제목은 저장되지 않고 안내가 나온다.
6. 새로고침해도 목록이 남는다.
7. 캘린더·기록·설정 화면과 전역 CSS가 표시된다. 배포 빌드에서는 CSS/JS 경로가 `/check/`로 시작한다.
8. 틀린 비밀번호는 거절되고, 맞는 비밀번호로 들어간 뒤 새로고침해도 일정이 서버에서 다시 보인다.

## 완료 보고 형식
- 바꾼 파일 목록과 파일별 변경 이유 한두 줄.
- 확인 절차 중 사람이 브라우저에서 직접 확인해야 하는 항목.
- 확인하지 못했거나 자신 없는 부분.

## 반복 규칙
- 실패한 기준과 근거를 먼저 말한 뒤 그 기준을 고친다. 통과한 기능은 유지한다.
- 고친 뒤 원인 한 줄, 바꾼 파일과 줄, 다시 확인할 항목을 보고한다.

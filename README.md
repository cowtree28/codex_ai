# check

**오늘 할 일을 적고, 진행하고, 돌아보는 개인 일정 관리 앱.**

React와 Next.js로 만든 로컬 웹앱입니다. 일정은 브라우저의 `localStorage`에 저장되며 서버로 전송하지 않습니다.

## 시작하기

Node.js 20.9 이상이 필요합니다. 처음 한 번 의존성을 설치한 다음 개발 서버를 실행하세요.

```bash
npm ci
npm run dev
```

브라우저에서 **http://localhost:3000**을 엽니다. `index.html`을 직접 열면 이전 버전이 실행됩니다. 정적 결과물은 `npm run build` 후 `out/`에 생성됩니다.

## 할 수 있는 일

| 화면 | 기능 |
| --- | --- |
| **오늘** | 일정 추가·수정·삭제, 대기·할 일·진행 중·완료·취소 상태 변경, 목록·그래프 전환 |
| **캘린더** | 월간 일정 확인, 날짜별 일정 열기, 수정·상태 변경·삭제 |
| **기록** | 주간·월간 완료 기록, 날짜별 타임라인과 카테고리별 비율 |
| **설정** | 브라우저 알림 허용, 하루 전·밤 미완료 알림 선택 |

날짜 없는 할 일도 추가할 수 있습니다. 날짜가 있는 일정은 매일·매주·매월 반복할 수 있고, 반복 일정의 상태는 날짜마다 따로 바꿀 수 있습니다. 오늘 화면에는 오늘 일정, 날짜 없는 할 일, 끝나지 않은 지난 일정이 표시됩니다.

## GitHub Pages 배포

`main`에 푸시하면 `.github/workflows/pages.yml`이 정적 사이트를 빌드하고 `out/`을 GitHub Pages에 올립니다. GitHub 저장소 **Settings → Pages → Build and deployment → Source**에서 **GitHub Actions**를 선택하세요. 배포 주소는 **https://cowtree28.github.io/codex_ai/**입니다. 아직 푸시하거나 Pages 설정을 변경하지는 않았습니다.

GitHub Pages는 공개 정적 호스팅입니다. 화면 코드가 공개되며 로그인 기능은 없습니다. 일정 데이터는 각 브라우저의 `localStorage`에만 저장되어 다른 기기와 자동 동기화되지 않습니다. 브라우저 알림은 해당 탭이 열려 있을 때만 확인합니다.

로컬 빌드에서 Pages 경로를 점검하려면 다음 명령을 실행하세요.

```bash
GITHUB_PAGES=true npm run build
```

## 기존 데이터 옮기기

`file://`로 열었던 이전 앱, `http://localhost:3000`, GitHub Pages 주소는 서로 브라우저 저장 공간이 다릅니다. 기존 일정이 있다면 Chrome/Edge에서 이전 `index.html`을 열고 개발자 도구 콘솔에서 아래 명령으로 데이터를 복사하세요.

```js
copy(JSON.stringify(localStorage.getItem("study-planner-items") ?? localStorage.getItem("check-schedules-v1")))
```

옮길 대상 주소(로컬 앱 또는 GitHub Pages)의 콘솔에서 다음 명령의 `여기에_복사한_값`을 붙여 넣고 실행한 다음 새로고침하세요. 복사된 값은 큰따옴표로 둘러싸인 JavaScript 문자열입니다. 기존 데이터가 `null`이었다면 이전할 일정이 없습니다.

```js
localStorage.setItem("study-planner-items", 여기에_복사한_값)
```

브라우저 데이터를 삭제하면 일정도 사라질 수 있습니다.

## 파일 구성

```text
app/layout.jsx   문서 틀과 전역 CSS 연결
app/page.jsx     React 화면과 상태 관리
app/planner.js   날짜·일정·저장 데이터 계산
style.css        화면 디자인
next.config.mjs  정적 내보내기와 Pages 경로
.github/workflows/pages.yml  Pages 자동 배포
package.json     실행 명령과 의존성
index.html      이전 버전 진입점 (데이터 이전용)
app.js          이전 버전 동작 (데이터 이전용)
docs/           기획·설계·점검 문서
```

## 직접 확인하기

- `npm run build`가 성공하는지 확인합니다.
- 개발 서버에서 일정 두 개를 추가하고 하나를 완료 처리한 뒤 그래프 건수를 확인합니다.
- 한 일정만 삭제해 다른 일정은 남는지 확인합니다.
- 빈 제목은 안내 문구가 나타나며 추가되지 않는지 확인합니다.
- 새로고침 뒤 일정과 설정이 남는지 확인합니다.
- 캘린더, 기록, 알림 설정을 열고 개발자 도구 콘솔 오류를 확인합니다.

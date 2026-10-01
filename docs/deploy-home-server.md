# 집 서버에 다시 배포하기

이 앱은 2026-10-01에 집 서버에서 내렸다. 코드는 이 저장소에 모두 있으니 아래 순서로 다시 띄울 수 있다.

## 준비물

- Debian 계열 서버, Docker와 Docker Compose, 호스트 nginx(HTTPS 인증서 포함), Python 3
- AI 기능을 쓰려면: 서버 사용자 계정에 Claude Code 설치·로그인, llm-wiki 플러그인, 위키 허브(`~/wiki`)

```bash
claude plugin marketplace add nvk/llm-wiki
claude plugin install wiki@llm-wiki
mkdir -p ~/.config/llm-wiki && echo '{"hub_path": "~/wiki"}' > ~/.config/llm-wiki/config.json
```

## 1. 코드 받기

```bash
mkdir -p ~/check && chmod 700 ~/check
git clone https://github.com/cowtree28/codex_ai.git ~/check/src
```

## 2. 비밀값 파일

`원하는비밀번호`는 사이트 로그인 비밀번호다. 예전 데이터를 되살릴 때는 백업해 둔 `.env`를 그대로 쓴다. `SESSION_SECRET`이 달라지면 저장된 연동 비밀값을 풀 수 없다.

```bash
umask 077
printf 'APP_PASSWORD=%s\nSESSION_SECRET=%s\nPOSTGRES_PASSWORD=%s\n' \
  '원하는비밀번호' "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > ~/check/.env
```

## 3. 호스트 nginx에 `/check/` 경로 추가

컨테이너는 `127.0.0.1:3100`에만 열린다. HTTPS `server` 블록 안에 아래 조각을 include 한다.

```bash
sudo tee /etc/nginx/snippets/check.conf >/dev/null <<'NGX'
location = /check { return 301 /check/; }
location /check/ {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
NGX
# 사이트 설정의 443 server 블록에 다음 한 줄을 넣는다:
#   include /etc/nginx/snippets/check.conf;
sudo nginx -t && sudo systemctl reload nginx
```

## 4. 첫 배포와 자동 배포

`deploy.sh`는 GitHub `main`에 새 커밋이 있으면 컨테이너를 다시 빌드한다. 또 서버 본체의 Claude 작업기(`deploy/claude_worker.py`)가 꺼져 있으면 다시 띄운다.

```bash
chmod +x ~/check/src/deploy/deploy.sh
~/check/src/deploy/deploy.sh --force
( crontab -l 2>/dev/null; echo '*/2 * * * * flock -n /tmp/check-deploy.lock $HOME/check/src/deploy/deploy.sh >> $HOME/check/deploy.log 2>&1' ) | crontab -
```

확인:

```bash
curl -s https://<서버 주소>/check/api/health      # {"ok":true}
tail ~/check/claude-worker.log                    # worker started …
```

## 5. 예전 데이터 되살리기 (선택)

백업한 SQL을 빈 DB에 넣는다. 2단계에서 백업한 `.env`를 썼어야 연동 비밀값까지 살아난다.

```bash
cd ~/check/src
docker compose --env-file ~/check/.env exec -T db psql -U check -d check < check-db-2026-10-01.sql
```

## 내리기

```bash
crontab -l | grep -v 'check/src/deploy/deploy.sh' | crontab -
kill "$(cat ~/check/claude-worker.pid)"
cd ~/check/src && docker compose --env-file ~/check/.env down -v --rmi local
sudo sed -i '\#include /etc/nginx/snippets/check.conf;#d' <사이트 설정 파일>
sudo rm /etc/nginx/snippets/check.conf && sudo nginx -t && sudo systemctl reload nginx
rm -rf ~/check
```

## 참고

- GitHub Pages(`https://cowtree28.github.io/codex_ai/`)는 화면만 올리고, 로그인·저장은 서버 API를 부른다. 서버를 내리면 Pages에서는 로그인할 수 없다.
- 서버 주소가 바뀌면 `.github/workflows/pages.yml`의 `NEXT_PUBLIC_API_URL`과 `api/main.py`의 `CORS_ORIGINS`를 함께 고친다.

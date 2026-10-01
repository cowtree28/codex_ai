#!/bin/bash
# 집 서버에서 cron이 2분마다 실행한다. GitHub main에 새 커밋이 있으면 받아서 컨테이너를 다시 빌드한다.
# 바로 배포하려면: ~/check/src/deploy/deploy.sh --force
set -euo pipefail
cd "$HOME/check/src"
git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ] || [ "${1:-}" = "--force" ]; then
  echo "$(date -Is) deploying ${REMOTE:0:7} (was ${LOCAL:0:7})"
  git reset -q --hard origin/main
  docker compose --env-file "$HOME/check/.env" up -d --build --remove-orphans
  docker image prune -f >/dev/null
  echo "$(date -Is) done"
fi

#!/bin/bash
# 집 서버에서 cron이 2분마다 실행한다.
# 1) GitHub main에 새 커밋이 있으면 받아서 컨테이너를 다시 빌드하고 Claude 작업기를 재시작한다.
# 2) Claude 작업기(deploy/claude_worker.py)가 꺼져 있으면 다시 띄운다.
# 바로 배포하려면: ~/check/src/deploy/deploy.sh --force
set -euo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME/check/src"
WORKER_PID="$HOME/check/claude-worker.pid"

start_worker() {
  nohup python3 "$HOME/check/src/deploy/claude_worker.py" >> "$HOME/check/claude-worker.log" 2>&1 &
  echo $! > "$WORKER_PID"
  echo "$(date -Is) claude worker started (pid $!)"
}
stop_worker() {
  if [ -f "$WORKER_PID" ] && kill -0 "$(cat "$WORKER_PID")" 2>/dev/null; then kill "$(cat "$WORKER_PID")"; fi
  rm -f "$WORKER_PID"
}

git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ] || [ "${1:-}" = "--force" ]; then
  echo "$(date -Is) deploying ${REMOTE:0:7} (was ${LOCAL:0:7})"
  git reset -q --hard origin/main
  docker compose --env-file "$HOME/check/.env" up -d --build --remove-orphans
  docker image prune -f >/dev/null
  stop_worker
  echo "$(date -Is) done"
fi

if ! { [ -f "$WORKER_PID" ] && kill -0 "$(cat "$WORKER_PID")" 2>/dev/null; }; then
  start_worker
fi

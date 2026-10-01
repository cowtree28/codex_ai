FROM python:3.12-slim
ENV TZ=Asia/Seoul PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bash \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 app
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Claude Code CLI (구독 토큰으로 AI 기능을 돌릴 때 사용). 도구는 끈 채로만 실행한다.
USER app
ENV HOME=/home/app PATH=/home/app/.local/bin:$PATH DISABLE_AUTOUPDATER=1
RUN curl -fsSL https://claude.ai/install.sh | bash && claude --version
COPY --chown=app *.py ./
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

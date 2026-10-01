FROM python:3.12-slim
# 서버 사용자와 같은 UID로 실행해야 연결한 ~/wiki 파일을 읽을 수 있다.
ARG APP_UID=1002
ENV TZ=Asia/Seoul PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bash \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u ${APP_UID} app
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
USER app
ENV HOME=/home/app PATH=/home/app/.local/bin:$PATH DISABLE_AUTOUPDATER=1
RUN curl -fsSL https://claude.ai/install.sh | bash && claude --version
COPY --chown=app *.py ./
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

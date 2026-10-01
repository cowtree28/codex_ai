FROM python:3.12-slim
# 서버 사용자와 같은 UID로 실행해야 읽기 전용으로 연결한 ~/wiki 파일을 읽을 수 있다.
# Claude 실행은 컨테이너가 아니라 서버 본체의 작업기(deploy/claude_worker.py)가 맡는다.
ARG APP_UID=1002
ENV TZ=Asia/Seoul PYTHONUNBUFFERED=1
RUN useradd -m -u ${APP_UID} app
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
USER app
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

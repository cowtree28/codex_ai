# 1단계: Next.js 정적 빌드
FROM node:22-alpine AS build
WORKDIR /app
ARG BASE_PATH=/check
ENV BASE_PATH=$BASE_PATH
COPY package.json package-lock.json ./
RUN npm ci
COPY next.config.mjs style.css ./
COPY app ./app
RUN npm run build

# 2단계: nginx로 정적 파일 서빙
FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/out /usr/share/nginx/html
EXPOSE 80

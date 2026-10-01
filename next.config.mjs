// BASE_PATH 가 있으면 그 경로 아래에서 동작하는 정적 사이트를 만든다. (집 서버: /check)
const basePath = process.env.BASE_PATH || (process.env.GITHUB_PAGES === "true" ? "/codex_ai" : "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;

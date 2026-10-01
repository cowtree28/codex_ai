const isGitHubPages = process.env.GITHUB_PAGES === "true";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  basePath: isGitHubPages ? "/codex_ai" : "",
};

export default nextConfig;

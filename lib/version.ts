export const BUILD_VERSION = "2026-11-04-v3";

export const versionInfo = () => ({
  build_version: BUILD_VERSION,
  git_commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
  deployment_env: process.env.VERCEL_ENV ?? "local",
  region: process.env.VERCEL_REGION ?? "local",
  server_time_utc: new Date().toISOString(),
});
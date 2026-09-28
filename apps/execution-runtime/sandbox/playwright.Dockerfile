# Playwright sandbox image for EXECUTION_PLAYWRIGHT_IMAGE, built from the sandbox's Node image
# with Playwright's own installer. Use it where mcr.microsoft.com/playwright is unavailable:
#
#   docker build --pull=false -f apps/execution-runtime/sandbox/playwright.Dockerfile \
#     --build-arg PLAYWRIGHT_VERSION=1.63.0 -t agents-foundry/playwright:1.63.0 .
#
# Keep PLAYWRIGHT_VERSION equal to the projects' @playwright/test version: each release
# expects its own browser builds.
FROM node:22-bookworm-slim
ARG PLAYWRIGHT_VERSION=1.63.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm \
  && chmod -R a+rX /ms-playwright

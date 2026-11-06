# Build from the repository root so the install uses the workspace lockfile:
#   docker build -f examples/demo-app/Dockerfile .
FROM node:24-alpine

RUN npm install --global pnpm@12.18.0

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY examples/demo-app/package.json examples/demo-app/
RUN pnpm install --frozen-lockfile --prod --filter demo-app

COPY examples/demo-app/src examples/demo-app/src
COPY examples/demo-app/public examples/demo-app/public

WORKDIR /repo/examples/demo-app
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
CMD ["node", "src/main.ts"]

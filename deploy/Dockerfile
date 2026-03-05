FROM node:22-slim

RUN npm install -g pnpm@10

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ packages/
COPY contracts/ contracts/

RUN pnpm install --frozen-lockfile && pnpm build

EXPOSE 4020

CMD ["node", "packages/facilitator/dist/server.js"]

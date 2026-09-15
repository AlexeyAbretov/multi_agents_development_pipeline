FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN HUSKY=0 npm ci
COPY tsconfig.json eslint.config.js .prettierrc.json ./
COPY ports.env ./
COPY src ./src
COPY test ./test
RUN npm test

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache docker-cli docker-cli-compose
COPY package.json package-lock.json ./
RUN HUSKY=0 npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY ports.env ./
COPY prompts ./prompts
# root: доступ к docker.sock у deployer; orchestrator тоже user 0 в compose
CMD ["node", "dist/services/OrchestratorService/index.js"]

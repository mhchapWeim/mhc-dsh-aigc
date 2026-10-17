FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV AIGC_DOCKER_BUILD=true
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY --from=build /app/dist/standalone ./
# Vinext 1.0.0-beta.3 standalone tracing omits these peer runtime packages.
COPY --from=build /app/node_modules/react ./node_modules/react
COPY --from=build /app/node_modules/react-dom ./node_modules/react-dom
COPY --from=build /app/node_modules/scheduler ./node_modules/scheduler

EXPOSE 3000
CMD ["node", "server.js"]

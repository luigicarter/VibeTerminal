FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN bun run build

FROM oven/bun:1.4.2 AS runtime
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY migrations ./migrations
COPY contracts ./contracts
RUN rm -rf src/prepared migrations/prepared contracts/prepared scripts/prepared-contracts.ts
USER bun
EXPOSE 3002
CMD ["bun", "--no-env-file", "dist/server.js"]

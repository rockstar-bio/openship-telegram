FROM oven/bun:1.2.21-alpine
WORKDIR /app
COPY package.json tsconfig.json biome.json ./
RUN bun install --frozen-lockfile
COPY src ./src
USER bun
CMD ["bun", "src/index.ts"]

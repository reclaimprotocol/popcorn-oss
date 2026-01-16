FROM oven/bun:1

WORKDIR /app

COPY package.json ./
# Bun automatically handles installing packages from package.json without a lockfile if needed, 
# but best practice is to have one. Since we just created it, we run install.
RUN bun install

COPY . .

EXPOSE 3000

CMD ["bun", "run", "index.ts"]

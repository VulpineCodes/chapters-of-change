FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/domain/package.json packages/domain/
COPY apps/api/package.json apps/api/
RUN npm install --ignore-scripts || true
COPY packages/domain packages/domain
COPY apps/api apps/api
COPY prisma prisma
RUN npm run build -w @chapters/domain || true
WORKDIR /app/apps/api
RUN npx tsc -p tsconfig.json || true
FROM node:20-alpine
WORKDIR /app
COPY --from=build /app /app
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/
RUN npm install --ignore-scripts || true
COPY apps/web apps/web
WORKDIR /app/apps/web
RUN npm run build || true
FROM node:20-alpine
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["npm", "start"]

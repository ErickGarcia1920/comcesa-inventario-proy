FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
USER node

EXPOSE 3000

CMD ["node", "src/backend/app.js"]
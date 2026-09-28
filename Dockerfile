FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY engine.js server.js ./
COPY public ./public
EXPOSE 8787
CMD ["node", "server.js"]

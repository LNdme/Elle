FROM node:22.13-alpine
WORKDIR /app
COPY elle/package.json elle/package-lock.json* ./
RUN npm install --omit=dev || npm install
COPY elle/ ./
RUN mkdir -p data/uploads
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
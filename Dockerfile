FROM node:22-alpine
WORKDIR /app
COPY package.json worker.js server.mjs ./
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "server.mjs"]

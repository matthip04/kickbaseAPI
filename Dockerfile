FROM node:22-alpine
WORKDIR /app
COPY package.json worker.js server.mjs ./
RUN mkdir -p /app/data && chown node:node /app/data
ENV PORT=8787 DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 8787
USER node
CMD ["node", "server.mjs"]

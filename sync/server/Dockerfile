# Marigold sync server. Build from the repository root:
#   docker build -f sync/server/Dockerfile -t marigold-sync .
#   docker run -p 8787:8787 -v marigold-sync:/data marigold-sync
FROM node:22-alpine
WORKDIR /app
COPY sync/server/server.ts sync/server/server.ts
RUN echo '{"type":"module"}' > package.json
ENV PORT=8787 HOST=0.0.0.0 MARIGOLD_DATA_DIR=/data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "sync/server/server.ts"]

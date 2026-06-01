FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache ca-certificates

# Fallback copies baked in so the image can start without bind-mounts (e.g. local
# docker run). Compose overrides these at runtime via bind-mounts (:ro), so file
# changes never require a rebuild in the normal deploy flow.
COPY server.mjs index.html manifest.json sw.js icon.svg ./

CMD ["node", "server.mjs"]

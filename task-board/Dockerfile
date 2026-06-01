FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache ca-certificates

# Fallback copies for first boot; compose bind-mounts override these at runtime.
COPY server.mjs index.html ./

CMD ["node", "server.mjs"]

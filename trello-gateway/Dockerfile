FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache ca-certificates

# Fallback copies for first boot; compose bind-mounts override these at runtime.
COPY trello_gateway.mjs trello_transition_matrix.csv ./

CMD ["node", "trello_gateway.mjs"]

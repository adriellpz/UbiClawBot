# Radicale public HTTPS deployment

This deploys a small Radicale CalDAV/CardDAV service for DAVx5 testing at `https://cal.sonofwolf.org`.

## Security model

- Caddy terminates public HTTPS.
- Radicale is published on host loopback only: `127.0.0.1:5232`.
- Radicale requires htpasswd/bcrypt authentication.
- Real credentials are local-only and must not be committed, pasted into Trello, or included in logs.
- Start with a test calendar named `Ubi Test`; do not migrate real schedule data until Android reminders and backup/restore are verified.

## DNS

Create this DNS record in Cloudflare or the authoritative DNS provider:

- Type: `A`
- Name: `cal`
- Content: `134.209.38.222`
- Proxy: DNS only / gray cloud

## Host setup

From the repo root on the host:

```bash
mkdir -p config/radicale radicale-data
cp config/radicale/config.example config/radicale/config
```

Create the Radicale user file with bcrypt htpasswd credentials. Example, using an Apache htpasswd tool on the host:

```bash
htpasswd -B -c config/radicale/users ubi
chmod 600 config/radicale/users
```

Do not commit `config/radicale/users` or the copied runtime config.

## Run/restart

From the `workspace/` directory, using the existing droplet compose flow:

```bash
docker compose -f docker-compose.droplet.yml --env-file ../.env up -d radicale
```

Reload Caddy after updating `Caddyfile.droplet` on the host. Validate before reload using the host's existing Caddy workflow.

## Verification

```bash
getent hosts cal.sonofwolf.org
curl -I https://cal.sonofwolf.org/
curl -I https://ai.sonofwolf.org/
ss -ltnp | grep 5232
```

Expected:

- `cal.sonofwolf.org` resolves to the host.
- `https://cal.sonofwolf.org/` is served by Caddy/Radicale and requires auth for DAV access.
- `https://ai.sonofwolf.org/` still works.
- Radicale listens only on host loopback, not a public interface.

## Android DAVx5 setup

Use DAVx5:

https://play.google.com/store/apps/details?id=at.bitfire.davdroid&hl=en

Account setup after the service is live:

- URL: `https://cal.sonofwolf.org/`
- Username/password: from the secure local secret path
- Calendar: `Ubi Test`

Then create a harmless test event with a reminder, confirm it appears on Android, confirm the notification fires, update it, and delete it.

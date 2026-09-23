# Deploying

The whole game is one Node process: it serves the built web client and the WebSocket endpoint on the same port (`PORT`, default 8080). Anything that can run a Docker container or a Node 22 process can host it. Rooms live in memory, so run a single instance (a second instance would not see the first one's rooms).

## Docker (works on Fly.io, Railway, Render, a VPS)

```bash
docker build -t landlord .
docker run -p 8080:8080 landlord
```

Open http://localhost:8080.

- **Fly.io**: `fly launch` detects the Dockerfile. Set `internal_port = 8080`. One machine, no autoscaling.
- **Railway** / **Render**: create a service from the repo, choose Docker, expose port 8080. Health check path: `/healthz`.

## Without Docker

```bash
pnpm install
pnpm build
PORT=8080 pnpm start
```

## Environment variables

| Variable                  | Default   | Meaning                                                                                                                                                                                                           |
| ------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `8080`    | HTTP and WebSocket port                                                                                                                                                                                           |
| `HOST`                    | `0.0.0.0` | Bind address                                                                                                                                                                                                      |
| `ROOM_TTL_MINUTES`        | `120`     | Empty rooms are deleted after this long                                                                                                                                                                           |
| `MAX_ROOMS`               | `500`     | Most rooms held at once. When full, a new room replaces the one nobody has been connected to for longest; creating one is refused only while every room has someone connected                                     |
| `TRUST_PROXY`             | `0`       | Number of reverse proxies in front of the server. The client's address is read from `X-Forwarded-For` that many entries from the end; at `0` the header is ignored (see Behind a proxy)                           |
| `MAX_CONNECTIONS_PER_IP`  | `20`      | Most WebSocket connections open at once from one IP address (IPv6: one /64). Further ones are refused with HTTP 429 until one closes. Friends on one home or campus network share an address, so keep it generous |
| `MAX_ROOM_CREATES_PER_IP` | `10`      | Most rooms one IP address (IPv6: one /64) may create in any 10 minutes, across all its connections                                                                                                                |

Unset or blank variables take the default. A value that does not fit (`TRUST_PROXY=true`, `MAX_CONNECTIONS_PER_IP=off`) stops the server at startup with a message naming the variable, rather than quietly running with the default.

The client connects to `ws(s)://<same host>/ws`, so no client configuration is needed. Put the server behind HTTPS (Fly, Railway and Render do this for you) and the WebSocket automatically uses `wss://`.

## Behind a proxy

The per-IP limits need the real client address. Directly exposed, the server uses the address of the connection and ignores `X-Forwarded-For`, which clients can set to anything. Behind a reverse proxy every connection comes from the proxy, so tell the server how many proxies to look past with `TRUST_PROXY`: set `TRUST_PROXY=1` on Fly.io, Railway and Render (one proxy hop), add one for every extra proxy in front, such as Cloudflare in front of Fly (`TRUST_PROXY=2`), and leave it at `0` when clients connect to the server directly. A value that is too high lets clients choose their own address by sending `X-Forwarded-For`; one that is too low puts everyone behind the proxy under one address, so they share its limits.

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

| Variable           | Default   | Meaning                                                                                                                                                                       |
| ------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`             | `8080`    | HTTP and WebSocket port                                                                                                                                                       |
| `HOST`             | `0.0.0.0` | Bind address                                                                                                                                                                  |
| `ROOM_TTL_MINUTES` | `120`     | Empty rooms are deleted after this long                                                                                                                                       |
| `MAX_ROOMS`        | `500`     | Most rooms held at once. When full, a new room replaces the one nobody has been connected to for longest; creating one is refused only while every room has someone connected |

The client connects to `ws(s)://<same host>/ws`, so no client configuration is needed. Put the server behind HTTPS (Fly, Railway and Render do this for you) and the WebSocket automatically uses `wss://`.

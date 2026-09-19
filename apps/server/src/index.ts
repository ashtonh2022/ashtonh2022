import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

import { ENGINE_VERSION } from '@landlord/engine';
import { PROTOCOL_VERSION } from '@landlord/protocol';

import { createStaticHandler, resolveWebDist } from './static';

const PORT = Number(process.env.PORT ?? 8080);
const webDist = resolveWebDist();
const serveStatic = createStaticHandler(webDist);

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  void serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'hello' }));
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(PORT, () => {
  console.log(
    `landlord server listening on http://localhost:${PORT} ` +
      `(engine ${ENGINE_VERSION}, protocol v${PROTOCOL_VERSION}, static: ${webDist})`,
  );
});

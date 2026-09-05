import { createServer, request as requestUpstream } from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.WEBHOOK_PROXY_PORT ?? "3003");
const upstreamPort = Number(process.env.PORT ?? "3001");
const route = "/api/webhooks/razorpay";
const maxBodyBytes = 256 * 1024;

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== route) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBodyBytes) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", () => {
    if (size > maxBodyBytes) {
      response.writeHead(413).end();
      return;
    }

    const body = Buffer.concat(chunks);
    const upstream = requestUpstream({
      host,
      port: upstreamPort,
      path: route,
      method: "POST",
      headers: {
        "content-type": request.headers["content-type"] ?? "application/json",
        "content-length": body.length,
        ...(request.headers["x-razorpay-signature"] ? { "x-razorpay-signature": request.headers["x-razorpay-signature"] } : {}),
        ...(request.headers["x-razorpay-event-id"] ? { "x-razorpay-event-id": request.headers["x-razorpay-event-id"] } : {})
      }
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, { "content-type": upstreamResponse.headers["content-type"] ?? "application/json" });
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "webhook_upstream_unavailable" }));
    });
    upstream.end(body);
  });
});

server.listen(port, host, () => {
  process.stdout.write(`Webhook-only proxy listening at http://${host}:${port}${route}\n`);
});

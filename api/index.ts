import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";

const appPromise = buildApp(loadConfig()).then(async (app) => {
  await app.ready();
  return app;
});

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const app = await appPromise;
  app.server.emit("request", request, response);
}

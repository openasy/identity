// Starts the app on a random port for tests.
import { createServer, type RequestListener, type Server } from "node:http";
import { createAuth } from "@openasy/auth";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "./app.ts";
import { openDb } from "./db.ts";

export const KEK = Buffer.alloc(32, 7);

export async function startApp(opts: Partial<AppOptions> & { version: string }) {
  const db = openDb(":memory:");
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "identity", productName: "OpenAsy Identity", origin: base, secretsKey: KEK });
  handler = createApp({ db, auth, ...opts });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { db, auth, base, close };
}

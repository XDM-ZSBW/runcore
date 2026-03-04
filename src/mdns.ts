/**
 * mDNS service announcement for Core board discovery.
 * Announces the HTTP server as `_core-board._tcp.local` so that
 * Dash and other instances can find it on the LAN automatically.
 *
 * Gated behind `settings.mesh.lanAnnounce` — disabled by default.
 */

import mdns from "multicast-dns";
import { hostname } from "node:os";
import { createLogger } from "./utils/logger.js";
import { getInstanceName } from "./instance.js";

const log = createLogger("mdns");

const SERVICE_TYPE = "_core-board._tcp.local";

let responder: ReturnType<typeof mdns> | null = null;
let announcedPort = 0;

/**
 * Start announcing the Core board service on the local network.
 * Call after the HTTP server is listening and the actual port is known.
 */
export function startMdns(port: number): void {
  if (responder) return; // already running

  announcedPort = port;
  const instance = getInstanceName();
  const host = hostname();
  const serviceName = `${instance}._core-board._tcp.local`;

  responder = mdns();

  // Respond to queries for our service type
  responder.on("query", (query) => {
    const dominated = query.questions.some(
      (q) =>
        q.name === SERVICE_TYPE ||
        q.name === serviceName
    );
    if (!dominated) return;

    responder!.respond({
      answers: [
        {
          name: serviceName,
          type: "SRV",
          data: { port: announcedPort, target: host, priority: 0, weight: 0 },
        },
        {
          name: serviceName,
          type: "TXT",
          data: [`instance=${instance}`, `port=${announcedPort}`],
        },
        {
          name: SERVICE_TYPE,
          type: "PTR",
          data: serviceName,
        },
      ],
    });
  });

  // Proactive announcement (GBYE → announce pattern)
  responder.respond({
    answers: [
      {
        name: SERVICE_TYPE,
        type: "PTR",
        data: serviceName,
      },
      {
        name: serviceName,
        type: "SRV",
        data: { port: announcedPort, target: host, priority: 0, weight: 0 },
      },
      {
        name: serviceName,
        type: "TXT",
        data: [`instance=${instance}`, `port=${announcedPort}`],
      },
    ],
  });

  log.info(`mDNS announcing ${serviceName} on port ${announcedPort}`);
}

/**
 * Stop the mDNS responder and send a goodbye packet.
 */
export function stopMdns(): void {
  if (!responder) return;

  const instance = getInstanceName();
  const serviceName = `${instance}._core-board._tcp.local`;

  // Send goodbye (TTL=0) so peers flush the record immediately
  try {
    responder.respond({
      answers: [
        {
          name: SERVICE_TYPE,
          type: "PTR",
          data: serviceName,
          ttl: 0,
        },
        {
          name: serviceName,
          type: "SRV",
          data: { port: announcedPort, target: hostname(), priority: 0, weight: 0 },
          ttl: 0,
        },
      ],
    });
  } catch {
    // best-effort goodbye
  }

  responder.destroy();
  responder = null;
  log.info("mDNS responder stopped");
}

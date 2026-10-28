import { readFileSync } from "node:fs";
import { hostname } from "node:os";

import { log } from "@tuti/shared";
import { signInbound } from "@tuti/shared/inbound-signature";
import { authenticate } from "mailauth";
import { SMTPServer, type SMTPServerSession } from "smtp-server";

/**
 * Receiving the support domain's mail on a self-hosted server (docs/support-email.md, "Your own
 * server"): an SMTP server in the worker, the MX for the domain's subdomains, that takes mail for those
 * addresses only, checks SPF, DKIM and DMARC itself (nothing in front of it did) and posts each message
 * to the app's /api/inbound/email signed with INBOUND_SECRET, like tuti.so's SES Lambda does. What the
 * app answers is what the sending server hears: taken, refused (no such address, too large), or "try
 * again later" (the app down), so the sending server's own retries carry it until the app is back.
 */

/** As the app: bigger messages are refused (it answers 413). */
export const MAX_BYTES = 25 * 1024 * 1024;
/**
 * Senders connected at once, and recipients per message (each one a post of the whole message to the
 * app): what one unauthenticated client can make the worker hold and send. Over them, senders are
 * told to come back (421) or to send the rest separately (452), as SMTP expects.
 */
export const MAX_CLIENTS = 10;
export const MAX_RECIPIENTS = 20;
/** Connections from one address at once, so one sender can't hold them all (421 past it). */
export const MAX_PER_SOURCE = 3;
/** Messages being received or delivered at once, whether their sender is still connected or not (451 past it). */
export const MAX_IN_FLIGHT = 10;
/** A session's longest life, however busy it keeps itself (NOOPs reset the idle timeout). */
export const SESSION_LIFETIME_MS = 10 * 60_000;

/** The app's answer: its status, and for a 200 or 404 its `outcome` (`no such address` for a 404 that means it). */
type Answer = { status: number; outcome?: string };
type Post = (url: string, request: { body: Buffer; headers: Record<string, string> }) => Promise<Answer>;

export type ReceiverOptions = {
  domain: string;
  appUrl: string;
  secret: string;
  port: number;
  host?: string;
  /** The name the server gives itself (its banner, and the checks' authserv-id). */
  serverName?: string;
  /** PEM key and certificate for STARTTLS; without them, STARTTLS isn't offered. */
  tls?: { key: string | Buffer; cert: string | Buffer };
  /** The largest message taken (MAX_BYTES), and the most recipients per message (MAX_RECIPIENTS); tests set less. */
  maxBytes?: number;
  maxRecipients?: number;
  /** The limits above (tests set less). */
  maxPerSource?: number;
  maxInFlight?: number;
  sessionLifetimeMs?: number;
  /** DNS for the checks (tests give a fake one). */
  resolver?: (name: string, type: string) => Promise<unknown>;
  post?: Post;
};

const postWithFetch: Post = async (url, { body, headers }) => {
  const response = await fetch(url, { method: "POST", body: new Uint8Array(body), headers, signal: AbortSignal.timeout(60_000) });
  const json = (await response.json().catch(() => null)) as { outcome?: unknown } | null;
  return { status: response.status, ...(typeof json?.outcome === "string" && { outcome: json.outcome }) };
};

/** An SMTP answer as smtp-server sends it: an error carrying its code. */
const answer = (code: number, message: string) => Object.assign(new Error(message), { responseCode: code });

/** SPF, DKIM and DMARC as the app reads them (`spf=pass dkim=none dmarc=fail`). */
export async function checkAuth(
  raw: Buffer,
  { ip, helo, sender, serverName, resolver }: { ip: string; helo: string; sender: string; serverName: string; resolver?: ReceiverOptions["resolver"] },
) {
  try {
    const { spf, dkim, dmarc } = await authenticate(raw, {
      ip,
      helo,
      sender,
      mta: serverName,
      disableArc: true,
      disableBimi: true,
      ...(resolver && { resolver: resolver as never }),
    });
    const dkimResults = (dkim?.results ?? []).map((result) => result.status?.result);
    return {
      spf: (spf && spf.status?.result) || "none",
      dkim: dkimResults.includes("pass") ? "pass" : (dkimResults[0] ?? "none"),
      dmarc: (dmarc && dmarc.status?.result) || "none",
    };
  } catch (error) {
    // A check that couldn't run proves nothing: as if nothing was checked (nothing joins a conversation).
    log.warn("Checking a received email's SPF, DKIM and DMARC failed", { error: String(error) });
    return { spf: "none", dkim: "none", dmarc: "none" };
  }
}

export function startSmtpReceiver(options: ReceiverOptions): Promise<SMTPServer> {
  const domain = options.domain.toLowerCase();
  const serverName = options.serverName ?? hostname();
  const post = options.post ?? postWithFetch;
  const url = new URL("/api/inbound/email", options.appUrl).toString();
  const maxPerSource = options.maxPerSource ?? MAX_PER_SOURCE;
  const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
  const lifetime = options.sessionLifetimeMs ?? SESSION_LIFETIME_MS;
  /** Open sessions per address, and when each accepted session started. */
  const perSource = new Map<string, number>();
  const started = new Map<string, number>();
  let inFlight = 0;
  /** Messages still arriving, by session: a sender that hangs up mid-DATA never ends its stream, so its slot goes when it closes. */
  const arriving = new Map<string, () => void>();

  const server = new SMTPServer({
    name: serverName,
    banner: "Tuti support inbox",
    size: options.maxBytes ?? MAX_BYTES,
    maxClients: MAX_CLIENTS,
    authOptional: true,
    disabledCommands: options.tls ? ["AUTH"] : ["AUTH", "STARTTLS"],
    ...(options.tls && { key: options.tls.key, cert: options.tls.cert }),
    logger: false,
    // The checks don't use the client's hostname, so no DNS lookup for it.
    disableReverseLookup: true,
    onConnect(session, callback) {
      const count = perSource.get(session.remoteAddress) ?? 0;
      if (count >= maxPerSource) {
        callback(answer(421, "Too many connections from you: try again later"));
        return;
      }
      perSource.set(session.remoteAddress, count + 1);
      started.set(session.id, Date.now());
      callback();
    },
    onClose(session) {
      arriving.get(session.id)?.();
      // Only sessions it let in (a refused one closes too).
      if (started.delete(session.id)) {
        const count = (perSource.get(session.remoteAddress) ?? 1) - 1;
        if (count > 0) {
          perSource.set(session.remoteAddress, count);
        } else {
          perSource.delete(session.remoteAddress);
        }
      }
    },
    onRcptTo(address, session, callback) {
      if (session.envelope.rcptTo.length >= (options.maxRecipients ?? MAX_RECIPIENTS)) {
        callback(answer(452, "Too many recipients: send the rest separately"));
        return;
      }
      const recipient = address.address.toLowerCase();
      // Only the projects' addresses, `<anything>@<subdomain>.<domain>`: this server relays nothing.
      callback(recipient.endsWith(`.${domain}`) ? undefined : answer(550, "No such address here"));
    },
    onData(stream, session, callback) {
      if (inFlight >= maxInFlight) {
        // Busy: none of it kept, and the sender tries again later.
        stream.on("data", () => {});
        stream.on("end", () => callback(answer(451, "Busy: try again later")));
        return;
      }
      inFlight++;
      let settled = false;
      const done: typeof callback = (...args) => {
        arriving.delete(session.id);
        if (!settled) {
          settled = true;
          inFlight--;
          callback(...args);
        }
      };
      arriving.set(session.id, () => done(answer(451, "Try again later")));
      const chunks: Buffer[] = [];
      // Past the limit, nothing more is kept: it's refused at the end, whatever its size.
      stream.on("data", (chunk: Buffer) => {
        if (!(stream as { sizeExceeded?: boolean }).sizeExceeded) {
          chunks.push(chunk);
        }
      });
      stream.on("error", (error) => done(error));
      stream.on("end", () => {
        // All here: it stays counted until it's delivered, even if the sender hangs up now.
        arriving.delete(session.id);
        if ((stream as { sizeExceeded?: boolean }).sizeExceeded) {
          done(answer(552, "Message too large"));
          return;
        }
        const raw = Buffer.concat(chunks);
        deliver(raw, session)
          .then((code) => done(code === 250 ? null : answer(code, code === 550 ? "No such address here" : code === 552 ? "Message too large" : "Try again later")))
          .catch((error: unknown) => {
            log.error("Posting a received email to the app failed", { error: String(error) });
            done(answer(451, "Try again later"));
          });
      });
    },
  });

  /** The answer for the whole message: taken (250) unless the app refused it everywhere, or needs a retry. */
  async function deliver(raw: Buffer, session: SMTPServerSession) {
    const results = await checkAuth(raw, {
      ip: session.remoteAddress,
      helo: session.hostNameAppearsAs,
      sender: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
      serverName,
      resolver: options.resolver,
    });
    const auth = `spf=${results.spf} dkim=${results.dkim} dmarc=${results.dmarc}`;
    const answers: Answer[] = [];
    for (const { address } of session.envelope.rcptTo) {
      const recipient = address.toLowerCase();
      answers.push(
        await post(url, {
          body: raw,
          headers: {
            "content-type": "message/rfc822",
            "tuti-recipient": recipient,
            "tuti-auth": auth,
            "tuti-signature": signInbound(options.secret, recipient, auth, raw),
          },
        }),
      );
    }
    const taken = (a: Answer) => a.status === 200;
    // A 404 is the app saying no project has the address only when it says so; otherwise (its email
    // switched off, a proxy) it's a setup to fix, as a 401 is (INBOUND_SECRET differs, or the clocks).
    const noSuchAddress = (a: Answer) => a.status === 404 && a.outcome === "no such address";
    const tooLarge = (a: Answer) => a.status === 413;
    if (answers.some((a) => a.status === 401)) {
      log.error("The app refused a received email's signature: is INBOUND_SECRET the same for the worker and the app, and are their clocks right?");
    }
    // Any recipient to try again: the whole message is (the app takes what it already has once).
    if (!answers.every((a) => taken(a) || noSuchAddress(a) || tooLarge(a))) {
      return 451;
    }
    if (answers.every(tooLarge)) {
      return 552;
    }
    if (answers.every(noSuchAddress)) {
      return 550;
    }
    return 250;
  }

  // Sessions past their lifetime are closed, however busy they keep themselves.
  const reaper = setInterval(
    () => {
      for (const connection of server.connections as Set<{ session?: { id: string }; close(): void }>) {
        const since = connection.session && started.get(connection.session.id);
        if (since && Date.now() - since > lifetime) {
          connection.close();
        }
      }
    },
    Math.min(lifetime / 2, 30_000),
  );
  reaper.unref();
  server.on("close", () => clearInterval(reaper));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      server.on("error", (error) => log.error("The SMTP receiver had an error", { error: String(error) }));
      resolve(server);
    });
  });
}

/** The receiver from the environment: off without INBOUND_SMTP_PORT, and needs the rest with it. */
export function receiverFromEnv(env = process.env): ReceiverOptions | null {
  const port = env.INBOUND_SMTP_PORT?.trim();
  if (!port) {
    return null;
  }
  const missing = ["SUPPORT_EMAIL_DOMAIN", "INBOUND_SECRET", "APP_URL"].filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`INBOUND_SMTP_PORT is set, so these are needed too: ${missing.join(", ")}`);
  }
  if (Boolean(env.INBOUND_SMTP_TLS_KEY) !== Boolean(env.INBOUND_SMTP_TLS_CERT)) {
    throw new Error("Set both INBOUND_SMTP_TLS_KEY and INBOUND_SMTP_TLS_CERT (files with the PEM key and certificate), or neither");
  }
  return {
    domain: env.SUPPORT_EMAIL_DOMAIN!.trim(),
    secret: env.INBOUND_SECRET!,
    appUrl: env.APP_URL!.trim(),
    port: Number(port),
    host: env.INBOUND_SMTP_HOST?.trim() || undefined,
    serverName: env.INBOUND_SMTP_NAME?.trim() || undefined,
    ...(env.INBOUND_SMTP_TLS_KEY && { tls: { key: readFileSync(env.INBOUND_SMTP_TLS_KEY), cert: readFileSync(env.INBOUND_SMTP_TLS_CERT!) } }),
  };
}

// Hex Connect sidecar (docs/connect.md): runs cloudflared and verifies Connect login grants.
// hexbot/connect.py starts it with Node 24+ or the desktop app's Electron, which run TypeScript as is.
//   connect_agent.mts tunnel <port>   supervise cloudflared until stdin closes
//   connect_agent.mts verify          read a grant on stdin, print its claims or exit 1
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

type Jwk = JsonWebKey & { kid: string; crv: string; x: string; y: string };
interface Config { api_base: string; daemon_id: string; owner_id: string; issuer: string; keys: Jwk[]; tunnel_token: string }

const home = process.env.HEXBOT_HOME as string;
const config = (): Config => JSON.parse(readFileSync(join(home, "connect.json"), "utf8"));
const now = () => Date.now() / 1000;

/** Pinned release; bumping VERSION and the digests (GitHub asset `digest`) is the update path. */
const VERSION = "2026.8.0";
const ASSETS: Record<string, [name: string, sha256: string]> = {
  "darwin-arm64": ["cloudflared-darwin-arm64.tgz", "6244b4b199515690f93e170110d219d8d141184ba847179980c2f5906800c931"],
  "darwin-x64": ["cloudflared-darwin-amd64.tgz", "95c57d69cf6b19a94880090d76f24f46cd359c68ca82a14b143ea604dff33020"],
  "linux-arm64": ["cloudflared-linux-arm64", "d2b49df8dbb3a36e743ce00b091c180e0942a0b67487257c573a631db001796c"],
  "linux-x64": ["cloudflared-linux-amd64", "14ecae0dd17ba74f8055e22b8f5b5acc3cbb5a9c3be4e7d6507fe1c4eadaea95"],
  "win32-x64": ["cloudflared-windows-amd64.exe", "82781b3ba8cb66c0f8fbc7d34974bc4bd8eb1fcc76f27badb97eb4cc7060f5ad"],
};

/** Downloads the pinned cloudflared once, refusing any file whose digest differs. */
export async function cloudflared(fetcher = fetch): Promise<string> {
  const binary = join(home, "bin", `cloudflared-${VERSION}${process.platform === "win32" ? ".exe" : ""}`);
  if (existsSync(binary)) return binary;
  const [name, sha256] = ASSETS[`${process.platform}-${process.arch}`] ?? [];
  if (!name) throw new Error(`cloudflared is unsupported on ${process.platform} ${process.arch}`);
  const response = await fetcher(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`${name} does not match its pinned SHA-256`);
  // The macOS archives hold one ustar entry: a 512-byte header (size in octal at 124), then the binary.
  const tar = name.endsWith(".tgz") ? gunzipSync(bytes) : undefined;
  mkdirSync(dirname(binary), { recursive: true, mode: 0o700 });
  writeFileSync(`${binary}.download`, tar ? tar.subarray(512, 512 + parseInt(tar.toString("ascii", 124, 136), 8)) : bytes, { mode: 0o700 });
  renameSync(`${binary}.download`, binary);
  return binary;
}

const sleep = (seconds: number) => new Promise(resolve => setTimeout(resolve, seconds * 1000));

/**
 * Runs cloudflared with ingress fixed here to the daemon's loopback port, from a config file of our own so
 * neither Connect nor a ~/.cloudflared/config.yml can point the tunnel elsewhere. Retries until stdin closes.
 */
async function tunnel(port: string) {
  if (!/^\d+$/.test(port)) throw new Error("port must be a number");
  let child: ChildProcess | undefined;
  const stop = () => { child?.kill(); process.exit(0); };
  process.on("SIGTERM", stop).on("SIGINT", stop);
  process.stdin.on("end", stop).resume(); // the daemon holds stdin open; EOF means it is gone
  const settings = join(home, "cloudflared.yml"), pidFile = join(home, "cloudflared.pid"); // JSON is YAML
  writeFileSync(settings, JSON.stringify({ ingress: [{ service: `http://127.0.0.1:${port}` }] }));
  // A sidecar killed outright (SIGKILL, out of memory) leaves its cloudflared behind; stop it, but only if
  // that pid still runs with this daemon's config, so a reused pid is never touched.
  const leftover = Number(existsSync(pidFile) ? readFileSync(pidFile, "utf8") : 0);
  if (leftover && spawnSync("ps", ["-p", String(leftover), "-o", "command="]).stdout?.toString().includes(settings)) process.kill(leftover);
  mkdirSync(join(home, "logs"), { recursive: true });
  const log = openSync(join(home, "logs", "cloudflared.log"), "a");
  for (let backoff = 1; ; ) {
    const started = Date.now();
    try {
      // The token travels in the environment, not argv, so `ps` does not show it.
      child = spawn(await cloudflared(), ["tunnel", "--config", settings, "--no-autoupdate", "run"], { env: { ...process.env, TUNNEL_TOKEN: config().tunnel_token }, stdio: ["ignore", log, log] });
      writeFileSync(pidFile, String(child.pid));
      await new Promise(resolve => child!.on("close", resolve).on("error", error => console.error(error.message)));
      writeFileSync(pidFile, ""); // cloudflared is down until the next start: the daemon reports the tunnel stopped
    } catch (error) { console.error((error as Error).message); } // a failed download or spawn: wait and retry
    backoff = Date.now() - started > 60_000 ? 1 : Math.min(backoff * 2, 60);
    await sleep(backoff);
  }
}

/** Connect's published keys, cached for ten minutes and refetched at most once a minute for an unknown key id. */
async function publishedKeys(apiBase: string, kid: string): Promise<Jwk[]> {
  const path = join(home, "connect-jwks.json");
  let cached: { at: number; keys: Jwk[] } | undefined;
  try { cached = JSON.parse(readFileSync(path, "utf8")); } catch { /* missing or damaged: refetch */ }
  const age = cached ? now() - cached.at : -1; // a timestamp from the future counts as stale
  if (cached && age >= 0 && (age < 60 || (age < 600 && cached.keys.some(key => key.kid === kid)))) return cached.keys;
  const response = await fetch(`${apiBase}/.well-known/jwks.json`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Connect keys unavailable (${response.status})`);
  const { keys } = await response.json() as { keys: Jwk[] };
  writeFileSync(`${path}.${process.pid}`, JSON.stringify({ at: now(), keys }), { mode: 0o600 });
  renameSync(`${path}.${process.pid}`, path); // atomic: a concurrent verify never reads half a file
  return keys;
}

/**
 * Claims of a grant signed by a key pinned at registration and still published by Connect,
 * issued by the pinned issuer to this daemon for its pinned owner. Throws on anything else.
 */
export async function verifyGrant(grant: string): Promise<Record<string, unknown>> {
  const c = config();
  const parts = grant.split(".");
  if (parts.length !== 3) throw new Error("malformed grant");
  const [header, payload, signature] = parts;
  const [h, claims] = [header, payload].map(part => JSON.parse(Buffer.from(part, "base64url").toString()));
  if (h.alg !== "ES256" || h.typ !== "hexbot-grant+jwt") throw new Error("unsupported grant header");
  const published = await publishedKeys(c.api_base, h.kid);
  const key = c.keys.find(k => k.kid === h.kid && k.kty === "EC" && k.crv === "P-256" && published.some(p => p.kid === k.kid && p.kty === k.kty && p.crv === k.crv && p.x === k.x && p.y === k.y));
  if (!key) throw new Error("grant key is not pinned or no longer published");
  if (!verify("sha256", Buffer.from(`${header}.${payload}`), { key: createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))) throw new Error("bad grant signature");
  for (const [name, value] of Object.entries({ iss: c.issuer, aud: c.daemon_id, sub: c.owner_id, daemon_id: c.daemon_id })) if (!value || claims[name] !== value) throw new Error(`grant ${name} does not match`);
  // Sixty seconds of leeway: a daemon clock slightly behind Connect's must not reject every grant.
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number" || !(claims.exp + 60 > now() && claims.iat - 60 <= now()) || typeof claims.jti !== "string" || typeof claims.device_name !== "string") throw new Error("grant is expired or incomplete");
  return claims;
}

if (import.meta.main) {
  const [command, port] = process.argv.slice(2);
  const main = command === "tunnel" ? tunnel(port) : command === "verify" ? verifyGrant(readFileSync(0, "utf8").trim()).then(claims => console.log(JSON.stringify(claims))) : Promise.reject(new Error("usage: connect_agent.mts tunnel <port> | verify"));
  main.catch((error: Error) => { console.error(error.message); process.exit(1); });
}

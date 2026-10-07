import { isIP } from "node:net";
import { hashToken } from "./tokens";

/** Trust only a deployment-owned address header, never arbitrary forwarded headers. */
export function registrationClientHash(request: Request): string {
  const header = process.env.VERCEL === "1" ? "x-vercel-forwarded-for"
    : process.env.CONNECT_TRUST_PROXY === "1" ? "x-real-ip" : null;
  const ip = header ? request.headers.get(header)?.trim() ?? "" : "";
  let client = "unknown";
  if (isIP(ip) === 4) client = ip;
  if (isIP(ip) === 6 && !ip.includes("%")) {
    const canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1);
    // Group IPv6 clients by /64 so changing the host address cannot reset the limit.
    // IPv4-mapped addresses identify individual IPv4 clients instead.
    if (canonical.startsWith("::ffff:")) client = canonical;
    else {
      const [left, right = ""] = canonical.split("::");
      const head = left ? left.split(":") : [], tail = right ? right.split(":") : [];
      const groups = [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
      client = groups.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(":") + "/64";
    }
  }
  return hashToken(client);
}

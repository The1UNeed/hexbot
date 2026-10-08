import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";

export interface User { id: string; clerkUserId: string; createdAt: Date }
export interface Daemon { id: string; userId: string; name: string; slug: string; tunnelId: string; tunnelHostname: string; ingressPort: number; tokenHash: string; identityKey: string | null; createdAt: Date; lastSeenAt: Date | null; revokedAt: Date | null }
export interface Registration { id: string; userCode: string; deviceCodeHash: string; daemonName: string; platform: string; ingressPort: number; userId: string | null; expiresAt: Date; approvedAt: Date | null; consumedAt: Date | null; daemonId: string | null }
export interface ClientSession { id: string; userId: string; tokenHash: string; deviceName: string; createdAt: Date; lastSeenAt: Date | null; revokedAt: Date | null }
/** Spent and expired codes and registrations are cleared a day after they expire, as the privacy policy says. */
export const GRANT_CODE_RETENTION_MS = 24 * 60 * 60_000;
export const REGISTRATION_ATTEMPTS_PER_MINUTE = 10;
/** A one-time code handed to a browser signing in to a daemon; the daemon exchanges it for a grant (docs/connect.md). */
/** An app sign-in the user approved, waiting for the app to collect it with the verifier behind `challenge` (docs/connect.md, "App sign-in"). */
export interface ClientAuthorization { id: string; challenge: string; userId: string; deviceName: string; createdAt: Date; expiresAt: Date; consumedAt: Date | null }
export interface GrantCode { id: string; codeHash: string; daemonId: string; userId: string; deviceName: string; challenge: string; redirectUri: string; createdAt: Date; expiresAt: Date; consumedAt: Date | null }

/** Every table migrations.sql creates and every column it adds later; a test keeps this in step with the file. */
export const SCHEMA: Record<string, string[]> = {
  users: [],
  daemons: ["ingress_port", "tunnel_repair_at", "identity_key"],
  registrations: ["daemon_id"],
  registration_attempts: [],
  client_sessions: [],
  grant_codes: [],
  client_authorizations: [],
};
/** Names (`table` or `table.column`) from SCHEMA that are absent from `present`, a set of `table.column` strings. */
export function schemaGaps(present: Set<string>): string[] {
  const tables = new Set([...present].map(name => name.split(".")[0]));
  return Object.entries(SCHEMA).flatMap(([table, columns]) => tables.has(table) ? columns.filter(c => !present.has(`${table}.${c}`)).map(c => `${table}.${c}`) : [table]);
}

export interface Store {
  /** What the database lacks from migrations.sql, empty when the migration has run. */
  missingSchema(): Promise<string[]>;
  claimRegistrationAttempt(clientHash: string, windowStart: Date): Promise<boolean>;
  getOrCreateUser(clerkUserId: string): Promise<User>;
  createRegistration(input: Omit<Registration, "id" | "userId" | "approvedAt" | "consumedAt" | "daemonId">): Promise<Registration>;
  findRegistrationByDeviceHash(hash: string): Promise<Registration | null>;
  findRegistrationByUserCode(code: string): Promise<Registration | null>;
  /** Claims an unexpired, unapproved registration for one account: true at most once, so two approvals cannot both create a daemon and a tunnel. */
  claimRegistration(id: string, userId: string, at: Date): Promise<boolean>;
  /** Points a claimed registration at its daemon; the daemon's poll then collects it. */
  approveRegistration(id: string, daemonId: string): Promise<void>;
  /** Gives a claim back when its tunnel or daemon could not be created. */
  releaseRegistration(id: string): Promise<void>;
  consumeRegistration(id: string): Promise<boolean>;
  createDaemon(input: Omit<Daemon, "id" | "identityKey" | "createdAt" | "lastSeenAt" | "revokedAt">): Promise<Daemon>;
  getDaemon(id: string): Promise<Daemon | null>;
  listDaemons(userId: string, includeRemoving?: boolean): Promise<Daemon[]>;
  findDaemonByTokenHash(hash: string): Promise<Daemon | null>;
  enrollDaemonIdentity(id: string, publicKey: string): Promise<boolean>;
  /** False once the daemon is revoked: a revoke that lands while the poll fetches the tunnel token wins. */
  setDaemonTokenHash(id: string, tokenHash: string): Promise<boolean>;
  updateDaemonHeartbeat(id: string, at: Date, ingressPort: number): Promise<void>;
  /** Compare-and-set: true only if the row still pointed at `from` and is not revoked, so two repairs cannot both win and a revoke always does. */
  swapDaemonTunnel(id: string, from: string, to: string): Promise<boolean>;
  /** Claims the daemon's single repair slot: true at most once per `cooldownMs`, never for a revoked row. Only the repair route uses the column behind this. */
  claimTunnelRepair(id: string, at: Date, cooldownMs: number): Promise<boolean>;
  clearDaemonTunnel(id: string, deleted: string): Promise<boolean>;
  renameDaemon(id: string, name: string): Promise<void>;
  revokeDaemon(id: string, at: Date): Promise<void>;
  createClientSession(input: Omit<ClientSession, "id" | "createdAt" | "lastSeenAt" | "revokedAt">): Promise<ClientSession>;
  findClientSessionByTokenHash(hash: string): Promise<ClientSession | null>;
  listClientSessions(userId: string): Promise<ClientSession[]>;
  touchClientSession(id: string, at: Date): Promise<void>;
  revokeClientSession(id: string, userId: string, at: Date): Promise<boolean>;
  /** False when another account already approved this challenge or it was already collected. */
  approveClientAuthorization(input: Omit<ClientAuthorization, "id" | "createdAt" | "consumedAt">): Promise<boolean>;
  /** Marks an approved, unexpired, uncollected authorization collected, at most once. */
  claimClientAuthorization(challenge: string, at: Date): Promise<Pick<ClientAuthorization, "userId" | "deviceName"> | null>;
  createGrantCode(input: Omit<GrantCode, "id" | "createdAt" | "consumedAt">): Promise<GrantCode>;
  findGrantCodeByHash(hash: string): Promise<GrantCode | null>;
  consumeGrantCode(id: string): Promise<boolean>;
}

export class MemoryStore implements Store {
  private registrationAttempts = new Map<string, { window: number; count: number }>();
  async missingSchema(): Promise<string[]> { return []; }
  async claimRegistrationAttempt(clientHash: string, windowStart: Date) {
    const window = windowStart.getTime();
    for (const [key, value] of this.registrationAttempts) if (value.window < window - GRANT_CODE_RETENTION_MS) this.registrationAttempts.delete(key);
    const previous = this.registrationAttempts.get(clientHash);
    if (previous && previous.window > window) return false;
    const count = previous?.window === window ? previous.count : 0;
    if (count >= REGISTRATION_ATTEMPTS_PER_MINUTE) return false;
    this.registrationAttempts.set(clientHash, { window, count: count + 1 });
    return true;
  }
  users: User[] = []; daemons: Daemon[] = []; registrations: Registration[] = []; clientSessions: ClientSession[] = []; grantCodes: GrantCode[] = []; clientAuthorizations: ClientAuthorization[] = [];
  async getOrCreateUser(clerkUserId: string) { let row = this.users.find(x => x.clerkUserId === clerkUserId); if (!row) { row = { id: randomUUID(), clerkUserId, createdAt: new Date() }; this.users.push(row); } return row; }
  async createRegistration(input: Omit<Registration, "id" | "userId" | "approvedAt" | "consumedAt" | "daemonId">) { const cutoff = Date.now() - GRANT_CODE_RETENTION_MS; this.registrations = this.registrations.filter(x => x.expiresAt.getTime() > cutoff); const row = { ...input, id: randomUUID(), userId: null, approvedAt: null, consumedAt: null, daemonId: null }; this.registrations.push(row); return row; }
  async findRegistrationByDeviceHash(hash: string) { return this.registrations.find(x => x.deviceCodeHash === hash) ?? null; }
  async findRegistrationByUserCode(code: string) { return this.registrations.find(x => x.userCode === code) ?? null; }
  async claimRegistration(id: string, userId: string, at: Date) { const row = this.registrations.find(x => x.id === id); if (!row || row.approvedAt || row.consumedAt || row.expiresAt.getTime() <= at.getTime()) return false; Object.assign(row, { userId, approvedAt: at }); return true; }
  async approveRegistration(id: string, daemonId: string) { const row = this.registrations.find(x => x.id === id); if (!row || !row.approvedAt || row.daemonId) throw new Error("registration not claimed"); row.daemonId = daemonId; }
  async releaseRegistration(id: string) { const row = this.registrations.find(x => x.id === id); if (row && !row.daemonId) Object.assign(row, { userId: null, approvedAt: null }); }
  async consumeRegistration(id: string) { const row = this.registrations.find(x => x.id === id); if (!row || row.consumedAt) return false; row.consumedAt = new Date(); return true; }
  async createDaemon(input: Omit<Daemon, "id" | "identityKey" | "createdAt" | "lastSeenAt" | "revokedAt">) { const row = { ...input, id: randomUUID(), identityKey: null, createdAt: new Date(), lastSeenAt: null, revokedAt: null }; this.daemons.push(row); return row; }
  async getDaemon(id: string) { return this.daemons.find(x => x.id === id) ?? null; }
  async listDaemons(userId: string, includeRemoving = false) { return this.daemons.filter(x => x.userId === userId && (!x.revokedAt || (includeRemoving && x.tunnelId !== ""))); }
  async findDaemonByTokenHash(hash: string) { return this.daemons.find(x => x.tokenHash === hash) ?? null; }
  async enrollDaemonIdentity(id: string, publicKey: string) { const row = await this.getDaemon(id); if (!row || row.revokedAt || (row.identityKey != null && row.identityKey !== publicKey)) return false; row.identityKey = publicKey; return true; }
  async setDaemonTokenHash(id: string, tokenHash: string) { const row = await this.getDaemon(id); if (!row || row.revokedAt) return false; row.tokenHash = tokenHash; return true; }
  async updateDaemonHeartbeat(id: string, at: Date, ingressPort: number) { const row = await this.getDaemon(id); if (row) { row.lastSeenAt = at; row.ingressPort = ingressPort; } }
  private repairs = new Map<string, Date>();
  async swapDaemonTunnel(id: string, from: string, to: string) { const row = await this.getDaemon(id); if (!row || row.revokedAt || row.tunnelId !== from) return false; row.tunnelId = to; return true; }
  async claimTunnelRepair(id: string, at: Date, cooldownMs: number) { const row = await this.getDaemon(id); if (!row || row.revokedAt) return false; const last = this.repairs.get(id); if (last && at.getTime() - last.getTime() < cooldownMs) return false; this.repairs.set(id, at); return true; }
  async clearDaemonTunnel(id: string, deleted: string) { const row = await this.getDaemon(id); if (!row || !row.revokedAt || row.tunnelId !== deleted) return false; row.tunnelId = ""; return true; }
  async renameDaemon(id: string, name: string) { const row = await this.getDaemon(id); if (row) row.name = name; }
  async revokeDaemon(id: string, at: Date) { const row = await this.getDaemon(id); if (row) row.revokedAt ??= at; }
  async createClientSession(input: Omit<ClientSession, "id" | "createdAt" | "lastSeenAt" | "revokedAt">) { const row = { ...input, id: randomUUID(), createdAt: new Date(), lastSeenAt: null, revokedAt: null }; this.clientSessions.push(row); return row; }
  async findClientSessionByTokenHash(hash: string) { return this.clientSessions.find(x => x.tokenHash === hash) ?? null; }
  async listClientSessions(userId: string) { return this.clientSessions.filter(x => x.userId === userId && !x.revokedAt); }
  async touchClientSession(id: string, at: Date) { const row = this.clientSessions.find(x => x.id === id); if (row) row.lastSeenAt = at; }
  async revokeClientSession(id: string, userId: string, at: Date) { const row = this.clientSessions.find(x => x.id === id && x.userId === userId && !x.revokedAt); if (!row) return false; row.revokedAt = at; return true; }
  async approveClientAuthorization(input: Omit<ClientAuthorization, "id" | "createdAt" | "consumedAt">) {
    const cutoff = Date.now() - GRANT_CODE_RETENTION_MS; this.clientAuthorizations = this.clientAuthorizations.filter(x => x.expiresAt.getTime() > cutoff);
    const existing = this.clientAuthorizations.find(x => x.challenge === input.challenge);
    if (existing) { if (existing.userId !== input.userId || existing.consumedAt) return false; Object.assign(existing, input); return true; }
    this.clientAuthorizations.push({ ...input, id: randomUUID(), createdAt: new Date(), consumedAt: null }); return true;
  }
  async claimClientAuthorization(challenge: string, at: Date) { const row = this.clientAuthorizations.find(x => x.challenge === challenge && !x.consumedAt && x.expiresAt > at); if (!row) return null; row.consumedAt = at; return { userId: row.userId, deviceName: row.deviceName }; }
  async createGrantCode(input: Omit<GrantCode, "id" | "createdAt" | "consumedAt">) { const cutoff = Date.now() - GRANT_CODE_RETENTION_MS; this.grantCodes = this.grantCodes.filter(x => x.expiresAt.getTime() > cutoff); const row = { ...input, id: randomUUID(), createdAt: new Date(), consumedAt: null }; this.grantCodes.push(row); return row; }
  async findGrantCodeByHash(hash: string) { return this.grantCodes.find(x => x.codeHash === hash) ?? null; }
  async consumeGrantCode(id: string) { const row = this.grantCodes.find(x => x.id === id); if (!row || row.consumedAt) return false; row.consumedAt = new Date(); return true; }
}

type DbRow = Record<string, unknown>;
const date = (value: unknown): Date | null => value ? new Date(String(value)) : null;
const daemonRow = (r: DbRow): Daemon => ({ id: String(r.id), userId: String(r.user_id), name: String(r.name), slug: String(r.slug), tunnelId: String(r.tunnel_id), tunnelHostname: String(r.tunnel_hostname), ingressPort: Number(r.ingress_port ?? 9119), tokenHash: String(r.token_hash), identityKey: r.identity_key == null ? null : String(r.identity_key), createdAt: new Date(String(r.created_at)), lastSeenAt: date(r.last_seen_at), revokedAt: date(r.revoked_at) });
const sessionRow = (r: DbRow): ClientSession => ({ id: String(r.id), userId: String(r.user_id), tokenHash: String(r.token_hash), deviceName: String(r.device_name), createdAt: new Date(String(r.created_at)), lastSeenAt: date(r.last_seen_at), revokedAt: date(r.revoked_at) });
const grantCodeRow = (r: DbRow): GrantCode => ({ id: String(r.id), codeHash: String(r.code_hash), daemonId: String(r.daemon_id), userId: String(r.user_id), deviceName: String(r.device_name), challenge: String(r.challenge), redirectUri: String(r.redirect_uri), createdAt: new Date(String(r.created_at)), expiresAt: new Date(String(r.expires_at)), consumedAt: date(r.consumed_at) });
const registrationRow = (r: DbRow): Registration => ({ id: String(r.id), userCode: String(r.user_code), deviceCodeHash: String(r.device_code_hash), daemonName: String(r.daemon_name), platform: String(r.platform), ingressPort: Number(r.ingress_port), userId: r.user_id ? String(r.user_id) : null, expiresAt: new Date(String(r.expires_at)), approvedAt: date(r.approved_at), consumedAt: date(r.consumed_at), daemonId: r.daemon_id ? String(r.daemon_id) : null });

export class NeonStore implements Store {
  private sql: NeonQueryFunction<false, false>;
  private nextRegistrationCleanup = 0;
  constructor(databaseUrl: string) { this.sql = neon(databaseUrl); }
  async missingSchema() { const rows = await this.sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`; return schemaGaps(new Set(rows.map(r => `${r.table_name}.${r.column_name}`))); }
  async claimRegistrationAttempt(clientHash: string, windowStart: Date) {
    const rows = await this.sql`
      INSERT INTO registration_attempts (client_hash, window_start, attempts)
      VALUES (${clientHash}, ${windowStart.toISOString()}, 1)
      ON CONFLICT (client_hash) DO UPDATE SET
        window_start = EXCLUDED.window_start,
        attempts = CASE WHEN registration_attempts.window_start < EXCLUDED.window_start
          THEN 1 ELSE registration_attempts.attempts + 1 END
      WHERE registration_attempts.window_start < EXCLUDED.window_start
        OR (registration_attempts.window_start = EXCLUDED.window_start
          AND registration_attempts.attempts < ${REGISTRATION_ATTEMPTS_PER_MINUTE})
      RETURNING attempts`;
    return rows.length === 1;
  }
  async getOrCreateUser(clerkUserId: string) { const rows = await this.sql`INSERT INTO users (clerk_user_id) VALUES (${clerkUserId}) ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id=EXCLUDED.clerk_user_id RETURNING *`; const r = rows[0] as DbRow; return { id: String(r.id), clerkUserId: String(r.clerk_user_id), createdAt: new Date(String(r.created_at)) }; }
  async createRegistration(i: Omit<Registration, "id" | "userId" | "approvedAt" | "consumedAt" | "daemonId">) {
    if (Date.now() >= this.nextRegistrationCleanup) {
      this.nextRegistrationCleanup = Date.now() + 60_000;
      const cutoff = new Date(Date.now() - GRANT_CODE_RETENTION_MS).toISOString();
      try {
        await this.sql`DELETE FROM registrations WHERE id IN (SELECT id FROM registrations WHERE expires_at < ${cutoff} ORDER BY expires_at LIMIT 1000)`;
        // Recheck age so a concurrent request cannot lose its refreshed counter.
        await this.sql`DELETE FROM registration_attempts WHERE window_start < ${cutoff} AND client_hash IN (SELECT client_hash FROM registration_attempts WHERE window_start < ${cutoff} ORDER BY window_start LIMIT 1000)`;
      } catch (error) { this.nextRegistrationCleanup = 0; throw error; }
    }
    const rows = await this.sql`INSERT INTO registrations (user_code,device_code_hash,daemon_name,platform,ingress_port,expires_at) VALUES (${i.userCode},${i.deviceCodeHash},${i.daemonName},${i.platform},${i.ingressPort},${i.expiresAt.toISOString()}) RETURNING *`;
    return registrationRow(rows[0] as DbRow);
  }
  async findRegistrationByDeviceHash(h: string) { const rows = await this.sql`SELECT * FROM registrations WHERE device_code_hash=${h} LIMIT 1`; return rows[0] ? registrationRow(rows[0] as DbRow) : null; }
  async findRegistrationByUserCode(c: string) { const rows = await this.sql`SELECT * FROM registrations WHERE user_code=${c} ORDER BY expires_at DESC LIMIT 1`; return rows[0] ? registrationRow(rows[0] as DbRow) : null; }
  async claimRegistration(id: string, userId: string, at: Date) { const rows = await this.sql`UPDATE registrations SET user_id=${userId}, approved_at=${at.toISOString()} WHERE id=${id} AND approved_at IS NULL AND consumed_at IS NULL AND expires_at > ${at.toISOString()} RETURNING id`; return rows.length === 1; }
  async approveRegistration(id: string, daemonId: string) { const rows = await this.sql`UPDATE registrations SET daemon_id=${daemonId} WHERE id=${id} AND approved_at IS NOT NULL AND daemon_id IS NULL RETURNING id`; if (rows.length !== 1) throw new Error("registration not claimed"); }
  async releaseRegistration(id: string) { await this.sql`UPDATE registrations SET user_id=NULL, approved_at=NULL WHERE id=${id} AND daemon_id IS NULL`; }
  async consumeRegistration(id: string) { const rows = await this.sql`UPDATE registrations SET consumed_at=now() WHERE id=${id} AND consumed_at IS NULL RETURNING id`; return rows.length === 1; }
  async createDaemon(i: Omit<Daemon, "id" | "identityKey" | "createdAt" | "lastSeenAt" | "revokedAt">) { const rows = await this.sql`INSERT INTO daemons (user_id,name,slug,tunnel_id,tunnel_hostname,ingress_port,token_hash) VALUES (${i.userId},${i.name},${i.slug},${i.tunnelId},${i.tunnelHostname},${i.ingressPort},${i.tokenHash}) RETURNING *`; return daemonRow(rows[0] as DbRow); }
  async getDaemon(id: string) { const rows = await this.sql`SELECT * FROM daemons WHERE id=${id} LIMIT 1`; return rows[0] ? daemonRow(rows[0] as DbRow) : null; }
  async listDaemons(uid: string, includeRemoving = false) { return (await this.sql`SELECT * FROM daemons WHERE user_id=${uid} AND (revoked_at IS NULL OR (${includeRemoving} AND tunnel_id <> '')) ORDER BY created_at`).map(r => daemonRow(r as DbRow)); }
  async findDaemonByTokenHash(h: string) { const rows = await this.sql`SELECT * FROM daemons WHERE token_hash=${h} LIMIT 1`; return rows[0] ? daemonRow(rows[0] as DbRow) : null; }
  // Only this separate write names the new column. SELECT * and registration INSERT work before migration.
  async enrollDaemonIdentity(id: string, publicKey: string) { const rows = await this.sql`UPDATE daemons SET identity_key=${publicKey} WHERE id=${id} AND revoked_at IS NULL AND (identity_key IS NULL OR identity_key=${publicKey}) RETURNING id`; return rows.length === 1; }
  async setDaemonTokenHash(id: string, h: string) { const rows = await this.sql`UPDATE daemons SET token_hash=${h} WHERE id=${id} AND revoked_at IS NULL RETURNING id`; return rows.length === 1; }
  async updateDaemonHeartbeat(id: string, at: Date, ingressPort: number) { await this.sql`UPDATE daemons SET last_seen_at=${at.toISOString()}, ingress_port=${ingressPort} WHERE id=${id}`; }
  async swapDaemonTunnel(id: string, from: string, to: string) { const rows = await this.sql`UPDATE daemons SET tunnel_id=${to} WHERE id=${id} AND tunnel_id=${from} AND revoked_at IS NULL RETURNING id`; return rows.length === 1; }
  async claimTunnelRepair(id: string, at: Date, cooldownMs: number) { const rows = await this.sql`UPDATE daemons SET tunnel_repair_at=${at.toISOString()} WHERE id=${id} AND revoked_at IS NULL AND (tunnel_repair_at IS NULL OR tunnel_repair_at < ${new Date(at.getTime() - cooldownMs).toISOString()}) RETURNING id`; return rows.length === 1; }
  async clearDaemonTunnel(id: string, deleted: string) { const rows = await this.sql`UPDATE daemons SET tunnel_id='' WHERE id=${id} AND tunnel_id=${deleted} AND revoked_at IS NOT NULL RETURNING id`; return rows.length === 1; }
  async renameDaemon(id: string, name: string) { await this.sql`UPDATE daemons SET name=${name} WHERE id=${id}`; }
  async revokeDaemon(id: string, at: Date) { await this.sql`UPDATE daemons SET revoked_at=COALESCE(revoked_at, ${at.toISOString()}) WHERE id=${id}`; }
  async createClientSession(i: Omit<ClientSession, "id" | "createdAt" | "lastSeenAt" | "revokedAt">) { const rows = await this.sql`INSERT INTO client_sessions (user_id,token_hash,device_name) VALUES (${i.userId},${i.tokenHash},${i.deviceName}) RETURNING *`; return sessionRow(rows[0] as DbRow); }
  async findClientSessionByTokenHash(h: string) { const rows = await this.sql`SELECT * FROM client_sessions WHERE token_hash=${h} LIMIT 1`; return rows[0] ? sessionRow(rows[0] as DbRow) : null; }
  async listClientSessions(uid: string) { return (await this.sql`SELECT * FROM client_sessions WHERE user_id=${uid} AND revoked_at IS NULL ORDER BY created_at`).map(r => sessionRow(r as DbRow)); }
  async touchClientSession(id: string, at: Date) { await this.sql`UPDATE client_sessions SET last_seen_at=${at.toISOString()} WHERE id=${id}`; }
  async revokeClientSession(id: string, uid: string, at: Date) { const rows = await this.sql`UPDATE client_sessions SET revoked_at=${at.toISOString()} WHERE id=${id} AND user_id=${uid} AND revoked_at IS NULL RETURNING id`; return rows.length === 1; }
  async approveClientAuthorization(i: Omit<ClientAuthorization, "id" | "createdAt" | "consumedAt">) {
    await this.sql`DELETE FROM client_authorizations WHERE expires_at < ${new Date(Date.now() - GRANT_CODE_RETENTION_MS).toISOString()}`;
    const rows = await this.sql`INSERT INTO client_authorizations (challenge,user_id,device_name,expires_at) VALUES (${i.challenge},${i.userId},${i.deviceName},${i.expiresAt.toISOString()}) ON CONFLICT (challenge) DO UPDATE SET device_name=EXCLUDED.device_name, expires_at=EXCLUDED.expires_at WHERE client_authorizations.user_id=EXCLUDED.user_id AND client_authorizations.consumed_at IS NULL RETURNING id`;
    return rows.length === 1;
  }
  async claimClientAuthorization(challenge: string, at: Date) { const rows = await this.sql`UPDATE client_authorizations SET consumed_at=${at.toISOString()} WHERE challenge=${challenge} AND consumed_at IS NULL AND expires_at > ${at.toISOString()} RETURNING user_id, device_name`; const r = rows[0] as DbRow | undefined; return r ? { userId: String(r.user_id), deviceName: String(r.device_name) } : null; }
  async createGrantCode(i: Omit<GrantCode, "id" | "createdAt" | "consumedAt">) { await this.sql`DELETE FROM grant_codes WHERE expires_at < ${new Date(Date.now() - GRANT_CODE_RETENTION_MS).toISOString()}`; const rows = await this.sql`INSERT INTO grant_codes (code_hash,daemon_id,user_id,device_name,challenge,redirect_uri,expires_at) VALUES (${i.codeHash},${i.daemonId},${i.userId},${i.deviceName},${i.challenge},${i.redirectUri},${i.expiresAt.toISOString()}) RETURNING *`; return grantCodeRow(rows[0] as DbRow); }
  async findGrantCodeByHash(h: string) { const rows = await this.sql`SELECT * FROM grant_codes WHERE code_hash=${h} LIMIT 1`; return rows[0] ? grantCodeRow(rows[0] as DbRow) : null; }
  async consumeGrantCode(id: string) { const rows = await this.sql`UPDATE grant_codes SET consumed_at=now() WHERE id=${id} AND consumed_at IS NULL RETURNING id`; return rows.length === 1; }
}

export const createStore = (): Store => process.env.DATABASE_URL ? new NeonStore(process.env.DATABASE_URL) : new MemoryStore();

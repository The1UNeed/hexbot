import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { hashToken } from "./tokens";
import { getStore } from "./runtime";

export const jsonError = (error: string, message: string, status: number) => NextResponse.json({ error, message }, { status });
export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T | NextResponse> { try { return schema.parse(await request.json()); } catch (error) { return jsonError("invalid_request", error instanceof ZodError ? error.issues[0]?.message ?? "Invalid request" : "Request body must be JSON", 400); } }
const bearer = (request: Request) => { const value = request.headers.get("authorization"); return value?.startsWith("Bearer ") ? value.slice(7) : null; };
export async function requireClient(request: Request) { const token = bearer(request); if (!token) return jsonError("unauthorized", "A client bearer token is required", 401); const row = await getStore().findClientSessionByTokenHash(hashToken(token)); if (!row || row.revokedAt) return jsonError("unauthorized", "The client session is invalid or revoked", 401); await getStore().touchClientSession(row.id, new Date()); return row; }
// A revoked daemon gets a distinct 410 so it can drop its registration; an unknown token stays 401.
export async function requireDaemon(request: Request, allowRevoked = false) { const token = bearer(request); if (!token) return jsonError("unauthorized", "A daemon bearer token is required", 401); const row = await getStore().findDaemonByTokenHash(hashToken(token)); if (!row) return jsonError("unauthorized", "The daemon token is invalid", 401); if (row.revokedAt && !allowRevoked) return jsonError("daemon_revoked", "This daemon was revoked in Hex Connect", 410); return row; }

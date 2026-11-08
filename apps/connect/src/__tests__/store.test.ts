import { beforeEach, describe, expect, it, vi } from "vitest";
import { NeonStore } from "@/lib/store";

const { sql } = vi.hoisted(() => ({ sql: vi.fn(async () => []) }));
vi.mock("@neondatabase/serverless", () => ({ neon: () => sql }));

beforeEach(() => sql.mockClear());

describe("public record ids", () => {
  it.each(["", "missing", "1", "../daemon", "a".repeat(36)])("rejects malformed id %j before querying UUID columns", async id => {
    const store = new NeonStore("postgres://unused");
    await expect(store.getDaemon(id)).resolves.toBeNull();
    await expect(store.revokeClientSession(id, "00000000-0000-0000-0000-000000000001", new Date())).resolves.toBe(false);
    expect(sql).not.toHaveBeenCalled();
  });

  it("queries valid, unknown UUIDs normally", async () => {
    const store = new NeonStore("postgres://unused");
    const id = "00000000-0000-0000-0000-000000000001";
    await expect(store.getDaemon(id)).resolves.toBeNull();
    await expect(store.revokeClientSession(id, id, new Date())).resolves.toBe(false);
    expect(sql).toHaveBeenCalledTimes(2);
  });
});

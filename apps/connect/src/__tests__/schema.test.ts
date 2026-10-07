import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEMA, schemaGaps } from "@/lib/store";

const migration = readFileSync(new URL("../lib/migrations.sql", import.meta.url), "utf8");

describe("schema check", () => {
  it("expects every table and added column in migrations.sql", () => {
    const expected: Record<string, string[]> = {};
    for (const [, table] of migration.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) expected[table] = [];
    for (const [, table, column] of migration.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)) expected[table].push(column);
    expect(SCHEMA).toEqual(expected);
  });

  it("names missing tables and columns, and nothing once migrated", () => {
    const migrated = new Set(Object.entries(SCHEMA).flatMap(([table, columns]) => [`${table}.id`, ...columns.map(c => `${table}.${c}`)]));
    expect(schemaGaps(migrated)).toEqual([]);
    const behind = new Set([...migrated].filter(name => !name.startsWith("registration_attempts.") && name !== "daemons.identity_key"));
    expect(schemaGaps(behind)).toEqual(["daemons.identity_key", "registration_attempts"]);
  });
});

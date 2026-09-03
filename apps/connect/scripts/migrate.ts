import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = neon(databaseUrl);
const migration = await readFile(new URL("../src/lib/migrations.sql", import.meta.url), "utf8");
await sql.query(migration);
console.log("Connect database migration complete.");

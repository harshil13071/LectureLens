import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

let sharedPool: InstanceType<typeof Pool> | undefined;
export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set to use persistent storage.");
  }
  sharedPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
  return sharedPool;
}

export const pool = process.env.DATABASE_URL ? getPool() : undefined;
export const db = pool ? drizzle(pool, { schema }) : undefined;

export * from "./schema";

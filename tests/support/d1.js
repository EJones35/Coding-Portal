import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// A D1-compatible binding backed by a real SQLite engine. The project runs its
// own migration files against it, so the schema under test is the schema that
// ships, not a hand-written approximation.
class Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
    this.prepared = database.prepare(sql);
  }

  bind(...values) {
    this.values = values.flat();
    return this;
  }

  async first() {
    const row = this.prepared.get(...this.values);
    return row === undefined ? null : row;
  }

  async all() {
    return { results: this.prepared.all(...this.values), success: true };
  }

  async run() {
    this.prepared.run(...this.values);
    return { success: true, meta: { changes: 0 } };
  }
}

class Database {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
  }

  prepare(sql) {
    return new Statement(this.sqlite, sql);
  }

  // D1 runs a batch as a single transaction: all statements land, or none do.
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  exec(sql) {
    this.sqlite.exec(sql);
  }

  close() {
    this.sqlite.close();
  }
}

export function createTestDatabase() {
  const database = new Database();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    database.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  return database;
}

export function migrationNames() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith(".sql"))
    .sort();
}

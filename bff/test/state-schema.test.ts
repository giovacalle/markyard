// The D1 migration and the in-code `CREATE TABLE` are one schema (#45): this fails when they drift.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { CREATE_TABLE } from "../src/infrastructure/d1-state-store.ts";

const normalized = (sql: string): string =>
  sql
    .replace(/--.*$/gm, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),;])\s*/g, "$1")
    .replace(/;$/, "")
    .trim();

describe("state schema", () => {
  it("the D1 migration is the in-code CREATE TABLE", () => {
    const migration = readFileSync(
      new URL("../migrations/0001_user_state.sql", import.meta.url),
      "utf8",
    );
    expect(normalized(migration)).toBe(normalized(CREATE_TABLE));
  });
});

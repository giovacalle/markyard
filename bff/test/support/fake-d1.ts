// An in-memory stand-in for a Cloudflare D1 binding, just enough for `d1-state-store.ts`: it
// recognises the store's three statements and applies the same monotonic upsert rule as SQLite.

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
} from "../../src/infrastructure/d1-state-store.ts";

interface Row {
  state_json: string;
  updated_at: number;
}

export class FakeD1 implements D1DatabaseLike {
  readonly rows = new Map<string, Row>();
  readonly queries: Array<string> = [];
  /** When set, every statement rejects with this message. */
  failWith: string | undefined;

  prepare(query: string): D1PreparedStatementLike {
    return this.statement(query, []);
  }

  private statement(query: string, values: ReadonlyArray<unknown>): D1PreparedStatementLike {
    const sql = query.trim().replace(/\s+/g, " ");
    const fail = () =>
      this.failWith === undefined ? undefined : Promise.reject(new Error(this.failWith));
    return {
      bind: (...next) => this.statement(query, next),
      first: <T>() => {
        this.queries.push(sql);
        const failed = fail();
        if (failed !== undefined) return failed as Promise<T | null>;
        if (!sql.startsWith("SELECT state_json, updated_at FROM user_state WHERE email = ?1"))
          return Promise.reject(new Error(`unexpected first(): ${sql}`));
        const row = this.rows.get(values[0] as string);
        return Promise.resolve((row === undefined ? null : { ...row }) as T | null);
      },
      run: () => {
        this.queries.push(sql);
        const failed = fail();
        if (failed !== undefined) return failed;
        if (sql.startsWith("CREATE TABLE IF NOT EXISTS user_state")) return Promise.resolve({});
        if (
          sql.startsWith("INSERT INTO user_state") &&
          sql.includes("WHERE excluded.updated_at >= user_state.updated_at")
        ) {
          const [email, stateJson, updatedAt] = values as [string, string, number];
          const current = this.rows.get(email);
          if (current === undefined || updatedAt >= current.updated_at)
            this.rows.set(email, { state_json: stateJson, updated_at: updatedAt });
          return Promise.resolve({});
        }
        return Promise.reject(new Error(`unexpected run(): ${sql}`));
      },
    };
  }
}

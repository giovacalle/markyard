// Optional state sync on the Node host (#45): a `node:sqlite` database behind the BFF's duck-typed
// D1 interface (`prepare().bind().first()/run()`), so the unchanged D1 state store runs on it.
// The schema is the BFF's own `CREATE TABLE`, run by the store before its first query.

import { DatabaseSync } from "node:sqlite";

const BUSY_TIMEOUT_MS = 5000;

/**
 * Wraps `db` as a D1 database. A raw `DatabaseSync` must not be passed to the BFF: it has a
 * `prepare` but its statements have no `bind`. Like D1, a bad query rejects when it runs, and
 * `first()` answers `null` (not `undefined`) when there is no row; integers come back as numbers.
 * @param {DatabaseSync} db
 */
export const d1Of = (db) => {
  const statements = new Map();
  const statementFor = (query) => {
    let statement = statements.get(query);
    if (statement === undefined) {
      statement = db.prepare(query);
      statement.setReadBigInts(false);
      statements.set(query, statement);
    }
    return statement;
  };
  const bound = (query, values) => ({
    bind: (...next) => bound(query, next),
    first: async () => {
      const row = statementFor(query).get(...values);
      return row === undefined ? null : { ...row };
    },
    run: async () => {
      const { changes } = statementFor(query).run(...values);
      return { success: true, meta: { changes: Number(changes) } };
    },
  });
  return { prepare: (query) => bound(query, []) };
};

/** Opens (or creates) the SQLite file at `path` with WAL and a busy timeout, as a D1 database. */
export const openSqliteD1 = (path) => {
  const db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
  db.exec("PRAGMA journal_mode = WAL");
  return { db, d1: d1Of(db) };
};

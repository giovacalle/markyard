CREATE TABLE IF NOT EXISTS user_state (
  email TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

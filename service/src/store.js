import { DatabaseSync } from "node:sqlite";

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  const putStmt = db.prepare(
    "INSERT OR REPLACE INTO tokens (token_hash, user_id, channel_id, created_at) VALUES (?, ?, ?, ?)",
  );
  const getStmt = db.prepare(
    "SELECT token_hash AS tokenHash, user_id AS userId, channel_id AS channelId, created_at AS createdAt FROM tokens WHERE token_hash = ?",
  );
  const delStmt = db.prepare("DELETE FROM tokens WHERE token_hash = ?");

  return {
    put({ tokenHash, userId, channelId }) {
      putStmt.run(tokenHash, userId, channelId, Date.now());
    },
    get(tokenHash) {
      return getStmt.get(tokenHash);
    },
    del(tokenHash) {
      delStmt.run(tokenHash);
    },
    close() {
      db.close();
    },
  };
}

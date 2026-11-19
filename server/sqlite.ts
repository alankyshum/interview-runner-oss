/** Bound synchronous SQLite lock waits so short backup reads do not fail app writes. */
export const SQLITE_BUSY_TIMEOUT_MS = 1000;

export function configureSqliteBusyTimeout(db: { exec(sql: string): void }): void {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
}

import { isTextAsset } from './assetIndex';
import type { ContentDb } from './contentDb';

/** Remove only binary asset index rows; preserve the stored text rows verbatim. */
export function compactAssetIndex(db: ContentDb, apply: boolean, outputPath?: string): { removed: number; retained: number } {
  if (apply && !outputPath) throw new Error('An output path is required for compaction');
  db.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
  let removed = 0; let retained = 0;
  try {
    const rows = db.prepare('SELECT rowid,course_id,path FROM asset_fts ORDER BY rowid').all() as Array<{ rowid: number; course_id: string; path: string }>;
    const hashes = db.prepare('SELECT DISTINCT blob_sha256 FROM lesson_file WHERE course_id=? AND path=?');
    const blob = db.prepare('SELECT bytes FROM blob WHERE sha256=?');
    const remove = db.prepare('DELETE FROM asset_fts WHERE rowid=?');
    for (const row of rows) {
      const matches = hashes.all(row.course_id, row.path) as Array<{ blob_sha256: string }>;
      if (matches.length !== 1) throw new Error(`Indexed asset does not have exactly one associated blob: ${row.course_id}/${row.path}`);
      const value = blob.get(matches[0]!.blob_sha256) as { bytes: Uint8Array } | undefined;
      if (!value) throw new Error(`Indexed asset blob is missing: ${row.course_id}/${row.path}`);
      if (isTextAsset(row.path, value.bytes)) retained++;
      else { removed++; if (apply) remove.run(row.rowid); }
    }
    if (apply) {
      db.exec("INSERT INTO asset_fts(asset_fts) VALUES('optimize')");
      db.exec("INSERT INTO asset_fts(asset_fts) VALUES('integrity-check')");
      db.exec('COMMIT');
    } else db.exec('ROLLBACK');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  if (apply) {
    try { db.prepare('VACUUM INTO ?').run(outputPath); }
    catch (error) { throw new Error('Working snapshot FTS rows were updated but VACUUM INTO failed; rerun with a new output path', { cause: error }); }
  }
  return { removed, retained };
}

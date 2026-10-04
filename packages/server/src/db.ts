/**
 * Datenbank auf Basis von `node:sqlite` (in Node 22+ eingebaut).
 *
 * Bewusst ohne ORM und ohne native Abhängigkeit: Das Schema hat drei Tabellen,
 * und Bearbeitungen sind ohnehin JSON-Dokumente. Ein Query-Builder würde hier
 * nur eine Abstraktionsschicht ohne Nutzen einziehen.
 *
 * Die Spalten `owner_id`, `remote_id` und `updated_at` sind die Vorbereitung
 * auf die spätere Cloud-Synchronisation (ARCHITECTURE.md §9). Sie werden
 * derzeit geschrieben, aber noch nicht ausgewertet.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  createDefaultParams,
  sanitizeEditParams,
  type EditParams,
  type EditRationale,
  type ImageAnalysis,
  type PhotoMeta,
  type Project,
  type ProjectSummary,
  type Version,
} from '@photomaster/shared';
import { paths } from './config.ts';
import { AppError } from './errors.ts';

let db: DatabaseSync | undefined;

export function openDatabase(): DatabaseSync {
  // Ein bereits offenes Handle zuerst schließen. Ohne das bliebe bei einem
  // zweiten Aufruf die alte Verbindung als Leck zurück — unter Windows hält
  // sie die Datei gesperrt, sodass sie sich nicht einmal löschen lässt.
  db?.close();
  db = new DatabaseSync(paths.db);
  // WAL erlaubt gleichzeitiges Lesen während eines Schreibvorgangs — relevant,
  // weil ein Export minutenlang laufen kann, während die UI weiter Daten liest.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate();
  return db;
}

function migrate(): void {
  conn().exec(`
    CREATE TABLE IF NOT EXISTS photos (
      id             TEXT PRIMARY KEY,
      hash           TEXT NOT NULL UNIQUE,
      original_name  TEXT NOT NULL,
      format         TEXT NOT NULL,
      storage_ext    TEXT NOT NULL DEFAULT 'bin',
      mime_type      TEXT NOT NULL,
      bytes          INTEGER NOT NULL,
      width          INTEGER NOT NULL,
      height         INTEGER NOT NULL,
      orientation    INTEGER NOT NULL DEFAULT 1,
      has_exif       INTEGER NOT NULL DEFAULT 0,
      has_icc        INTEGER NOT NULL DEFAULT 0,
      icc_profile    TEXT,
      camera_json    TEXT NOT NULL DEFAULT '{}',
      source_json    TEXT NOT NULL DEFAULT '{}',
      preview_width  INTEGER NOT NULL,
      preview_height INTEGER NOT NULL,
      owner_id       TEXT,
      remote_id      TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id                TEXT PRIMARY KEY,
      photo_id          TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      params_json       TEXT NOT NULL,
      active_version_id TEXT,
      analysis_json     TEXT,
      owner_id          TEXT,
      remote_id         TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS versions (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      params_json    TEXT NOT NULL,
      rationale_json TEXT,
      position       INTEGER NOT NULL DEFAULT 0,
      owner_id       TEXT,
      remote_id      TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_projects_photo   ON projects(photo_id);
    CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id, position);
  `);

  // `CREATE TABLE IF NOT EXISTS` ergänzt in einer bereits bestehenden Tabelle
  // keine neuen Spalten. Ohne diesen Schritt würde eine Datenbank aus einer
  // älteren Version beim ersten Zugriff mit "no such column" abbrechen — und
  // damit sämtliche Projekte unerreichbar machen.
  addMissingColumns('photos', {
    storage_ext: "TEXT NOT NULL DEFAULT 'bin'",
    owner_id: 'TEXT',
    remote_id: 'TEXT',
  });
  addMissingColumns('projects', { owner_id: 'TEXT', remote_id: 'TEXT' });
  addMissingColumns('versions', { owner_id: 'TEXT', remote_id: 'TEXT' });
}

function addMissingColumns(table: string, columns: Record<string, string>): void {
  const existing = new Set(
    (conn().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (existing.has(name)) continue;
    conn().exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

/** Zugriff auf die geöffnete Verbindung; meldet einen klaren Fehler statt
 *  eines TypeError, falls sie noch nicht geöffnet wurde. */
function conn(): DatabaseSync {
  if (!db) throw new AppError('INTERNAL', 'Die Projektdatenbank ist nicht geöffnet.');
  return db;
}

const now = (): string => new Date().toISOString();

// ── Fotos ──────────────────────────────────────────────────────────────────

type PhotoRow = {
  id: string;
  hash: string;
  original_name: string;
  format: string;
  storage_ext: string;
  mime_type: string;
  bytes: number;
  width: number;
  height: number;
  orientation: number;
  has_exif: number;
  has_icc: number;
  icc_profile: string | null;
  camera_json: string;
  source_json: string;
  preview_width: number;
  preview_height: number;
  created_at: string;
};

function rowToPhoto(r: PhotoRow): PhotoMeta {
  return {
    id: r.id,
    hash: r.hash,
    originalName: r.original_name,
    format: r.format,
    storageExt: r.storage_ext,
    mimeType: r.mime_type,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    megapixels: Math.round((r.width * r.height) / 1e5) / 10,
    orientation: r.orientation,
    hasExif: r.has_exif === 1,
    hasIcc: r.has_icc === 1,
    iccProfile: r.icc_profile ?? undefined,
    camera: safeParse(r.camera_json, {}),
    source: safeParse(r.source_json, { kind: 'direct', width: r.width, height: r.height }),
    previewWidth: r.preview_width,
    previewHeight: r.preview_height,
    createdAt: r.created_at,
  };
}

function safeParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function insertPhoto(photo: Omit<PhotoMeta, 'id' | 'createdAt' | 'megapixels'>): PhotoMeta {
  const existing = conn().prepare('SELECT * FROM photos WHERE hash = ?').get(photo.hash) as PhotoRow | undefined;
  if (existing) return rowToPhoto(existing);

  const id = randomUUID();
  const ts = now();
  conn().prepare(
    `INSERT INTO photos (id, hash, original_name, format, storage_ext, mime_type, bytes, width, height,
       orientation, has_exif, has_icc, icc_profile, camera_json, source_json,
       preview_width, preview_height, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    photo.hash,
    photo.originalName,
    photo.format,
    photo.storageExt,
    photo.mimeType,
    photo.bytes,
    photo.width,
    photo.height,
    photo.orientation,
    photo.hasExif ? 1 : 0,
    photo.hasIcc ? 1 : 0,
    photo.iccProfile ?? null,
    JSON.stringify(photo.camera),
    JSON.stringify(photo.source),
    photo.previewWidth,
    photo.previewHeight,
    ts,
    ts,
  );

  return getPhoto(id);
}

export function getPhoto(id: string): PhotoMeta {
  const row = conn().prepare('SELECT * FROM photos WHERE id = ?').get(id) as PhotoRow | undefined;
  if (!row) throw new AppError('NOT_FOUND', 'Dieses Foto wurde nicht gefunden.');
  return rowToPhoto(row);
}

export function findPhotoByHash(hash: string): PhotoMeta | null {
  const row = conn().prepare('SELECT * FROM photos WHERE hash = ?').get(hash) as PhotoRow | undefined;
  return row ? rowToPhoto(row) : null;
}

/** Wird ein Foto noch von einem Projekt verwendet? Schützt vor verwaisten Löschungen. */
function photoInUse(photoId: string, exceptProjectId?: string): boolean {
  const row = conn()
    .prepare('SELECT COUNT(*) AS n FROM projects WHERE photo_id = ? AND id != ?')
    .get(photoId, exceptProjectId ?? '') as { n: number };
  return row.n > 0;
}

// ── Projekte ───────────────────────────────────────────────────────────────

type ProjectRow = {
  id: string;
  photo_id: string;
  name: string;
  params_json: string;
  active_version_id: string | null;
  analysis_json: string | null;
  created_at: string;
  updated_at: string;
};

export function createProject(photoId: string, name: string, params?: EditParams): Project {
  const id = randomUUID();
  const ts = now();
  conn().prepare(
    `INSERT INTO projects (id, photo_id, name, params_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, photoId, name, JSON.stringify(params ?? createDefaultParams()), ts, ts);
  return getProject(id);
}

export function getProject(id: string): Project {
  const row = conn().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!row) throw new AppError('NOT_FOUND', 'Dieses Projekt wurde nicht gefunden.');

  return {
    id: row.id,
    name: row.name,
    photo: getPhoto(row.photo_id),
    params: sanitizeEditParams(safeParse(row.params_json, null)).value,
    activeVersionId: row.active_version_id,
    versions: listVersions(row.id),
    analysis: safeParse<ImageAnalysis | null>(row.analysis_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProjects(limit = 100): ProjectSummary[] {
  const rows = conn()
    .prepare(
      `SELECT p.id, p.name, p.photo_id, ph.hash AS photo_hash, p.created_at, p.updated_at,
              ph.width, ph.height,
              (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id) AS version_count
       FROM projects p
       JOIN photos ph ON ph.id = p.photo_id
       ORDER BY p.updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as {
    id: string;
    name: string;
    photo_id: string;
    photo_hash: string;
    created_at: string;
    updated_at: string;
    width: number;
    height: number;
    version_count: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    photoId: r.photo_id,
    photoHash: r.photo_hash,
    width: r.width,
    height: r.height,
    megapixels: Math.round((r.width * r.height) / 1e5) / 10,
    versionCount: r.version_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function updateProjectParams(id: string, params: EditParams): void {
  const res = conn()
    .prepare('UPDATE projects SET params_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(params), now(), id);
  if (res.changes === 0) throw new AppError('NOT_FOUND', 'Dieses Projekt wurde nicht gefunden.');
}

export function renameProject(id: string, name: string): void {
  conn().prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id);
}

export function setProjectAnalysis(id: string, analysis: ImageAnalysis): void {
  conn().prepare('UPDATE projects SET analysis_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(analysis),
    now(),
    id,
  );
}

export function setActiveVersion(id: string, versionId: string | null): void {
  conn().prepare('UPDATE projects SET active_version_id = ?, updated_at = ? WHERE id = ?').run(
    versionId,
    now(),
    id,
  );
}

export function deleteProject(id: string): { photoId: string; photoStillUsed: boolean } {
  const row = conn().prepare('SELECT photo_id FROM projects WHERE id = ?').get(id) as
    | { photo_id: string }
    | undefined;
  if (!row) throw new AppError('NOT_FOUND', 'Dieses Projekt wurde nicht gefunden.');
  const stillUsed = photoInUse(row.photo_id, id);
  conn().prepare('DELETE FROM projects WHERE id = ?').run(id);
  return { photoId: row.photo_id, photoStillUsed: stillUsed };
}

// ── Versionen ──────────────────────────────────────────────────────────────

type VersionRow = {
  id: string;
  project_id: string;
  name: string;
  params_json: string;
  rationale_json: string | null;
  created_at: string;
  updated_at: string;
};

function rowToVersion(r: VersionRow): Version {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    params: sanitizeEditParams(safeParse(r.params_json, null)).value,
    rationale: safeParse<EditRationale | null>(r.rationale_json, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function listVersions(projectId: string): Version[] {
  const rows = conn()
    .prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY position ASC, created_at ASC')
    .all(projectId) as VersionRow[];
  return rows.map(rowToVersion);
}

export function createVersion(
  projectId: string,
  name: string,
  params: EditParams,
  rationale?: EditRationale | null,
): Version {
  const id = randomUUID();
  const ts = now();
  const max = conn()
    .prepare('SELECT COALESCE(MAX(position), -1) AS p FROM versions WHERE project_id = ?')
    .get(projectId) as { p: number };

  conn().prepare(
    `INSERT INTO versions (id, project_id, name, params_json, rationale_json, position, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    projectId,
    name,
    JSON.stringify(params),
    rationale ? JSON.stringify(rationale) : null,
    max.p + 1,
    ts,
    ts,
  );

  const row = conn().prepare('SELECT * FROM versions WHERE id = ?').get(id) as VersionRow;
  return rowToVersion(row);
}

function getVersion(id: string): Version {
  const row = conn().prepare('SELECT * FROM versions WHERE id = ?').get(id) as VersionRow | undefined;
  if (!row) throw new AppError('NOT_FOUND', 'Diese Version wurde nicht gefunden.');
  return rowToVersion(row);
}

/**
 * Aktualisiert nur die übergebenen Felder. Ein reines Umbenennen darf die
 * gespeicherten Parameter nicht anfassen — sonst verliert der Nutzer seine
 * Bearbeitung durch eine Textänderung.
 */
export function updateVersion(
  id: string,
  changes: { name?: string; params?: EditParams },
): Version {
  const current = getVersion(id);
  conn().prepare('UPDATE versions SET name = ?, params_json = ?, updated_at = ? WHERE id = ?').run(
    changes.name ?? current.name,
    JSON.stringify(changes.params ?? current.params),
    now(),
    id,
  );
  return getVersion(id);
}

export function deleteVersion(id: string): void {
  const res = conn().prepare('DELETE FROM versions WHERE id = ?').run(id);
  if (res.changes === 0) throw new AppError('NOT_FOUND', 'Diese Version wurde nicht gefunden.');
  // War sie die aktive Version eines Projekts, darf der Verweis nicht ins
  // Leere zeigen — `active_version_id` hat keinen Fremdschlüssel, der das
  // von selbst erledigen würde.
  conn().prepare('UPDATE projects SET active_version_id = NULL WHERE active_version_id = ?').run(id);
}

/** Umfang der Ablage für die Datenschutz-Auskunft (§30). */
export function countEntries(): { photos: number; projects: number; versions: number } {
  const count = (table: 'photos' | 'projects' | 'versions'): number =>
    (conn().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  return { photos: count('photos'), projects: count('projects'), versions: count('versions') };
}

export function closeDatabase(): void {
  db?.close();
  db = undefined;
}

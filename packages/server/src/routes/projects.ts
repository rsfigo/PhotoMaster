/**
 * Projekte, Versionen und die gespeicherte Bildanalyse.
 *
 * Alle Bearbeitungen sind hier reine Daten. Kein Endpunkt dieser Datei fasst
 * eine Bilddatei an — eine Version zu speichern schreibt ein paar hundert Byte
 * JSON, nicht ein zweites Foto (§19, §22 des Briefings).
 */

import type { FastifyInstance } from 'fastify';
import {
  PRESETS,
  presetsByCategory,
  sanitizeEditParams,
  type EditRationale,
  type ImageAnalysis,
  type ImageStats,
} from '@photomaster/shared';
import {
  createVersion,
  deleteProject,
  deleteVersion,
  getProject,
  listProjects,
  renameProject,
  setActiveVersion,
  setProjectAnalysis,
  updateProjectParams,
  updateVersion,
} from '../db.ts';
import { AppError } from '../errors.ts';

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', async () => ({ projects: listProjects() }));

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request) => ({
    project: getProject(request.params.id),
  }));

  app.patch<{ Params: { id: string }; Body: { params?: unknown; name?: unknown } }>(
    '/api/projects/:id',
    async (request) => {
      const { id } = request.params;
      const body = request.body ?? {};

      if (typeof body.name === 'string') {
        const name = body.name.trim();
        if (name.length === 0 || name.length > 120) {
          throw new AppError('BAD_REQUEST', 'Der Projektname muss zwischen 1 und 120 Zeichen lang sein.');
        }
        renameProject(id, name);
      }

      let issues: string[] = [];
      if (body.params !== undefined) {
        const sanitized = sanitizeEditParams(body.params);
        issues = sanitized.issues;
        updateProjectParams(id, sanitized.value);
      }

      return { project: getProject(id), issues };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request) => {
    const { photoStillUsed } = deleteProject(request.params.id);
    // Das Original bleibt bewusst liegen, auch wenn kein Projekt es mehr
    // benutzt. Ein Foto zu löschen ist eine eigene, ausdrückliche Handlung —
    // nicht der Nebeneffekt davon, ein Projekt zu schließen.
    return { deleted: true, photoStillUsed };
  });

  /**
   * Die Bildstatistik wird im Browser auf der GPU berechnet (dort liegen die
   * Pixel bereits) und hier nur abgelegt, damit sie beim nächsten Öffnen des
   * Projekts sofort verfügbar ist und die KI sie nutzen kann.
   */
  app.put<{ Params: { id: string }; Body: { stats?: unknown } }>(
    '/api/projects/:id/analysis',
    async (request) => {
      const project = getProject(request.params.id);
      const stats = validateStats(request.body?.stats);

      const analysis: ImageAnalysis = {
        stats,
        // Eine bereits vorhandene Szenenbeschreibung bleibt erhalten — sie
        // hängt am Bildinhalt und nicht an den Messwerten.
        scene: project.analysis?.scene ?? null,
        createdAt: new Date().toISOString(),
      };
      setProjectAnalysis(project.id, analysis);
      return { analysis };
    },
  );

  // ── Versionen (§19) ──────────────────────────────────────────────────────

  app.post<{ Params: { id: string }; Body: { name?: unknown; params?: unknown; rationale?: unknown } }>(
    '/api/projects/:id/versions',
    async (request, reply) => {
      const project = getProject(request.params.id);
      const name =
        typeof request.body?.name === 'string' && request.body.name.trim()
          ? request.body.name.trim().slice(0, 80)
          : `Version ${project.versions.length + 1}`;

      const params =
        request.body?.params !== undefined
          ? sanitizeEditParams(request.body.params).value
          : project.params;

      const version = createVersion(project.id, name, params, sanitizeRationale(request.body?.rationale));
      setActiveVersion(project.id, version.id);
      reply.code(201);
      return { version, project: getProject(project.id) };
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: unknown; params?: unknown } }>(
    '/api/versions/:id',
    async (request) => {
      const body = request.body ?? {};
      const changes: { name?: string; params?: ReturnType<typeof sanitizeEditParams>['value'] } = {};

      if (typeof body.name === 'string') {
        const name = body.name.trim();
        if (!name) throw new AppError('BAD_REQUEST', 'Der Versionsname darf nicht leer sein.');
        changes.name = name.slice(0, 80);
      }
      if (body.params !== undefined) {
        changes.params = sanitizeEditParams(body.params).value;
      }
      if (changes.name === undefined && changes.params === undefined) {
        throw new AppError('BAD_REQUEST', 'Es wurde nichts zum Ändern übergeben.');
      }

      return { version: updateVersion(request.params.id, changes) };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/versions/:id', async (request) => {
    deleteVersion(request.params.id);
    return { deleted: true };
  });

  /** Eine Version zum aktuellen Arbeitsstand machen. */
  app.post<{ Params: { id: string; versionId: string } }>(
    '/api/projects/:id/versions/:versionId/activate',
    async (request) => {
      const project = getProject(request.params.id);
      const version = project.versions.find((v) => v.id === request.params.versionId);
      if (!version) throw new AppError('NOT_FOUND', 'Diese Version wurde nicht gefunden.');
      updateProjectParams(project.id, version.params);
      setActiveVersion(project.id, version.id);
      return { project: getProject(project.id) };
    },
  );

  // ── Presets (§15) ────────────────────────────────────────────────────────

  app.get('/api/presets', async () => ({
    categories: presetsByCategory(),
    count: PRESETS.length,
  }));
}

/** Nimmt eine KI-Begründung nur in der erwarteten Form entgegen. */
function sanitizeRationale(input: unknown): EditRationale | null {
  if (typeof input !== 'object' || input === null) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.summary !== 'string') return null;
  const reasons = Array.isArray(r.reasons)
    ? r.reasons
        .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
        .filter((x) => typeof x.param === 'string' && typeof x.text === 'string')
        .slice(0, 80)
        .map((x) => ({ param: String(x.param), text: String(x.text).slice(0, 600) }))
    : [];
  return { summary: r.summary.slice(0, 2000), reasons };
}

/**
 * Prüft die vom Browser gelieferte Statistik, bevor sie gespeichert wird.
 * Sie geht später in einen KI-Prompt ein; ein Histogramm mit 400 Einträgen
 * oder NaN-Werten darf dort nicht ankommen.
 */
function validateStats(input: unknown): ImageStats {
  if (typeof input !== 'object' || input === null) {
    throw new AppError('BAD_REQUEST', 'Es wurden keine Bildmesswerte übergeben.');
  }
  const s = input as Record<string, unknown>;
  const hist = s.histogram as Record<string, unknown> | undefined;

  const channel = (v: unknown): number[] => {
    if (!Array.isArray(v) || v.length !== 256) {
      throw new AppError('BAD_REQUEST', 'Das übergebene Histogramm hat ein ungültiges Format.');
    }
    return v.map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0));
  };

  const num = (key: string, min = -1e6, max = 1e6): number => {
    const v = Number(s[key]);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : 0;
  };

  if (!hist) throw new AppError('BAD_REQUEST', 'Die Bildmesswerte enthalten kein Histogramm.');

  return {
    histogram: {
      r: channel(hist.r),
      g: channel(hist.g),
      b: channel(hist.b),
      luma: channel(hist.luma),
    },
    meanLuma: num('meanLuma', 0, 1),
    medianLuma: num('medianLuma', 0, 1),
    clippedShadows: num('clippedShadows', 0, 1),
    clippedHighlights: num('clippedHighlights', 0, 1),
    p01: num('p01', 0, 1),
    p05: num('p05', 0, 1),
    p50: num('p50', 0, 1),
    p95: num('p95', 0, 1),
    p99: num('p99', 0, 1),
    contrast: num('contrast', 0, 1),
    meanSaturation: num('meanSaturation', 0, 1),
    meanR: num('meanR', 0, 1),
    meanG: num('meanG', 0, 1),
    meanB: num('meanB', 0, 1),
    temperatureBias: num('temperatureBias', -100, 100),
    tintBias: num('tintBias', -100, 100),
    sharpness: num('sharpness', 0, 1),
    noise: num('noise', 0, 1),
    dominantColors: Array.isArray(s.dominantColors)
      ? s.dominantColors
          .slice(0, 8)
          .filter((c): c is { hex: string; share: number } => typeof c === 'object' && c !== null)
          .map((c) => ({
            hex: /^#[0-9a-f]{6}$/i.test(String(c.hex)) ? String(c.hex) : '#000000',
            share: Math.min(1, Math.max(0, Number(c.share) || 0)),
          }))
      : [],
    regionLuma: buildRegionLuma(s.regionLuma),
  };
}

function buildRegionLuma(input: unknown): number[] {
  const src = Array.isArray(input) ? input : [];
  return Array.from({ length: 9 }, (_, i) => Math.min(1, Math.max(0, Number(src[i]) || 0)));
}

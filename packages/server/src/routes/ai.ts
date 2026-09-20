/**
 * KI-Endpunkte.
 *
 * Alle drei setzen voraus, dass die Bildstatistik bereits vorliegt — sie wird
 * beim Öffnen eines Projekts im Browser berechnet und hochgeladen. Ohne
 * Messwerte wird hier ausdrücklich NICHT geantwortet: Ein Modell, das nur ein
 * kleines Ansichtsbild sieht, würde raten statt messen, und genau das soll die
 * Architektur verhindern (§10).
 */

import type { FastifyInstance } from 'fastify';
import { PRESET_BY_ID, type ChatTurn, type ImageAnalysis } from '@photomaster/shared';
import { getProject, setProjectAnalysis, updateProjectParams } from '../db.ts';
import { AppError } from '../errors.ts';
import { analysisPath } from '../storage.ts';
import { aiStatus, analyzeScene, coachReport, proposeEdit, type EditIntent } from '../ai/service.ts';

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ai/status', async () => aiStatus());

  app.post<{ Params: { id: string } }>('/api/projects/:id/ai/scene', async (request) => {
    const project = getProject(request.params.id);
    const analysis = requireAnalysis(project.analysis);

    const scene = await analyzeScene(analysisPath(project.photo.hash), analysis.stats, project.photo);

    const updated: ImageAnalysis = { ...analysis, scene };
    setProjectAnalysis(project.id, updated);
    return { analysis: updated };
  });

  app.post<{
    Params: { id: string };
    Body: {
      mode?: unknown;
      text?: unknown;
      presetId?: unknown;
      history?: unknown;
      apply?: unknown;
    };
  }>('/api/projects/:id/ai/edit', async (request) => {
    const project = getProject(request.params.id);
    const analysis = requireAnalysis(project.analysis);
    const body = request.body ?? {};

    const result = await proposeEdit({
      photo: project.photo,
      stats: analysis.stats,
      scene: analysis.scene,
      currentParams: project.params,
      intent: parseIntent(body),
      history: parseHistory(body.history),
      analysisImagePath: analysisPath(project.photo.hash),
    });

    // Der Vorschlag wird nur dann sofort gespeichert, wenn der Client das
    // verlangt. Die Oberfläche zeigt ihn zuerst an und übernimmt ihn erst,
    // wenn der Nutzer ihn behält — abgelehnte Vorschläge sollen den
    // gespeicherten Stand nicht überschreiben.
    if (body.apply !== false) {
      updateProjectParams(project.id, result.params);
    }

    return { result, project: getProject(project.id) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/ai/coach', async (request) => {
    const project = getProject(request.params.id);
    const analysis = requireAnalysis(project.analysis);

    const report = await coachReport(
      analysisPath(project.photo.hash),
      analysis.stats,
      project.photo,
      analysis.scene,
    );
    return { report };
  });
}

function requireAnalysis(analysis: ImageAnalysis | null): ImageAnalysis {
  if (!analysis) {
    throw new AppError(
      'BAD_REQUEST',
      'Für dieses Foto liegen noch keine Messwerte vor. Öffne es kurz im Editor, damit es analysiert werden kann.',
    );
  }
  return analysis;
}

function parseIntent(body: { mode?: unknown; text?: unknown; presetId?: unknown }): EditIntent {
  switch (body.mode) {
    case 'auto':
      return { kind: 'auto' };

    case 'vibe': {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) {
        throw new AppError('BAD_REQUEST', 'Beschreibe kurz, welchen Look du möchtest.');
      }
      if (text.length > 1500) {
        throw new AppError('BAD_REQUEST', 'Die Beschreibung ist zu lang (höchstens 1500 Zeichen).');
      }
      return { kind: 'vibe', text };
    }

    case 'preset': {
      const preset = PRESET_BY_ID.get(String(body.presetId));
      if (!preset) throw new AppError('BAD_REQUEST', 'Dieses Preset ist nicht bekannt.');
      return { kind: 'preset', preset };
    }

    default:
      throw new AppError('BAD_REQUEST', 'Unbekannter KI-Modus.');
  }
}

/** Begrenzt den mitgeschickten Gesprächsverlauf (§27). */
function parseHistory(input: unknown): ChatTurn[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((t): t is ChatTurn => {
      if (typeof t !== 'object' || t === null) return false;
      const turn = t as Record<string, unknown>;
      return (
        (turn.role === 'user' || turn.role === 'assistant') &&
        typeof turn.content === 'string' &&
        turn.content.length > 0
      );
    })
    .slice(-12)
    .map((t) => ({ role: t.role, content: t.content.slice(0, 4000) }));
}

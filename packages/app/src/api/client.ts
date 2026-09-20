/**
 * HTTP-Zugriff auf den PhotoMaster-Server.
 *
 * Der Server liefert Fehler immer als `{ error: { code, message } }` mit einem
 * Text, der bereits für den Nutzer formuliert ist (§29). Diese Schicht reicht
 * ihn unverändert weiter — die Oberfläche zeigt ihn direkt an und erfindet
 * keine eigenen Fehlertexte.
 */

import type {
  AiEditResult,
  ChatTurn,
  CoachReport,
  EditParams,
  EditRationale,
  ExportReport,
  ExportSettings,
  ImageAnalysis,
  ImageStats,
  Preset,
  Project,
  ProjectSummary,
  ServerCapabilities,
  StorageReport,
  Version,
} from '@photomaster/shared';

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    throw new ApiError(
      'OFFLINE',
      'Der PhotoMaster-Dienst ist nicht erreichbar. Läuft der Server noch?',
    );
  }

  if (!response.ok) {
    // 502/503/504 kommen nicht von der Anwendung, sondern davor: Der Dienst
    // ist gerade nicht da (Neustart, abgestürzt, noch nicht hochgefahren).
    // Diese Antworten enthalten kein JSON von uns, und "unerwarteter Fehler"
    // wäre die falsche Auskunft.
    let message =
      response.status >= 502
        ? 'Der PhotoMaster-Dienst antwortet gerade nicht. Läuft der Server noch?'
        : 'Es ist ein unerwarteter Fehler aufgetreten.';
    let code = response.status >= 502 ? 'UNAVAILABLE' : 'UNKNOWN';

    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // Antwort war kein JSON — die Meldung von oben bleibt stehen.
    }
    throw new ApiError(code, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const patch = (body: unknown): RequestInit => ({ ...json(body), method: 'PATCH' });

export const api = {
  capabilities: () => request<ServerCapabilities>('/api/capabilities'),

  storage: () => request<StorageReport>('/api/storage'),

  clearExports: () =>
    request<{ removed: number; freedBytes: number }>('/api/storage/exports', {
      method: 'DELETE',
    }),

  // ── Fotos ────────────────────────────────────────────────────────────────

  /**
   * Import mit Fortschrittsmeldung. Wird bewusst über XMLHttpRequest
   * abgewickelt: `fetch` kennt keinen Upload-Fortschritt, und bei einer
   * 40-MB-RAW-Datei ist ein Balken ohne Rückmeldung nicht zumutbar.
   */
  uploadPhoto(
    file: File,
    onProgress?: (fraction: number) => void,
  ): { promise: Promise<{ project: Project; warnings: string[] }>; abort: () => void } {
    const xhr = new XMLHttpRequest();
    const promise = new Promise<{ project: Project; warnings: string[] }>((resolve, reject) => {
      const form = new FormData();
      form.append('file', file, file.name);

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total);
      });

      xhr.addEventListener('load', () => {
        try {
          const body = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(body);
          else reject(new ApiError(body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? 'Der Import ist fehlgeschlagen.'));
        } catch {
          reject(new ApiError('INVALID_RESPONSE', 'Der Server hat unerwartet geantwortet.'));
        }
      });
      xhr.addEventListener('error', () =>
        reject(new ApiError('OFFLINE', 'Die Verbindung zum Server ist abgebrochen.')),
      );
      xhr.addEventListener('abort', () => reject(new ApiError('ABORTED', 'Der Import wurde abgebrochen.')));

      xhr.open('POST', '/api/photos');
      xhr.send(form);
    });

    return { promise, abort: () => xhr.abort() };
  },

  previewUrl: (hash: string) => `/api/photos/${hash}/preview`,
  thumbUrl: (hash: string) => `/api/photos/${hash}/thumb`,
  fullResolutionUrl: (photoId: string) => `/api/photos/${photoId}/full`,

  // ── Projekte ─────────────────────────────────────────────────────────────

  listProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),
  getProject: (id: string) => request<{ project: Project }>(`/api/projects/${id}`),

  saveParams: (id: string, params: EditParams) =>
    request<{ project: Project; issues: string[] }>(`/api/projects/${id}`, patch({ params })),

  renameProject: (id: string, name: string) =>
    request<{ project: Project }>(`/api/projects/${id}`, patch({ name })),

  deleteProject: (id: string) =>
    request<{ deleted: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  saveStats: (id: string, stats: ImageStats) =>
    request<{ analysis: ImageAnalysis }>(`/api/projects/${id}/analysis`, {
      ...json({ stats }),
      method: 'PUT',
    }),

  // ── Versionen ────────────────────────────────────────────────────────────

  createVersion: (id: string, name: string, params: EditParams, rationale?: EditRationale | null) =>
    request<{ version: Version; project: Project }>(
      `/api/projects/${id}/versions`,
      json({ name, params, rationale }),
    ),

  renameVersion: (versionId: string, name: string) =>
    request<{ version: Version }>(`/api/versions/${versionId}`, patch({ name })),

  updateVersionParams: (versionId: string, params: EditParams) =>
    request<{ version: Version }>(`/api/versions/${versionId}`, patch({ params })),

  deleteVersion: (versionId: string) =>
    request<{ deleted: boolean }>(`/api/versions/${versionId}`, { method: 'DELETE' }),

  activateVersion: (projectId: string, versionId: string) =>
    request<{ project: Project }>(
      `/api/projects/${projectId}/versions/${versionId}/activate`,
      { method: 'POST' },
    ),

  // ── Presets ──────────────────────────────────────────────────────────────

  presets: () => request<{ categories: { category: string; presets: Preset[] }[] }>('/api/presets'),

  // ── KI ───────────────────────────────────────────────────────────────────

  aiScene: (projectId: string) =>
    request<{ analysis: ImageAnalysis }>(`/api/projects/${projectId}/ai/scene`, { method: 'POST' }),

  aiEdit: (
    projectId: string,
    body: { mode: 'auto' | 'vibe' | 'preset'; text?: string; presetId?: string; history?: ChatTurn[] },
  ) => request<{ result: AiEditResult; project: Project }>(`/api/projects/${projectId}/ai/edit`, json(body)),

  aiCoach: (projectId: string) =>
    request<{ report: CoachReport }>(`/api/projects/${projectId}/ai/coach`, { method: 'POST' }),

  // ── Export ───────────────────────────────────────────────────────────────

  /**
   * Überträgt die fertig gerechneten Pixel als rohes RGBA. Bei 24 MP sind das
   * 96 MB — deshalb ohne Base64 und ohne JSON-Umweg.
   */
  async exportPixels(
    projectId: string,
    pixels: Uint8Array,
    width: number,
    height: number,
    settings: ExportSettings,
    fileName: string,
  ): Promise<{ report: ExportReport; original: { width: number; height: number; megapixels: number; bytes: number; format: string } }> {
    const query = new URLSearchParams({
      width: String(width),
      height: String(height),
      format: settings.format,
      quality: String(settings.quality),
      resizeWidth: String(settings.resizeWidth),
      resizeHeight: String(settings.resizeHeight),
      keepMetadata: String(settings.keepMetadata),
      chromaSubsampling: settings.chromaSubsampling,
      fileName,
    });

    return request(`/api/projects/${projectId}/export?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: pixels as unknown as BodyInit,
    });
  },
};

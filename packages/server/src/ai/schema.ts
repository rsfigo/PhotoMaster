/**
 * JSON-Schemata für die strukturierten KI-Antworten.
 *
 * Die Parameterliste wird aus der Registry ERZEUGT, nicht abgeschrieben.
 * Dadurch kann das Modell keinen Parameter nennen, den es nicht gibt (die
 * Namen stehen als `enum` im Schema), und ein neu hinzugefügter Regler steht
 * der KI automatisch zur Verfügung — ohne dass hier etwas geändert werden muss.
 *
 * Die Antwort ist bewusst eine LISTE von Einzelanpassungen und kein Objekt mit
 * 61 Feldern:
 *   - Das Modell nennt nur, was es wirklich ändern will. Ein Objekt mit allen
 *     Feldern würde es dazu verleiten, überall etwas einzutragen.
 *   - Jede Anpassung trägt ihre eigene Begründung. Damit entsteht "Warum diese
 *     Bearbeitung?" (§16) in derselben Anfrage, ohne zweiten Aufruf.
 */

import { LOCAL_PARAM_IDS, PARAMS, PARAM_IDS } from '@photomaster/shared';


/**
 * Eine Maske, wie die KI sie beschreiben darf (§28).
 *
 * Ausschließlich Zahlen und Aufzählungen — Koordinaten, Radien, Winkel. Es
 * gibt kein Feld, über das Bildinhalt zurückkommen könnte; die Grenze aus §3
 * gilt hier genauso wie für die globalen Regler.
 *
 * Alle Geometriefelder sind PFLICHT, auch die für die jeweils andere Form.
 * Optionale Felder werden von Modellen unzuverlässig gefüllt; ein Pflichtfeld,
 * das bei einem Verlauf ignoriert wird, kostet nichts.
 */
const MASK_SCHEMA = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description:
        'Kennung einer BESTEHENDEN Maske, die geändert werden soll. Für eine neue Maske ein leerer String.',
    },
    name: { type: 'string', description: 'Kurzer, beschreibender Name, z. B. "Himmel" oder "Motorrad".' },
    type: {
      type: 'string',
      enum: ['linear', 'radial'],
      description:
        'linear = Verlauf über eine Achse (Himmel, Vordergrund). radial = Ellipse (Motiv hervorheben).',
    },
    angle: {
      type: 'number',
      description:
        'Bei linear die Richtung der Achse in Grad: 0 wirkt oben, 90 links, 180 unten, 270 rechts. Bei radial die Drehung der Ellipse.',
    },
    position: {
      type: 'number',
      description: 'Nur linear: Lage des Übergangs entlang der Achse, 0 bis 1.',
    },
    centerX: { type: 'number', description: 'Nur radial: Mittelpunkt waagerecht, 0 = links, 1 = rechts.' },
    centerY: { type: 'number', description: 'Nur radial: Mittelpunkt senkrecht, 0 = oben, 1 = unten.' },
    radiusX: { type: 'number', description: 'Nur radial: halbe Breite als Anteil der Bildbreite.' },
    radiusY: { type: 'number', description: 'Nur radial: halbe Höhe als Anteil der Bildhöhe.' },
    feather: { type: 'number', description: 'Weichheit des Übergangs, 0 bis 1. Unter 0.2 wird die Kante sichtbar.' },
    inverted: { type: 'boolean', description: 'true kehrt die Maske um — der Bereich AUSSERHALB wird bearbeitet.' },
    luminanceRange: {
      type: 'object',
      properties: {
        active: { type: 'boolean' },
        min: { type: 'number', description: 'Untere Helligkeitsgrenze, 0 bis 1.' },
        max: { type: 'number', description: 'Obere Helligkeitsgrenze, 0 bis 1.' },
        feather: { type: 'number', description: 'Weichheit der Grenzen, 0 bis 1.' },
      },
      required: ['active', 'min', 'max', 'feather'],
      additionalProperties: false,
    },
    colorRange: {
      type: 'object',
      properties: {
        active: { type: 'boolean' },
        hue: { type: 'number', description: 'Farbton in Grad: 0 Rot, 60 Gelb, 120 Grün, 240 Blau.' },
        tolerance: { type: 'number', description: 'Wie weit um den Farbton herum, 1 bis 100.' },
      },
      required: ['active', 'hue', 'tolerance'],
      additionalProperties: false,
    },
    adjustments: {
      type: 'array',
      description: 'Was innerhalb dieser Maske verändert wird.',
      items: {
        type: 'object',
        properties: {
          parameter: { type: 'string', enum: [...LOCAL_PARAM_IDS] },
          value: { type: 'number' },
          reason: { type: 'string', description: 'Ein Satz, bezogen auf diesen Bildbereich.' },
        },
        required: ['parameter', 'value', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'id', 'name', 'type', 'angle', 'position', 'centerX', 'centerY',
    'radiusX', 'radiusY', 'feather', 'inverted', 'luminanceRange', 'colorRange', 'adjustments',
  ],
  additionalProperties: false,
} as const;

export const EDIT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'Zwei bis vier Sätze auf Deutsch: was an diesem Foto auffällt und welche Richtung die Bearbeitung nimmt.',
    },
    adjustments: {
      type: 'array',
      description:
        'Nur die Parameter, die tatsächlich geändert werden sollen. Absolute Zielwerte, keine Differenzen.',
      items: {
        type: 'object',
        properties: {
          parameter: { type: 'string', enum: [...PARAM_IDS] },
          value: { type: 'number' },
          reason: {
            type: 'string',
            description:
              'Ein Satz auf Deutsch, der sich auf DIESES Foto bezieht — nicht auf die allgemeine Wirkung des Reglers.',
          },
        },
        required: ['parameter', 'value', 'reason'],
        additionalProperties: false,
      },
    },
    masks: {
      type: 'array',
      maxItems: 4,
      description:
        'Lokale Masken. Leeres Array, wenn die Bearbeitung global auskommt — das ist der Normalfall.',
      items: MASK_SCHEMA,
    },
  },
  required: ['summary', 'adjustments', 'masks'],
  additionalProperties: false,
} as const;

export const SCENE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'Das Hauptmotiv in wenigen Worten.' },
    categories: {
      type: 'array',
      items: { type: 'string' },
      description: 'Zwei bis fünf Schlagworte, z. B. "Motorrad", "Nacht", "Stadt".',
    },
    lighting: { type: 'string', description: 'Lichtsituation in einem kurzen Satz.' },
    timeOfDay: { type: 'string', description: 'Geschätzte Tageszeit.' },
    mood: { type: 'string', description: 'Bildstimmung in wenigen Worten.' },
    composition: { type: 'string', description: 'Bildaufbau in ein bis zwei Sätzen.' },
    observations: {
      type: 'array',
      items: { type: 'string' },
      description: 'Zwei bis vier konkrete technische Beobachtungen zu diesem Bild.',
    },
  },
  required: ['subject', 'categories', 'lighting', 'timeOfDay', 'mood', 'composition', 'observations'],
  additionalProperties: false,
} as const;

export const COACH_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    overall: {
      type: 'string',
      description: 'Zwei bis vier Sätze Gesamteinschätzung auf Deutsch, konstruktiv und konkret.',
    },
    ratings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: {
            type: 'string',
            enum: ['Belichtung', 'Farben', 'Komposition', 'Schärfe', 'Dynamikumfang'],
          },
          score: { type: 'integer', minimum: 0, maximum: 100 },
          comment: { type: 'string', description: 'Ein Satz zur Begründung dieser Bewertung.' },
        },
        required: ['label', 'score', 'comment'],
        additionalProperties: false,
      },
    },
    tips: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Ein bis drei Hinweise für die nächste AUFNAHME — was beim Fotografieren anders gemacht werden könnte, nicht bei der Bearbeitung.',
    },
  },
  required: ['overall', 'ratings', 'tips'],
  additionalProperties: false,
} as const;

/**
 * Die Parameterreferenz für den System-Prompt — ebenfalls aus der Registry
 * erzeugt. Sie nennt je Regler Bereich, Default und Wirkung.
 */
export function buildParameterReference(): string {
  const lines: string[] = [];
  let currentGroup = '';

  for (const p of PARAMS) {
    if (!p.ai) continue;
    if (p.group !== currentGroup) {
      currentGroup = p.group;
      lines.push('');
      lines.push(`## ${currentGroup}`);
    }
    const range = `${p.min}…${p.max}`;
    const unit = p.unit ? ` ${p.unit}` : '';
    const section = p.section ? `${p.section} — ` : '';
    lines.push(`- \`${p.id}\` (${range}${unit}, Standard ${p.default}): ${section}${p.label}. ${p.hint}`);
  }

  return lines.join('\n').trim();
}

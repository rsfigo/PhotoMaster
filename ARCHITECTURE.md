# PhotoMaster — Technische Architektur

> Ergebnis von Phase 1. Dieses Dokument begründet die Technologie-Entscheidungen
> anhand der harten Anforderungen und ist die Referenz für alle weiteren Phasen.

## 1. Die drei Anforderungen, die alles bestimmen

| # | Anforderung | Technische Konsequenz |
|---|---|---|
| A | 24 MP (6000×4000) müssen **in Originalauflösung** exportiert werden | Die Engine muss in Kacheln arbeiten — ein einzelner 6000×4000-RGBA16F-Buffer belegt 192 MB, mehrere gleichzeitig sprengen jeden Consumer-Speicher |
| B | Die Vorschau muss **interaktiv** sein (flüssig beim Slider-Ziehen) | GPU-Verarbeitung. CPU-Bildverarbeitung auf 24 MP braucht Sekunden pro Slider-Schritt |
| C | Vorschau und Export müssen **identisch** aussehen | Es darf nur **eine** Implementierung der Bildmathematik geben. Zwei Engines (GLSL für Preview + libvips für Export) driften garantiert auseinander |

C ist der Knackpunkt: Er verbietet die naheliegende Lösung „WebGL für die Vorschau,
sharp für den Export".

## 2. Kernentscheidung: eine Engine, zwei Betriebsmodi

Die Bildmathematik existiert **genau einmal** — als WebGL2-Render-Graph in
`packages/engine`. Sie läuft in zwei Modi:

```
                 ┌──────────────────────────────┐
  EditParams ──▶ │  WebGL2 Render-Graph          │
                 │  (bis zu 14 Passes, RGBA16F)  │
                 └──────────┬───────────────────┘
                            │
          ┌─────────────────┴──────────────────┐
          ▼                                    ▼
   PREVIEW-MODUS                        EXPORT-MODUS
   ganzes Bild, ≤ 2560 px                kachelweise, volle Auflösung
   → direkt auf den Canvas               → Pixel-Readback → Server → Encoder
   wenige Millisekunden                  6000×4000 in 1024-px-Kacheln
```

Identische Shader, identische Uniforms, identische Reihenfolge → die Vorschau ist
ein exaktes Abbild des Exports. Der einzige Unterschied ist die Auflösung.

### Nachgemessen, nicht nur behauptet

„Es gibt nur eine Implementierung" ist eine Aussage über den Code, nicht über das
Ergebnis. `packages/app/parity.html` misst deshalb das Ergebnis: Ein Testbild aus
zwölf großen einfarbigen Feldern läuft einmal über den Vorschauweg (1280 px, ein
Durchgang) und einmal über den Exportweg (3000×2000, Kacheln zu 1024 px). In
beiden wird die Mitte jedes Feldes gemittelt und verglichen — dort ist das
Ergebnis auflösungsunabhängig, jede Abweichung wäre also echte Drift.

Stand der Messung: **8 Parametersätze × 12 Felder = 96 Vergleiche, größte
Abweichung 0,19 von 255.**

| Parametersatz | größte Abweichung |
|---|---|
| Ton, Farbe, Color Grading | 0,02 |
| Detail (Clarity, Schärfe) | 0,07 |
| Vignette (ortsabhängig) | 0,08 |
| Verlaufs- und Radialmaske | 0,19 |

Die Rangfolge ist die erwartete: Punktoperationen sind praktisch exakt gleich;
alles, was von der Position im Bild abhängt, weicht minimal ab, weil das
Mittelungsfenster in den beiden Auflösungen leicht andere Stellen des Verlaufs
trifft. 0,19 liegt unterhalb des Rauschens, das das Dithering vor der
8-Bit-Quantisierung ohnehin erzeugt.

Die Seite ist ein Messwerkzeug: Sie wird vom Dev-Server ausgeliefert
(`/parity.html`) und ist nicht Teil des Produktions-Builds.

### Auflösungsunabhängigkeit

Alle Radien (Clarity, Texture, Dehaze, Sharpen, Noise Reduction) werden in
*Bruchteilen der langen Bildkante* definiert, nicht in Pixeln. Ein
Clarity-Radius von 2 % ist bei 2560 px Vorschau 51 px und beim 6000-px-Export
120 px — der visuelle Effekt bleibt maßstabsunabhängig gleich. Ohne diese
Normalisierung wäre jeder Local-Contrast-Effekt im Export dramatisch schwächer
als in der Vorschau.

### Kacheln mit Überlappung

Faltungs-Operationen brauchen Nachbarpixel. Jede Kachel wird deshalb mit einem
Rand (`apron`) von `maxKernelRadius` Pixeln gerendert und beim Zusammensetzen
wieder beschnitten. Dadurch sind Kachelgrenzen im Ergebnis mathematisch
unsichtbar — keine Nähte.

## 3. Warum der Encoder trotzdem auf dem Server läuft

Der Browser *kann* kodieren (`canvas.toBlob`), aber:

- `toBlob('image/jpeg', 1.0)` nutzt den Browser-Encoder mit **4:2:0
  Chroma-Subsampling** — Farbdetails werden halbiert. Für ein Fotografie-Produkt
  inakzeptabel.
- Canvas-Encoder **entfernen EXIF, ICC und XMP** vollständig.
- Kein 16-Bit-Output, kein TIFF.

Deshalb liefert der Browser **rohe, unkomprimierte Pixel** an den Server —
den Zustand nach der Verarbeitung, ohne jede Kompression. sharp/libvips kodiert
daraus mit `quality: 100, chromaSubsampling: '4:4:4'` bzw. als 16-Bit-TIFF/PNG.

Die Datei durchläuft damit **genau eine** JPEG-Kompression in ihrem gesamten
Leben — die beim Export. Kein Re-Encoding bei Bearbeitungsschritten.

## 4. Stack

| Schicht | Technologie | Begründung |
|---|---|---|
| Bildverarbeitung | **WebGL2 + GLSL ES 3.0**, RGBA16F | Einzige Option mit interaktiver 24-MP-Verarbeitung *und* Preview/Export-Parität |
| Frontend | **React 19 + TypeScript + Vite** | React nur für die UI, nie im Render-Pfad der Bilddaten |
| State | **Zustand** | Minimal, gut geeignet für History-/Undo-Stacks |
| Backend | **Fastify 5 auf Node 24** | Schlank, gutes Streaming für große Binärdaten |
| Datenbank | **`node:sqlite`** (Node-Builtin) | Keine native Dependency, kein Build-Schritt, transaktional |
| Encode/Decode | **sharp (libvips 8.17)** | Referenzqualität, 16 Bit, TIFF/PNG/JPEG, HEIF, ICC |
| Metadaten | **exifr** (lesen) + **piexifjs** (JPEG-Transplantation) | Reine JS-Lösungen statt eines 50-MB-Binaries |
| KI | **Anthropic Claude** (`claude-opus-5-5`), serverseitig | Antwort per JSON-Schema erzwungen (Structured Outputs), gestreamt; der API-Key verlässt den Server nie |

### Verworfene Alternativen

- **React Native / Expo:** Keine zuverlässige 24-MP-GPU-Pipeline mit
  Multi-Pass-Rendering und 16-Bit-Zwischenpuffern; Export in Originalauflösung
  ist mit RN-Bordmitteln nicht sicher machbar. Das Layout ist stattdessen
  **responsive** nach §26 des Briefings und auf Tablet/Phone im Browser bedienbar.
- **Rein serverseitige Verarbeitung:** libvips hat keine HSL-Bänder, kein
  3-Wege-Color-Grading und keine parametrischen Kurven. Man müsste sie nachbauen
  — dann existiert die Mathematik doppelt und Anforderung C ist verletzt.
- **`headless-gl` auf dem Server:** auf Windows unzuverlässig, nur WebGL 1.

## 5. Datenmodell — non-destructive by construction

```
data/
├── originals/<sha256>.<ext>        ← unveränderlich, wird ausschließlich gelesen
├── working/<sha256>.png            ← nur für HEIC/RAW: verlustfreie Arbeitskopie
├── previews/<sha256>/preview.jpg   ← Render-Quelle für die UI
├── previews/<sha256>/analysis.jpg  ← 1024 px, Bild für die KI
├── exports/
└── photomaster.db
```

Originale werden **content-addressed** über SHA-256 abgelegt. Daraus folgt: Es
gibt im gesamten Code genau einen Pfad, der nach `originals/` schreibt (den
Import), und der bricht ab, wenn der Hash bereits existiert. Eine Bearbeitung
kann das Original technisch nicht überschreiben.

Bearbeitungen sind **reine Daten**: ein JSON-Objekt aus 61 Skalaren, den Kurven
und den lokalen Masken. Eine Version ist nichts als ein weiterer Parametersatz
auf demselben Original. Vier Versionen eines 12-MB-Fotos kosten ~4 KB, nicht 48 MB.

Auch eine Maske ist reine Zahlendarstellung — Mittelpunkt, Radien, Winkel,
Weichheit. Sie wird zur Laufzeit auf der GPU ausgewertet und ist deshalb in
jeder Auflösung dieselbe Form; es gibt keine Maskendatei, die beim Export
hochskaliert werden müsste und dabei Kanten bekäme.

Das gilt auch für den **Pinsel**: Gespeichert wird der Strichverlauf, nicht
das gemalte Bild. Ein Strich ist eine Liste von Koordinaten mit Radius, Härte
und Deckkraft — wenige Kilobyte statt einer Maskendatei in Bildgröße. Gerastert
wird er erst beim Zeichnen, jeweils in der Auflösung des gerade gerenderten
Ausschnitts.

Die Rasterung ist der einzige Pass, der echte Geometrie zeichnet: Jedes
Strichsegment bekommt ein Rechteck, das seine Umgebung abdeckt. Ein
Vollbild-Shader müsste für jedes Pixel den Abstand zu allen Segmenten
berechnen — bei tausenden Segmenten wäre das auch auf einer schnellen
Grafikkarte nicht interaktiv. Bis zu vier Pinselmasken teilen sich die vier
Kanäle einer Textur, weil GLSL ES 3.0 kein Sampler-Array mit laufendem Index
erlaubt, eine vec4-Komponente aber sehr wohl.

## 6. Parameter-Registry als Single Source of Truth

`packages/shared/src/params.ts` definiert jeden Parameter *einmal* mit
`id, label, group, min, max, step, default, unit`. Daraus werden **abgeleitet**:

- die Slider-UI (Label, Bereich, Schrittweite),
- Validierung und Clamping der KI-Antwort,
- das JSON-Schema, das der KI übergeben wird,
- die Belegung der GLSL-Uniforms,
- die „gegenüber Default geändert"-Erkennung für Reset-Buttons.

Ein neuer Parameter wird an genau einer Stelle hinzugefügt.

## 7. Die KI-Grenze (§3 des Briefings)

Die KI hat **keinen Zugriff auf die Bildausgabe**. Ihre einzige Schnittstelle:

```
Eingabe:  Bild-Statistik (Histogramm, Clipping, Luminanz, WB-Schätzung, …)
        + 1024-px-Ansichtsbild
        + aktuelle Parameter
        + Nutzer-Prompt
Ausgabe:  { "exposure": -0.15, "contrast": 12, … }      ← ausschließlich Zahlen
```

Es existiert kein Code-Pfad, über den eine KI-Antwort zu Bildpixeln werden kann.
Das Modell kann das Bild physisch nicht verändern, sondern nur Reglerwerte
vorschlagen, die anschließend validiert und geclampt werden (§32). Generative
Bildbearbeitung ist damit nicht „verboten", sondern architektonisch unmöglich.

### Aufrufweg

Jeder Aufruf wird **gestreamt**, auch wenn niemand die Zwischenstände liest.
Ohne Streaming schickt die API die Kopfzeilen erst, wenn die ganze Antwort
fertig ist — eine Zeitgrenze misst dann die gesamte Rechenzeit und bricht
eine lange, legitime Antwort mit ausführlichem Nachdenken ab. Gestreamt
beginnt die Antwort sofort; `PM_AI_TIMEOUT_MS` erfasst nur noch eine
Gegenstelle, die gar nicht antwortet.

Lehnen die Sicherheitsfilter eine harmlose Anfrage fälschlich ab, wiederholt
die API sie dank `fallbacks: "default"` serverseitig auf einem Ausweichmodell.
Die Oberfläche bekommt dann das Ergebnis statt einer Absage, und der Bericht
nennt das Modell, das tatsächlich geantwortet hat.

### Prüfbarkeit ohne API-Schlüssel

`ANTHROPIC_BASE_URL` lenkt den SDK-Client auf einen anderen Endpunkt — gedacht
für einen Firmen-Proxy, genutzt auch von `ai-transport.test.ts`: Dort antwortet
ein echter HTTP-Server auf `localhost`. Dadurch laufen Anfrageaufbau,
HTTP-Schicht, Antwort-Auspacken und die Fehlerklassen des SDK im Test
tatsächlich ab; eine Attrappe des Clients hätte genau diese Schicht
übersprungen. Ungetestet bleibt allein das Verhalten des Modells selbst.

## 8. Phasenplan → Modul-Mapping

| Phase | Modul |
|---|---|
| 2 Navigation | `app/src/screens`, `app/src/ui` |
| 3 Import + Originalschutz | `server/src/storage`, `server/src/routes/photos` |
| 4 Processing-Engine | `engine/src/gl`, `engine/src/shaders` |
| 5 Manueller Editor | `app/src/features/editor` |
| 6 Foto-Analyse | `engine/src/analysis`, `server/src/analysis` |
| 7 Vibe → Parameter | `server/src/ai` |
| 8 Before/After + Versionen | `app/src/features/compare`, `server/src/routes/versions` |
| 28 Lokale Masken | `shared/src/masks.ts`, `engine/src/shaders/masks.ts`, `app/src/features/panels/MasksPanel.tsx` |
| 28 Maskenpinsel | `engine/src/brush.ts`, `engine/src/shaders/brush.ts`, `app/src/features/viewport/BrushSurface.tsx` |
| 9 Export | `engine/src/export`, `server/src/export` |
| 10 Photo Coach | `server/src/ai/service.ts` |
| 11 Accounts (vorbereitet) | siehe §9 |
| 30 Ablage & Datenschutz | `server/src/routes/system.ts`, `app/src/features/settings` |
| 12–13 Tests & Polish | `packages/server/test`, Anwendungsaufbau in `server/src/app.ts` |

## 9. Cloud-Vorbereitung (Phase 11)

Die App ist local-first. Sync-Fähigkeit ist **im Schema vorbereitet**, nicht
implementiert: Jede Tabelle hat `owner_id`, `updated_at` und `remote_id`. Weil
Bearbeitungen reine Parameter sind, wäre die Synchronisation später ein
Textabgleich weniger Kilobyte; nur Originale müssten als Blobs wandern.

Es gibt bewusst **keine** Attrappen-Login-Maske, solange kein Auth-Backend
dahintersteht (§39).

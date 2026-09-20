# PhotoMaster

Non-destruktive Foto-Bearbeitung für Kameradateien, mit einer KI, die
Reglerwerte vorschlägt — und ausschließlich Reglerwerte.

---

## Starten

```bash
npm install
npm run dev
```

Danach [http://localhost:5173](http://localhost:5173) öffnen. Das war alles —
ohne Datenbankserver, ohne Docker, ohne Konto.

KI-Funktionen sind optional. Für sie eine Datei `.env` im Projektwurzel-
verzeichnis anlegen (`.env.example` als Vorlage):

```
ANTHROPIC_API_KEY=sk-ant-...
```

Ohne Schlüssel funktionieren **alle** Regler, Presets, Versionen, der
Vorher/Nachher-Vergleich und der Export in voller Auflösung unverändert. Die
KI-Schaltflächen sagen dann, dass sie nicht eingerichtet sind — sie tun nicht
so, als täten sie etwas.

| Befehl | Wirkung |
|---|---|
| `npm run dev` | Server und Oberfläche gemeinsam starten |
| `npm test` | Testsuite (157 Tests) |
| `npm run typecheck` | TypeScript über alle vier Pakete |
| `npm run build` | Produktions-Build der Oberfläche |

Bei laufendem Dev-Server misst [/parity.html](http://localhost:5173/parity.html)
zusätzlich, ob Vorschau und Export tatsächlich dasselbe Ergebnis liefern — das
braucht eine GPU und läuft deshalb im Browser, nicht in der Testsuite.

### Voraussetzungen

**Node 22.5 oder neuer** — wegen des eingebauten `node:sqlite`.

**Ein Browser mit WebGL2** und der Erweiterung `EXT_color_buffer_float`. Ohne
sie rechnet die Engine in 8 statt 16 Bit weiter; in weichen Verläufen wird das
als Banding sichtbar. Die längste Bildkante darf `MAX_TEXTURE_SIZE` nicht
überschreiten — auf heutiger Hardware meist 16 384 px, also jenseits jeder
Kamera, aber erreichbar mit einem gestitchten Panorama. Die App sagt in dem
Fall, was los ist, statt abzustürzen.

**Geprüft ist genau eine Umgebung:** Chromium 152 unter Windows 11, GPU-Zugriff
über ANGLE/Direct3D 11 (NVIDIA RTX 2070 SUPER, `MAX_TEXTURE_SIZE` 16 384).
Firefox und Safari erfüllen die Anforderungen auf dem Papier, sind hier aber
nicht ausprobiert worden. Zwei Stellen wären dort zuerst zu prüfen: die
Farbverwaltung eingebetteter ICC-Profile und `createImageBitmap` mit
`imageOrientation: 'from-image'` — beides verhält sich zwischen den
Browser-Engines erfahrungsgemäß nicht identisch.

---

## Was die App tut

Ein Foto importieren, beschreiben welchen Look man möchte, das Ergebnis
kontrollieren, in voller Auflösung exportieren.

- **61 Regler** in sechs Gruppen, dazu Gradationskurven für RGB und jeden
  Einzelkanal sowie ein HSL-Farbmischer mit acht Bändern. 13 davon lassen sich
  zusätzlich lokal auf einen Bildbereich anwenden.
- **Vibe-Editor**: „Cinematic, dunkel und etwas kälter" wird zu konkreten
  Werten — abgeleitet aus den gemessenen Eigenschaften *dieses* Fotos.
- **18 Presets** in sechs Kategorien, wahlweise direkt oder von der KI an das
  Bild angepasst.
- **Lokale Masken**: Verlauf, Ellipse und Pinsel, direkt auf dem Bild
  bedienbar und wahlweise auf einen Helligkeits- oder Farbbereich eingegrenzt.
  Die KI kann Verlauf und Ellipse selbst setzen — „dunkle den Himmel ab" wird
  zu einem Verlauf mit Koordinaten.
- **Vorher/Nachher** als Schieberegler direkt im Bild.
- **Versionen**: mehrere Fassungen desselben Fotos, jede wenige Kilobyte groß.
- **Photo Coach**: Bewertung der *Aufnahme* mit Hinweisen für das nächste Mal.

---

## Die drei Zusagen

### 1. Die Originaldatei wird nicht verändert

Nicht als Vorsatz, sondern als Eigenschaft der Ablage:

- Originale liegen unter dem SHA-256 **ihres Inhalts**. Ein geänderter Inhalt
  ergäbe zwangsläufig einen anderen Dateinamen.
- Geschrieben wird mit `COPYFILE_EXCL` — existiert der Name, schlägt der
  Schreibvorgang fehl, statt zu überschreiben.
- Nach dem Ablegen wird die Datei schreibgeschützt (Modus 444).
- Es gibt im gesamten Code **genau eine** Funktion, die nach `originals/`
  schreibt: der Import.

Nachgeprüft in `packages/server/test/storage.test.ts` — dort wird ausdrücklich
versucht, ein abgelegtes Original zu überschreiben.

### 2. Der Export verliert keine Auflösung und keine Qualität

- Standard ist **immer** die Originalauflösung. Verkleinern ist eine bewusste
  Entscheidung und wird mit der genauen Zahl verlorener Bildpunkte gewarnt.
- JPEG wird mit Qualität 100 und **4:4:4** kodiert. Der Browser-Encoder würde
  die Farbauflösung halbieren — deshalb läuft die Kodierung serverseitig.
- Zwischen Originaldatei und Export liegt **genau eine** Kompression: die beim
  Export. Regler, KI-Bearbeitungen und Undo-Schritte verändern nur Zahlen.
- EXIF, Kamera- und Objektivdaten werden in JPEG-Exporte übernommen; die
  Ausrichtung wird dabei neutralisiert, damit das Bild nicht doppelt gedreht wird.
- Die Ausgabe wird gedithert, damit die 8-Bit-Quantisierung in weichen
  Verläufen keine Stufen erzeugt.

Nach jedem Export steht Original und Ergebnis nebeneinander: Auflösung,
Megapixel, Dateigröße, Format, Qualitätsstufe, Farbauflösung und die Anzahl
der JPEG-Generationen.

### 3. Auch der Pinsel ist non-destruktiv

Ein Pinselstrich wird als **Weg** gespeichert, nicht als Ergebnis: eine Liste
von Koordinaten mit Radius, Härte und Deckkraft. Ein langer Strich quer durchs
Bild sind wenige Kilobyte.

Daraus folgt alles, was einen Maskenpinsel sonst zum Fremdkörper machen würde:

- Er wird bei jedem Bildaufbau neu gerastert — in der Vorschau in
  Bildschirmgröße, beim Export kachelweise in voller Auflösung. Im
  6000-px-Export ist die Maskenkante deshalb genauso scharf wie das Foto.
  Eine einmal gespeicherte Pixelmaske müsste man hochskalieren.
- Er liegt im Verlauf wie jeder Regler: Ein Strich ist ein Undo-Schritt.
- Er passt in eine Version, ohne sie aufzublähen.
- Radieren nimmt Fläche weg, statt eine zweite Ebene anzulegen.

Bis zu vier Pinselmasken sind möglich; sie teilen sich die vier Farbkanäle
einer Maskentextur.

### 4. Die KI erzeugt keine Bildinhalte

Das ist keine Regel, an die sich das Modell halten soll — es gibt schlicht
keinen Weg dorthin:

```
Eingabe:  Messwerte (Histogramm, Clipping, Luminanz, Weißabgleich, Rauschen, …)
        + ein 1024-px-Ansichtsbild
        + die aktuellen Reglerwerte und Masken
        + der Wunsch des Nutzers
Ausgabe:  [{ "parameter": "highlights", "value": -35, "reason": "…" }, …]
        + Masken als Koordinaten: { "type": "linear", "angle": 0,
          "position": 0.42, "feather": 0.4, "adjustments": [ … ] }
```

Die Parameternamen sind im Antwortschema als Aufzählung hinterlegt — das
Modell kann keinen Regler erfinden. Es gibt in der Antwortstruktur kein Feld,
über das ein Bild, eine URL oder Binärdaten zurückkommen könnten; auch eine
Maske ist nur ein Satz Koordinaten, keine Pixelmaske. Jeder Wert läuft
anschließend durch eine Validierung, die begrenzt, rundet und protokolliert,
was sie korrigiert hat. Masken, die das Modell nicht erwähnt, bleiben
unverändert — löschen kann es keine.

Nachgeprüft in `packages/server/test/ai.test.ts` — und der Weg dorthin in
`ai-transport.test.ts`: Dort läuft ein echter HTTP-Server auf `localhost`, mit
dem die App über `ANTHROPIC_BASE_URL` spricht. Damit ist alles echt außer dem
Modell selbst — die Anfrage mit Bild und Messwerten, das Auspacken der Antwort
und jede Fehlermeldung von abgelehntem Schlüssel bis abgerissener Verbindung.

---

## Was die App nicht tut

Ehrlichkeit über die Grenzen gehört zum Produkt:

- **HEIC vom iPhone nur, wenn der Rechner es kann.** HEIC ist HEVC-komprimiert,
  und die mitgelieferte Bildbibliothek bringt dafür aus Lizenzgründen nicht
  überall einen Dekoder mit. Die App probiert es beim Start einmal wirklich aus,
  nennt auf der Startseite und unter „Ablage & Datenschutz“ nur Formate, die
  hier tatsächlich funktionieren, und erklärt beim Import, was stattdessen geht.
- **Keine RAW-Entwicklung.** Aus NEF, CR2, ARW, DNG und Verwandten wird das
  von der Kamera eingebettete JPEG in voller Größe extrahiert — unverändert,
  nicht neu komprimiert. Die Oberfläche benennt das genau so. Enthält eine
  Datei nur ein kleines Vorschaubildchen, wird der Import abgelehnt, statt
  stillschweigend eine Briefmarke zum Bearbeiten anzubieten.
- **Keine generative Bearbeitung.** Kein Himmel-Austausch, kein Objekt
  entfernen, kein Hochskalieren.
- **Keine automatische Motiverkennung.** Es gibt keinen Knopf, der „den
  Himmel" oder „die Person" von selbst auswählt. Masken setzt man von Hand
  oder lässt sie sich von der KI als Verlauf oder Ellipse beschreiben.
- **Die KI malt nicht.** Sie kann Verlaufs- und Radialmasken anlegen und die
  Anpassungen einer gemalten Maske ändern, aber keine Pinselstriche erzeugen
  und keine gemalte Fläche verändern. Nur der Mensch weiß, was er markiert hat.
- **Keine Cloud-Synchronisation.** Das Datenbankschema ist darauf vorbereitet
  (`owner_id`, `remote_id`), es gibt aber weder Anmeldung noch Server dafür —
  und deshalb auch keine Login-Maske, die ins Leere führt.
- **Kein 16-Bit-Export.** Der Browser dekodiert Quelldateien in 8 Bit;
  mehr Bittiefe auszugeben würde die Datei vergrößern, ohne Information
  hinzuzufügen. Gegen Banding wirkt stattdessen das Dithering.

---

## Datenschutz

Fotos sind persönliche Dateien. Was wohin geht — nachzulesen auch **in der App
selbst**, unter dem Schild-Symbol oben rechts auf der Startseite. Dort steht
nicht nur die Zusage, sondern der gemessene Zustand: das benutzte Verzeichnis,
die Anzahl der Fotos und der belegte Platz je Bereich.

**Bleibt immer auf diesem Rechner**

- die Originaldateien (`data/originals/`)
- Vorschauen und Miniaturen (`data/previews/`)
- alle Bearbeitungsparameter und Versionen (`data/photomaster.db`)
- die Exporte (`data/exports/`)

**Wird an Anthropic gesendet — nur bei einer ausdrücklichen KI-Aktion**

- ein auf 1024 px verkleinertes Ansichtsbild
- die berechneten Messwerte des Bildes
- die aktuellen Reglerwerte und der eingegebene Wunsch

Ausgelöst wird das ausschließlich durch einen Klick auf „Automatisch
bearbeiten", „Anwenden", „Bildinhalt analysieren", „Aufnahme bewerten lassen"
oder das Stern-Symbol an einem Preset. Ohne diese Klicks verlässt kein
Bildmaterial den Rechner. Ohne hinterlegten API-Schlüssel ist der Weg
überhaupt nicht vorhanden.

**GPS-Daten werden nicht gelesen.** Der EXIF-Parser ist ausdrücklich ohne
GPS-Block konfiguriert — was nicht gelesen wird, kann auch nicht versehentlich
weitergegeben werden.

**Der API-Schlüssel** steht in `.env`, wird nur serverseitig verwendet und
erreicht den Browser nie.

**Löschen:** Ein Projekt zu schließen löscht nur den Parametersatz. Die
Originaldateien in `data/originals/` werden nie automatisch entfernt — sie
verschwinden nur, wenn man sie selbst löscht. Der einzige Aufräum-Knopf der
App leert das Exportverzeichnis; Exporte lassen sich jederzeit neu erzeugen.

---

## Aufbau

```
packages/
├── shared/    Parameter-Registry, Validierung, Presets, Kurvenmathematik
├── engine/    WebGL2-Bildverarbeitung (Vorschau, 100-%-Ansicht, Export)
├── server/    Fastify-API, Ablage, Metadaten, Encoder, KI-Anbindung
└── app/       React-Oberfläche
```

Zwei Entwurfsentscheidungen tragen den Rest:

**Eine Engine für Vorschau und Export.** Beide laufen durch denselben
WebGL-Render-Graphen; der Unterschied ist nur die Auflösung und ob kachelweise
gearbeitet wird. Es gibt keine zweite Implementierung der Bildmathematik, die
auseinanderdriften könnte.

Das ist nachgemessen und nicht nur behauptet: `/parity.html` schickt dasselbe
Testbild über beide Wege und vergleicht die Ergebnisse. Über 8 Parametersätze
und 12 Farbfelder hinweg beträgt die größte Abweichung **0,19 von 255** — was
in der Vorschau steht, kommt so aus dem Export.

**Eine Registry für alle Parameter.** `packages/shared/src/params.ts`
definiert jeden Regler einmal. Daraus entstehen die Slider-Oberfläche, die
Validierung, das KI-Schema, die GLSL-Uniforms und die Zurücksetzen-Logik. Ein
neuer Regler wird an einer Stelle ergänzt.

Die Begründungen im Detail: [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Tastatur

| Taste | Wirkung |
|---|---|
| `Strg/Cmd + Z` | Rückgängig |
| `Strg/Cmd + Umschalt + Z` | Wiederholen |
| `B` | Vorher/Nachher ein- und ausschalten |
| `Alt` (gehalten) | Pinsel radiert vorübergehend |
| `Strg/Cmd + E` | Export öffnen |
| `Strg/Cmd + Enter` | Vibe-Eingabe abschicken |

An einem Regler: Pfeiltasten in Schritten, mit `Umschalt` zehnfach,
`Pos1`/`Ende` an die Enden, `Entf` zurück auf den Standardwert. Mit gedrückter
`Umschalt`-Taste ziehen justiert im Viertelmaßstab fein.

---

## Konfiguration

Alles optional, alles über `.env`:

| Variable | Standard | Bedeutung |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Schaltet die KI-Funktionen frei |
| `PM_AI_MODEL` | `claude-opus-5` | Verwendetes Modell |
| `ANTHROPIC_BASE_URL` | — | Abweichender Endpunkt, etwa ein Firmen-Proxy |
| `PM_AI_TIMEOUT_MS` | `180000` | Zeitgrenze für einen KI-Aufruf |
| `PM_PORT` | `5174` | Port der API |
| `PM_DATA_DIR` | `./data` | Ablageort für Fotos und Datenbank |
| `PM_PREVIEW_EDGE` | `2560` | Kantenlänge der Bearbeitungsvorschau |
| `PM_MAX_UPLOAD_MB` | `400` | Obergrenze für den Import |

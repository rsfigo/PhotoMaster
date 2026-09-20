/**
 * Rasterung der Pinselstriche (§28).
 *
 * Dies ist der einzige Pass der Engine, der echte Geometrie zeichnet statt
 * eines vollflächigen Dreiecks — und zwar aus gutem Grund:
 *
 * Ein Pinselstrich besteht aus vielen kurzen Segmenten. Würde ein
 * Vollbild-Shader über alle Segmente laufen, käme jedes Pixel des Bildes auf
 * mehrere tausend Abstandsberechnungen; das wäre auch auf einer schnellen
 * Grafikkarte nicht interaktiv. Stattdessen bekommt jedes Segment ein eigenes
 * Rechteck, das genau seine Umgebung abdeckt. Ein Pixel wird dadurch nur von
 * den Segmenten berührt, die tatsächlich in seiner Nähe liegen — und das sind
 * fast überall null.
 *
 * Gezeichnet wird in ein seitenverhältnis-korrigiertes Koordinatensystem,
 * damit ein Pinsel rund ist und nicht oval.
 */

export const BRUSH_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 aPos;    // Eckpunkt des Segmentrechtecks, in Bildkoordinaten
in vec2 aSegA;   // Segmentanfang, seitenverhältnis-korrigiert
in vec2 aSegB;   // Segmentende
in vec3 aBrush;  // (Radius korrigiert, Härte, Deckkraft)

uniform vec4  uRegion;  // gerenderter Bildausschnitt (x, y, Breite, Höhe)
uniform float uAspect;

out vec2 vPos;
out vec2 vSegA;
out vec2 vSegB;
out vec3 vBrush;

void main() {
  // Bildkoordinate → Position im gerenderten Ausschnitt → Clip-Raum.
  // Ohne Spiegelung: Die Engine legt Texturzeile 0 auf die OBERE Bildkante
  // und Clip-y −1; beides passt hier zusammen.
  vec2 r = (aPos - uRegion.xy) / uRegion.zw;
  gl_Position = vec4(r * 2.0 - 1.0, 0.0, 1.0);

  vPos = (aPos - 0.5) * vec2(uAspect, 1.0);
  vSegA = aSegA;
  vSegB = aSegB;
  vBrush = aBrush;
}`;

export const BRUSH_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vPos;
in vec2 vSegA;
in vec2 vSegB;
in vec3 vBrush;

uniform float uErase;
/** Kantenlänge eines Zielpixels in korrigierten Einheiten. */
uniform float uTexel;

out vec4 fragColor;

/**
 * Abstand zu einer Strecke.
 *
 * Nicht zum nächsten STÜTZPUNKT, sondern zur Strecke zwischen zweien: Sonst
 * bestünde ein schnell gezogener Strich aus einer Perlenkette einzelner
 * Kreise statt aus einer durchgehenden Linie.
 */
float distanceToSegment(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float len2 = dot(ab, ab);
  float t = len2 > 1e-12 ? clamp(dot(p - a, ab) / len2, 0.0, 1.0) : 0.0;
  return distance(p, a + ab * t);
}

void main() {
  float radius = vBrush.x;
  float hardness = vBrush.y;
  float opacity = vBrush.z;

  float d = distanceToSegment(vPos, vSegA, vSegB);

  // Der harte Kern reicht bis radius*hardness, danach läuft die Deckung aus.
  // Der Übergang ist mindestens ein Pixel breit — eine mathematisch harte
  // Kante würde sonst als Treppe sichtbar.
  float inner = radius * hardness;
  float outer = max(radius, inner + uTexel);
  float coverage = (1.0 - smoothstep(inner, outer, d)) * opacity;

  // Beim Radieren wird nicht die Deckung geschrieben, sondern ihr Gegenstück:
  // Zusammen mit der MIN-Überblendung ergibt das "höchstens noch so viel
  // Maske wie vorher" — ohne dass sich überlappende Stempel eines Strichs
  // gegenseitig aufaddieren und Flecken erzeugen.
  fragColor = vec4(uErase > 0.5 ? 1.0 - coverage : coverage);
}`;

// ============================================================================
//  stages.mjs — canonical Stage course model + query contract
// ----------------------------------------------------------------------------
//  A Stage describes a COURSE only: length, elevation profile, climbs, surface
//  sectors. Calendar context (week, prestige, prize, country) belongs on the
//  Race that points at a Stage — never here. The same Stage object is reused
//  every season; a Grand Tour Race references a list of Stage ids.
//
//  Both sources emit this one shape:
//    • the .cds importer (real courses)        -> stageFromLibrary(rec)
//    • the procedural generator (fictional)    -> stageFromSummary({...})
//
//  The sim NEVER reads raw fields. It asks only:
//    altAt, gradientAt, surfaceAt, nextClimb, terrainMix
//  so it cannot tell — and does not care — whether a stage has a real profile
//  or a synthetic one built from summary numbers.
// ============================================================================

export const FINISH_KINDS = ["flat", "sprint", "hilly", "uphill", "summit", "mountain", "itt", "cobbled", "gravel"];
const DEFAULT_STEP_M = 250;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
//  Construction
// ---------------------------------------------------------------------------

// Normalize a library record (the converter's JSON shape) into a canonical Stage.
// useCurve=false (default for now): ignore the provisional extracted elevation
// curve and build a synthetic profile from the reliable summary numbers. Flip
// to true once .cds curve extraction is validated — the format is identical.
export function stageFromLibrary(rec, useCurve = false) {
  const st = {
    id: rec.id || (rec.file ? rec.file.replace(/\.cds$/i, "") : rec.name),
    name: String(rec.name || rec.file || "Stage").replace(/[\u0000-\u001f]/g, "").trim() || rec.file || "Stage",   // extraction left NUL bytes in some names
    raceType: rec.raceType || "other",
    stage: rec.stage ?? null,
    year: rec.year ?? null,
    distanceKm: rec.distanceKm,
    finishKind: FINISH_KINDS.includes(rec.finishKind) ? rec.finishKind : "flat",
    climbM: rec.climbM || 0,
    maxAltM: rec.maxAltM || 0,
    stepM: rec.stepM || DEFAULT_STEP_M,
    profile: useCurve && Array.isArray(rec.profile) && rec.profile.length > 2 ? rec.profile.slice() : null,
    climbs: useCurve ? (rec.climbs || []).map((c) => ({ ...c })) : [],
    sectors: normSectors(rec.sectors || [], rec.name),
    sprints: rec.sprints || [],
    source: "real",
  };
  ensureProfile(st);
  return st;
}

// Build a Stage from generator summary numbers (no curve needed).
export function stageFromSummary(s) {
  const st = {
    id: s.id, name: s.name || s.id, raceType: s.raceType || "generated",
    stage: s.stage ?? null, year: s.year ?? null,
    distanceKm: s.distanceKm,
    finishKind: FINISH_KINDS.includes(s.finishKind) ? s.finishKind : "flat",
    climbM: s.climbM || 0, maxAltM: s.maxAltM || 0,
    stepM: s.stepM || DEFAULT_STEP_M,
    profile: Array.isArray(s.profile) && s.profile.length > 2 ? s.profile.slice() : null,
    climbs: (s.climbs || []).map((c) => ({ ...c })),
    sectors: normSectors(s.sectors || [], s.name),
    sprints: s.sprints || [],
    source: "generated",
  };
  ensureProfile(st);
  return st;
}

// Cobble star ratings aren't cleanly in the .cds, so derive from length + a
// hand-bump for the famous 5-star sectors.
const FIVE_STAR = ["arenberg", "carrefour", "mons-en-pévèle", "mons-en-pevele"];
function normSectors(secs, raceName) {
  const gravelRace = /strade|gravel/i.test(raceName || "");
  // the .cds extraction collapsed some sectors to ~0 km positions with <200 m lengths —
  // degenerate data that would paint a monument's pavé onto the first 100 m; drop them
  secs = secs.filter((s) => {
    const len = s.lengthM ?? Math.round(((s.endKm || 0) - (s.startKm || 0)) * 1000);
    return !((s.startKm || 0) < 1 && len < 200);
  });
  return secs.map((s) => {
    const len = s.lengthM ?? Math.round(((s.endKm || 0) - (s.startKm || 0)) * 1000);
    let stars = s.stars;
    if (!stars) {
      stars = len > 2200 ? 4 : len > 1500 ? 3 : len > 800 ? 2 : 1;
      if (FIVE_STAR.some((k) => (s.name || "").toLowerCase().includes(k))) stars = 5;
    }
    return {
      name: s.name || "sector",
      startKm: s.startKm, endKm: s.endKm ?? (s.startKm + len / 1000),
      lengthM: len, surface: s.surface || (gravelRace ? "gravel" : "cobble"),
      stars: clamp(stars, 1, 5),
    };
  });
}

// ---------------------------------------------------------------------------
//  Synthetic profile — built when a stage has no real elevation curve.
//  Goal: plausible gradients everywhere, total climbing ≈ climbM, the finish
//  shape matching finishKind. Not exact terrain, but the sim behaves the same.
// ---------------------------------------------------------------------------
function ensureProfile(st) {
  if (st.profile && st.profile.length > 2) { st._synth = false; return; }
  st._synth = true;
  st.stepM = DEFAULT_STEP_M;
  const stepKm = st.stepM / 1000;
  const n = Math.max(4, Math.round(st.distanceKm / stepKm));
  const D = st.distanceKm, fk = st.finishKind;

  // climb centres: use positioned climbs if we have them, else a per-kind template
  let centres;
  if (st.climbs && st.climbs.length) {
    centres = st.climbs.map((c) => {
      const len = c.lengthKm || 2, top = c.startKm + len;   // painter treats pos as the PEAK — use the top of the climb
      return { pos: top, len, w: Math.max(0.2, (c.avgPct || 5) * len),
        finish: top >= st.distanceKm - 1.5 };               // summit finish when the climb tops out at the line
    });
  } else {
    const T = {
      flat: [], sprint: [], itt: [], cobbled: [], gravel: [],
      uphill: [{ pos: D - 2, len: 4, w: 1, finish: true }],
      summit: [{ pos: D * 0.45, len: 7, w: 0.5 }, { pos: D - 6, len: 11, w: 1, finish: true }],
      // ~40% of mountain records finish atop the final pass (the data never tags summits);
      // deterministic per stage id so the same course always has the same finish.
      mountain: (() => {
        let h = 2166136261; for (const ch of String(st.id || st.name || "")) { h = Math.imul(h ^ ch.charCodeAt(0), 16777619); }
        h = (h ^ (h >>> 16)) >>> 0;                       // avalanche — near-identical ids must not cluster
        const summitTop = h % 10 < 4;
        return [{ pos: D * 0.25, len: 8, w: 0.7 }, { pos: D * 0.5, len: 10, w: 0.9 },
                { pos: D * 0.72, len: 9, w: 0.85 },
                summitTop ? { pos: D - 0.3, len: 9, w: 1, finish: true } : { pos: D - 7, len: 8, w: 1 }];
      })(),
      hilly: Array.from({ length: 6 }, (_, i) => ({ pos: D * (i + 1) / 7.5, len: 3, w: 0.6 })),
    }[fk] || [];
    centres = T;
  }

  const alt = new Array(n).fill(0);
  for (const c of centres) {
    const peakI = Math.round(c.pos / stepKm);
    const half = Math.max(1, Math.round((c.len / 2) / stepKm));
    for (let i = peakI - 2 * half; i <= peakI; i++) {          // ascent into peak
      if (i < 0 || i >= n) continue;
      alt[i] += c.w * ((i - (peakI - 2 * half)) / (2 * half));
    }
    if (!c.finish) {                                           // descent after (kept for summit/uphill finishes)
      for (let i = peakI; i <= peakI + 2 * half; i++) {
        if (i < 0 || i >= n) continue;
        alt[i] += c.w * Math.max(0, 1 - (i - peakI) / (2 * half));
      }
    }
  }
  // scale the CLIMBS to the real climbing metres, then add gentle rolling noise in
  // metres. (Scaling noise+climbs together let the noise steal the elevation budget —
  // an 8% mountain pass came out as a 2% drag and the sim saw a pancake.)
  const NOISE_M = 4;                                          // rolling-terrain amplitude (m per 250m step)
  const noise = (i) => NOISE_M * (Math.sin(i * 0.7) + Math.sin(i * 0.23));
  let raw = 0; for (let i = 1; i < n; i++) raw += Math.max(0, alt[i] - alt[i - 1]);
  let noiseGain = 0; for (let i = 1; i < n; i++) noiseGain += Math.max(0, noise(i) - noise(i - 1));
  const scale = raw > 0.5 ? Math.max(0, (st.climbM || 0) - noiseGain) / raw : 0;
  const peakM = Math.max(...alt) * scale;                     // highest point in metres AFTER scaling
  const base = Math.max(0, (st.maxAltM || 0) - peakM);
  for (let i = 0; i < n; i++) alt[i] = Math.round(base + alt[i] * scale + noise(i));
  st.profile = alt;
}

// ---------------------------------------------------------------------------
//  Query contract — the only surface the sim uses
// ---------------------------------------------------------------------------
const idxOf = (st, km) => clamp(km / (st.stepM / 1000), 0, st.profile.length - 1);

export function altAt(st, km) {
  const x = idxOf(st, km), i = Math.floor(x), f = x - i;
  const a = st.profile[i], b = st.profile[Math.min(i + 1, st.profile.length - 1)];
  return a + (b - a) * f;
}

// slope in % over a ~stepM window centred on km
export function gradientAt(st, km) {
  const w = st.stepM / 1000;
  const a0 = altAt(st, Math.max(0, km - w)), a1 = altAt(st, Math.min(st.distanceKm, km + w));
  const run = (Math.min(st.distanceKm, km + w) - Math.max(0, km - w)) * 1000;
  return run > 0 ? (a1 - a0) / run * 100 : 0;
}

export function surfaceAt(st, km) {
  for (const s of st.sectors) if (km >= s.startKm && km <= s.endKm) return { surface: s.surface, stars: s.stars, sector: s };
  return { surface: "road", stars: 0, sector: null };
}

export function nextClimb(st, km) {
  let best = null;
  for (const c of st.climbs) {
    const end = c.startKm + (c.lengthKm || 0);
    if (end >= km && (!best || c.startKm < best.startKm)) best = c;
  }
  return best;
}

// Derive the 0–100 terrain weights the existing raceProfile/raceFit consume,
// straight from the course — replacing any hand-set finishType weighting.
export function terrainMix(st) {
  const n = st.profile.length, stepKm = st.stepM / 1000;
  let fClimb = 0, fSteep = 0, fDesc = 0, fFlat = 0;
  for (let i = 0; i < n; i++) {
    const g = gradientAt(st, i * stepKm);
    if (g > 7) { fSteep++; fClimb++; }
    else if (g > 3) fClimb++;
    else if (g < -3) fDesc++;
    else fFlat++;
  }
  fClimb /= n; fSteep /= n; fDesc /= n; fFlat /= n;

  let cob = 0, grv = 0;
  for (const s of st.sectors) { (s.surface === "gravel" ? (grv += s.lengthM) : (cob += s.lengthM)); }
  cob = clamp(cob / (st.distanceKm * 1000) * 320, 0, 100);
  grv = clamp(grv / (st.distanceKm * 1000) * 320, 0, 100);

  const finUp = ["uphill", "summit"].includes(st.finishKind);
  const finFlat = ["flat", "sprint"].includes(st.finishKind);
  const finishGrad = gradientAt(st, st.distanceKm - 0.5);

  const climb = clamp(fClimb * 130 + fSteep * 60 + (st.maxAltM / 28), 0, 100);
  return {
    flat: clamp(fFlat * 95, 0, 100),
    sprint: finFlat ? clamp(60 + fFlat * 40, 0, 100) : clamp(fFlat * 45, 0, 100),
    climb: st.finishKind === "itt" ? climb * 0.4 : climb,
    punch: clamp((finUp && st.maxAltM < 900 ? 55 : 0) + Math.max(0, finishGrad) * 6, 0, 100),
    cobbles: cob,
    gravel: grv,
    tt: st.finishKind === "itt" ? 100 : 0,
    descent: clamp(fDesc * 130, 0, 100),
  };
}

// ---------------------------------------------------------------------------
//  Library loading + lookup
// ---------------------------------------------------------------------------
export function loadStageLibrary(records, useCurve = false) {
  const stages = records.map((r) => stageFromLibrary(r, useCurve));
  const byId = new Map(stages.map((s) => [s.id, s]));
  return { stages, byId };
}

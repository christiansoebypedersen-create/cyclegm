// ============================================================================
//  GM ENGINE  —  the management layer on top of the race engine.
//  Pure functions over a serializable `state` object (JSON-safe -> IndexedDB).
//  Career loop: race the calendar -> standings/money -> off-season (contracts,
//  transfers, training/aging, retirements, youth intake) -> next season.
// ============================================================================
import { buildField, makeRng, simulate, derivePhysicals, fmtTime, expressPower, stageClimbWeight, syncShadows, ABIL_KEYS, abilFor } from "./engine.mjs";
import { initPersonality, formMultiplier, applyRaceOutcome, seasonPersonalityTick,
         devMoraleFactor, retireMoraleFactor, weeklyTick } from "./personalities.mjs";
import { stageFromSummary, stageFromLibrary, loadStageLibrary, terrainMix } from "./stages.mjs";
import { CALENDAR_STAGES, RACE_STAGE_MAP } from "./stagedata.mjs";

// rider nationalities — drives scouting regions (weighted toward cycling nations)
const NATIONS = ["BEL", "FRA", "ITA", "ESP", "NED", "DEN", "NOR", "GER", "SLO", "COL",
                 "GBR", "AUS", "USA", "SUI", "POR", "POL", "ECU", "KAZ", "AUT", "IRL"];

// macro-regions for scouting — each groups several cycling nations, laid out roughly geographically on the map
const REGIONS = [
  { key: "isles",     name: "British Isles",  nats: ["GBR", "IRL"],               col: 0, row: 0 },
  { key: "nordic",    name: "Scandinavia",    nats: ["DEN", "NOR"],               col: 2, row: 0 },
  { key: "lowc",      name: "Low Countries",  nats: ["BEL", "NED"],               col: 1, row: 1 },
  { key: "central",   name: "Central Europe", nats: ["GER", "AUT", "POL", "SLO"], col: 2, row: 1 },
  { key: "france",    name: "France",         nats: ["FRA"],                      col: 1, row: 2 },
  { key: "italyalps", name: "Italy & Alps",   nats: ["ITA", "SUI"],               col: 2, row: 2 },
  { key: "iberia",    name: "Iberia",         nats: ["ESP", "POR"],               col: 1, row: 3 },
  { key: "andes",     name: "The Andes",      nats: ["COL", "ECU"],               col: 0, row: 3 },
  { key: "world",     name: "Worldwide",      nats: ["USA", "AUS", "KAZ"],        col: 0, row: 2 },
];
const NATION_REGION = {}; for (const reg of REGIONS) for (const n of reg.nats) NATION_REGION[n] = reg.key;
export function scoutRegions() { return REGIONS.map((r) => ({ key: r.key, name: r.name, nats: r.nats.slice(), col: r.col, row: r.row })); }
export function regionOfNation(nat) { return NATION_REGION[nat] || "world"; }
export function knowLabel(k) { return k >= 85 ? "Exceptional" : k >= 65 ? "Strong" : k >= 45 ? "Good" : k >= 28 ? "Basic" : k >= 10 ? "Awkward" : "None"; }

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

// deterministic, serializable randomness: a salt counter reseeds per draw
function rngNext(state) { state.rng.n = (state.rng.n + 1) >>> 0; return makeRng((state.rng.seed ^ Math.imul(state.rng.n, 2654435761)) >>> 0); }
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const gaussish = (rng) => (rng() + rng() + rng() - 1.5) * 1.4; // ~N(0,1)

// ---- single-number overall (for value, salary, AI, sponsor star power) ------
// rated by a rider's BEST discipline blended with raw engine, so anyone who can
// actually win a race carries an overall that reflects it.
export function overallOf(r) {
  const norm = (x, lo, hi) => clamp((x - lo) / (hi - lo) * 100, 1, 99);
  const climb = norm(r.cp / r.weight, 4.3, 6.9);
  const flat = norm(r.cp, 330, 442);
  const engine = 0.5 * flat + 0.5 * climb;
  const spr = r.sprint, pun = r.punch, thr = r.threshold;
  const gcS = 0.60 * climb + 0.25 * thr + 0.15 * pun;
  const sprintS = 0.55 * spr + 0.25 * pun + 0.20 * flat;
  const punchS = 0.42 * pun + 0.24 * thr + 0.20 * climb + 0.14 * spr;
  const roulS = 0.40 * thr + 0.30 * flat + 0.16 * climb + 0.14 * pun;
  const best = Math.max(gcS, sprintS, punchS, roulS);
  return Math.round(clamp(Math.max(0.66 * best + 0.34 * engine, r._ovrFloor || 0), 1, 99));
}
// how good a rider is FOR a given finish type (AI squad picks + leader choice)
export function fitFor(r, finishType) {
  const wkg = r.cp / r.weight;
  const climb = clamp((wkg - 4.3) / 2.6 * 100, 1, 99);
  const flat = clamp((r.cp - 330) / 100 * 100, 1, 99);
  switch (finishType) {
    case "flat":         return 0.7 * r.sprint + 0.3 * r.punch;
    case "hilly":        return 0.5 * r.punch + 0.3 * climb + 0.2 * r.sprint;
    case "uphill_short": return 0.5 * r.punch + 0.4 * climb + 0.1 * r.sprint;
    case "summit":       return 0.85 * climb + 0.15 * r.threshold;
    case "tt":           return 0.6 * flat + 0.4 * r.threshold;
    default:             return overallOf(r);
  }
}

// market value (€M/yr) from overall + age curve; salary ~ value at signing
// market value (€M) — steep at the top so stars cost a fortune and the field is cheap:
// 60≈0.07 · 70≈0.6 · 80≈2.7 · 84≈4.3 · 88≈6.8 · 92≈10 · 96≈14 · 99≈18 (capped 20)
export function valueOf(r) {
  const ovr = overallOf(r);
  let base = Math.pow(Math.max(ovr - 44, 1) / 53, 4.5) * 15.6;
  const ageF = r.age <= 27 ? 1 + (27 - r.age) * 0.03 * (r.potential - ovr > 6 ? 1.6 : 0.6)
                           : 1 - clamp((r.age - 29) * 0.07, 0, 0.6);
  return round2(clamp(base * ageF, 0.05, 20));
}
// annual salary is a fraction of market value — what a rider actually costs per year
const SALARY_FACTOR = 0.55;
export function salaryOf(r) { return round2(clamp((r.value ?? valueOf(r)) * SALARY_FACTOR, 0.03, 13)); }

// ============================================================================
//  STAGE LIBRARY  — finish types drive both the race engine and AI tactics
// ============================================================================
const SEG = {
  flat:         [[0,150,0],[150,178,0]],
  hilly:        [[0,40,0.01],[40,70,0.035],[70,90,-0.03],[90,130,0.015],[130,150,0.05],[150,170,-0.04],[170,196,0.0]],
  uphill_short: [[0,110,0.005],[110,140,0.03],[140,150,-0.03],[150,158,0.02],[158,162,-0.01],[162,165,0.06]],
  summit:       [[0,60,0.005],[60,85,0.06],[85,110,-0.04],[110,140,0.01],[140,150,0.04],[150,172,0.082]],
  rolling:      [[0,60,0.012],[60,80,0.03],[80,110,-0.02],[110,150,0.015],[150,175,-0.01],[175,190,0.0]],
  itt:          [[0,12,0],[12,18,0.01],[18,24,-0.005],[24,34,0]],
  itt_mtn:      [[0,4,0.01],[4,18,0.07],[18,22,0.02],[22,28,0.085]],
  cobbles:      [[0,90,0],[90,110,0.005],[110,150,0],[150,175,0.008],[175,188,0]],
  crosswind:    [[0,120,0],[120,150,0.004],[150,180,0]],
  gravel:       [[0,50,0.005],[50,75,0.02],[75,95,-0.015],[95,130,0.012],[130,150,0.03],[150,184,0.0]],
};
const LEN = { flat: 178, hilly: 196, uphill_short: 165, summit: 172, rolling: 190, itt: 34, itt_mtn: 28, cobbles: 188, crosswind: 180, gravel: 184 };
const STAGE_ATTR = {
  itt:       { finishType: "tt",   mode: "itt" },
  itt_mtn:   { finishType: "tt",   mode: "itt" },
  cobbles:   { finishType: "flat", cobbles: 0.85, wind: 0.3 },
  crosswind: { finishType: "flat", wind: 0.6 },
  gravel:    { finishType: "hilly", cobbles: 0.5 },
};
function makeStage(type, name, lenJitter = 0, attrs = {}) {
  const baseLen = LEN[type];
  const minLen = type === "itt" || type === "itt_mtn" ? 12 : 40;   // TTs are short by design — the 40km floor made every mountain TT a monster
  const len = Math.max(minLen, baseLen + lenJitter);
  const f = len / baseLen;
  const segs = SEG[type].map(([a, b, s]) => [round1(a * f), round1(b * f), s]);
  segs[0][0] = 0; segs[segs.length - 1][1] = len; // exact endpoints, monotone
  const meta = STAGE_ATTR[type] || {};
  const st = { name, lengthKm: len, finishType: meta.finishType || type, segments: segs, srcType: type };
  if (meta.mode) st.mode = meta.mode;
  if (meta.cobbles) st.cobbles = meta.cobbles;
  if (type === "gravel") st.gravel = 0.7;
  if (meta.wind) st.wind = meta.wind;
  const full = { ...st, ...attrs };
  attachStage(full);
  return full;
}

// Build the canonical Stage (the course model the engine + sim query) and hang it
// on the stage object as `_stage`. Procedural stages derive climb/altitude from
// their own segments, so they differ by their actual terrain; real .cds library
// stages can be attached directly via attachStage(st, libRec).
const FK_FROM_FINISH = { flat: "flat", hilly: "hilly", uphill_short: "uphill", summit: "summit", mountain: "mountain", rolling: "hilly", tt: "itt" };
function attachStage(st, libRec) {
  if (libRec) { st._stage = stageFromLibrary(libRec); st.cobbles = st.cobbles ?? sectorIntensity(st._stage, "cobble"); st.gravel = st.gravel ?? sectorIntensity(st._stage, "gravel"); return st; }
  let climbM = 0, maxAlt = 0, cur = 0;
  if (st.segments && st.segments.length) {
    for (const [a, b, s] of st.segments) { const d = (b - a) * 1000; cur += s * d; if (s > 0) climbM += s * d; if (cur > maxAlt) maxAlt = cur; if (cur < 0) cur = 0; }
  } else {
    climbM = { flat: 600, hilly: 1800, uphill_short: 1500, summit: 3200, mountain: 3800, rolling: 1400, tt: 300 }[st.finishType] || 1000;
    maxAlt = { summit: 1600, mountain: 1800 }[st.finishType] || 300;
  }
  const finishKind = st.cobbles ? "cobbled" : st.gravel ? "gravel" : (FK_FROM_FINISH[st.finishType] || "flat");
  st._stage = stageFromSummary({ id: st.name, name: st.name, distanceKm: st.lengthKm, finishKind,
    climbM: Math.round(climbM), maxAltM: Math.round(maxAlt) });
  return st;
}
function sectorIntensity(cs, surface) {
  let km = 0; for (const s of cs.sectors) if (s.surface === surface) km += (s.lengthM / 1000) * (0.7 + 0.1 * (s.stars || 1));
  return Math.min(0.92, km / 40);   // ~30 km of pavé (full Roubaix) ≈ 0.75
}

// Turn a real library record into an engine stage object (used to overlay the
// calendar with real courses). The canonical Stage drives climb weight; segments
// are derived from its profile so in-sim gradient follows the real shape.
const FT_FROM_FK = { flat: "flat", sprint: "flat", hilly: "hilly", uphill: "uphill_short", summit: "summit", mountain: "mountain", cobbled: "flat", gravel: "hilly", itt: "tt" };
function profileToSegments(cs) {
  const a = cs.profile, step = cs.stepM / 1000, n = a ? a.length : 0;
  if (n < 3) return [[0, cs.distanceKm, 0.01]];
  // segments follow terrain TREND RUNS (climb / flat / descent), not fixed windows —
  // fixed windows averaged a climb against its descent and erased the mountains.
  const g3 = (i) => { const k0 = Math.max(0, i - 1), k1 = Math.min(n - 1, i + 2); return (a[k1] - a[k0]) / ((k1 - k0) * cs.stepM); };
  const cls = (g) => (g >= 0.035 ? 2 : g <= -0.025 ? 0 : 1);
  const segs = [];
  let i0 = 0, cur = cls(g3(0));
  const push = (iEnd) => {
    const km0 = i0 * step, km1 = iEnd * step, run = (km1 - km0) * 1000;
    if (run < 200) return;
    segs.push([round1(km0), round1(km1), +((a[iEnd] - a[i0]) / run).toFixed(3)]);
  };
  for (let i = 1; i < n - 1; i++) {
    const c = cls(g3(i));
    if (c !== cur) { push(i); i0 = i; cur = c; }
  }
  push(n - 1);
  if (!segs.length) return [[0, cs.distanceKm, 0.01]];
  segs[0][0] = 0; segs[segs.length - 1][1] = cs.distanceKm;
  for (let i = 1; i < segs.length; i++) segs[i][0] = segs[i - 1][1];   // contiguous
  return segs;
}
function libStageObject(rec, name, floor) {
  const cs = stageFromLibrary(rec);
  let ft = FT_FROM_FK[cs.finishKind] || "hilly";
  // if the road RISES into the line, it is a summit finish whatever the record says
  // (global-max checks fail when a mid-race pass is higher than the finish climb)
  if (ft === "mountain" && Array.isArray(cs.profile) && cs.profile.length > 10) {
    const a2 = cs.profile, n2 = a2.length, stepM2 = cs.stepM || 250;
    const back = Math.min(8, n2 - 1);                       // final ~2 km
    const finGrad = (a2[n2 - 1] - a2[n2 - 1 - back]) / (back * stepM2);
    if (finGrad >= 0.03) ft = "summit";
  }
  const st = { name: name || cs.name, lengthKm: Math.round(cs.distanceKm), finishType: ft, srcType: "real", _stage: cs, segments: profileToSegments(cs) };
  if (ft === "tt") st.mode = "itt";
  let cob = sectorIntensity(cs, "cobble"), grv = sectorIntensity(cs, "gravel");
  if (floor) { cob = Math.max(cob, floor.cobbles || 0); grv = Math.max(grv, floor.gravel || 0); }  // keep a known cobbled/gravel race's identity when sector extraction is thin
  if (cob > 0.05) st.cobbles = cob;
  if (grv > 0.05) st.gravel = grv;
  return st;
}
// Replace a calendar race's stages with real courses where we have them.
function overlayRealCourses(cal) {
  for (const race of cal) {
    const map = RACE_STAGE_MAP[race.name];
    if (!map) continue;
    const files = Array.isArray(map) ? map : [map];
    const recs = files.map((f) => CALENDAR_STAGES[f]).filter(Boolean);
    if (recs.length !== files.length) continue;
    if (race.kind === "tour" && recs.length === race.stages.length) {
      race.stages = recs.map((rec, k) => libStageObject(rec, `${race.name} · St.${k + 1}`));
    } else if (race.kind === "oneday" && recs.length === 1) {
      const prev = race.stages[0] || {};
      race.stages = [libStageObject(recs[0], race.name, { cobbles: prev.cobbles, gravel: prev.gravel })];
    }
  }
}

// ============================================================================
//  POINTS & PRIZE TABLES  (UCI-ish, simplified)
// ============================================================================
const ONEDAY_PTS = [200, 150, 120, 100, 85, 70, 60, 50, 45, 40, 36, 32, 28, 24, 20, 16, 12, 8, 6, 4];
const STAGE_PTS  = [50, 35, 25, 20, 16, 13, 11, 9, 7, 6, 5, 4, 3, 2, 1];
const GC_PTS     = [300, 220, 170, 140, 120, 100, 86, 74, 64, 56, 48, 42, 36, 30, 26, 22, 18, 14, 10, 6];
// classification scoring: points (green) at finishes, mountains (KOM) on climbs, weighted by stage type
const PTS_FINISH = [25, 22, 19, 17, 15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
// per categorized climb KOM points (top cresters) + intermediate sprint points
const KOM_CAT_PTS = { HC: [20, 15, 12, 10, 8, 6, 4, 2], "1": [10, 8, 6, 4, 2, 1], "2": [5, 3, 2, 1], "3": [2, 1], "4": [1] };
const INTERMED_PTS = [20, 17, 15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
// categorize a stage's ascending segments into Cat4→HC (segments are stretched to stage length, so thresholds are tuned to that)
function deriveClimbs(stage) {
  if (!stage || stage.mode === "itt" || !Array.isArray(stage.segments)) return [];
  const out = [];
  for (const [a, b, s] of stage.segments) {
    if (s > 0.029) {
      const score = (b - a) * (s * 100);
      const cat = score >= 170 ? "HC" : score >= 110 ? "1" : score >= 60 ? "2" : score >= 30 ? "3" : score >= 14 ? "4" : null;
      if (cat) out.push({ cat, score: Math.round(score), endKm: b, lengthKm: round1(b - a), grad: round1(s * 100) });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 5);
}
// who crests first: pure climbers on the big passes, breakaway riders on smaller ones
function climbCresterScore(r, cat) {
  if (!r || !r.abil) return 40;
  const climb = clamp((r.cp / r.weight - 4.3) / 2.6 * 100, 1, 99), heavy = cat === "HC" || cat === "1";
  return (heavy ? climb * 0.85 : climb * 0.5) + (r.abil.attacking || 50) * (heavy ? 0.2 : 0.45);
}
function stageClassWeights(st) {
  if (st.mode === "itt") return [0.25, 0];                  // time trial: minor points, no KOM
  const ft = st.finishType;
  if (ft === "summit") return [0.30, 1.0];                  // mountain: full KOM, few sprint points
  if (ft === "uphill_short") return [0.6, 0.55];            // punch
  if (ft === "hilly") return [0.65, 0.6];                   // hilly / breakaway: KOM on offer
  return [1.0, 0.1];                                        // flat / crosswind / cobbles: sprint points
}
const PRIZE_SHARE = [0.25, 0.14, 0.10, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.015, 0.012, 0.01, 0.008, 0.006, 0.005];
const prizeFor = (place, prestige) => round2((PRIZE_SHARE[place - 1] || 0) * (prestige / 55));

// ============================================================================
//  LEAGUE CREATION
// ============================================================================
const TEAM_NAMES = ["Anduril","Vermarc","Soudal Ridge","Visma Lease","UAE Falcon","Ineos Albion","Bahrain Vict",
  "Decathlon AG","Lidl-Trek N","Bora Helio","EF Cannon","Movistar Tel","Astana Qaz","Cofidis FR","Jayco Alula",
  "DSM Firmen","Arkea Bizk","Q36 Pro"];

// ---- tier pyramid ----
const TIERS = ["WorldTour", "ProTeam", "Continental"];
const TIER_CFG = {
  WorldTour:   { count: 18, drop: 0,  presBase: 40, budget: (p) => round2(p * 0.30 + 3) },
  ProTeam:     { count: 18, drop: 11, presBase: 28, budget: (p) => round2(p * 0.20 + 2) },
  Continental: { count: 24, drop: 21, presBase: 16, budget: (p) => round2(p * 0.12 + 1) },
};
const SWAP_N = 3; // promoted/relegated between adjacent tiers each year
const NAME_A = ["Soudal","Quick","Jumbo","Bora","Lotto","Cofidis","Movistar","Astana","Bahrain","Israel","Arkea","Groupama",
  "Intermarche","Alpecin","Bingoal","Uno-X","Caja","Burgos","Euskaltel","Kern","Tudor","Flanders","Nippo","Vini","Androni",
  "Total","Wanty","Roompot","Coop","Trinity","Equipe","Sport","Drone","Eolo","Black","Saint","Polti","Corratec","Bardiani","Tirol"];
const NAME_B = ["Energy","Pharma","Cycling","Pro","Racing","Sport","Devo","Factor","Velo","Bikes","Mobility","Logistics",
  "Insurance","Bank","Telecom","Motors","Steel","Lions","Wolves","Falcons","Coast","Valley","Summit","Vortex","Dynamics",
  "Systems","Capital","Union","Collective","Continental","Performance","Project","Cement","Ostsee"];
function hslHex(h, s, l) {
  s /= 100; l /= 100; const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1))); return Math.round(255 * c).toString(16).padStart(2, "0"); };
  return "#" + f(0) + f(8) + f(4);
}
function genTeamName(rng, used) {
  for (let tries = 0; tries < 60; tries++) {
    const n = (NAME_A[Math.floor(rng() * NAME_A.length)] + " " + NAME_B[Math.floor(rng() * NAME_B.length)]).slice(0, 15);
    if (!used.has(n)) { used.add(n); return n; }
  }
  let i = 2; while (used.has("Team " + i)) i++; used.add("Team " + i); return "Team " + i;
}

// ---- rider names: a large pool + a league-wide used-set so no two riders ever share a name ----
const GIVEN = ["Tobias","Lars","Mikkel","Anders","Kasper","Rasmus","Emil","Frederik","Magnus","Jonas","Soren","Niels","Henrik","Jakob","Oliver","Victor","Sander","Kristian","Erik","Bjorn","Sindre","Markus","Andreas","Sven","Even","Halvard","Thijs","Bram","Daan","Sjoerd","Bas","Jelle","Wessel","Stijn","Koen","Ruben","Maarten","Tiesj","Niki","Florian","Maxime","Romain","Julien","Antoine","Thibault","Clement","Quentin","Bastien","Valentin","Hugo","Lucas","Nicolas","Benoit","Guillaume","Mathis","Enzo","Loic","Axel","Lorenzo","Matteo","Alessandro","Francesco","Giulio","Davide","Marco","Andrea","Luca","Filippo","Simone","Diego","Cristian","Pietro","Stefano","Riccardo","Alberto","Javier","Pablo","Mikel","Iker","Jon","Unai","Carlos","Pau","Alex","Joan","Roger","Aleix","Ander","Joao","Rui","Nelson","Tiago","Andre","Miguel","Bruno","Esteban","Daniel","Santiago","Brandon","Harold","Ivan","Fabio","Wilson","Juan","Sebastian","Camilo","Tom","Ben","Oscar","Joshua","Connor","Harry","Charlie","Fred","George","Sam","Ethan","Leo","Callum","Harrison","Reuben","Jacob","Felix","Lennard","Nils","Maximilian","Georg","Jannik","Pascal","Phil","Marcel","Patrick","Stefan","Lukas","Moritz","Kilian","Mauro","Reto","Silvan","Gino","Fabian","Jan","Michal","Rafal","Kamil","Tomasz","Bartosz","Maciej","Lukasz","Matej","Luka","Domen","Nik","Gregor","Ziga","Tilen","Brody","Lachlan","Caleb","Jayden","Riley","Cooper","Lincoln","Nathan","Quinn","Logan","Declan","Kai","Mason","Hunter","Tyler","Cole","Zane","Beau","Flynn","Aaron","Dylan","Liam","Noah","Sebastiaan","Casper","Mathias","Sondre","Ole","Arne","Lasse","Eivind"];
const SURN = ["Hagen","Foss","Aas","Berg","Dahl","Lie","Moen","Nystrom","Halvorsen","Ruud","Eide","Stokke","Vik","Aune","Bech","Norby","Lund","Holm","Bjerg","Kjaer","Toft","Riis","Krag","Munk","Ovesen","Dalgaard","Skov","Brink","Sundby","Tangen","Strand","Iversen","Solberg","Hovland","Vermeulen","Maes","Claes","Wouters","Peeters","Jacobs","Willems","Mertens","Goossens","Verbruggen","Coninx","Aerts","Segers","Bakker","Visser","Smit","Meijer","Mulder","Vos","Hendriks","Dijkstra","Brouwer","Kuiper","Vink","Tolhoek","Coenen","Verhoeven","Bogaert","Maris","Lemmens","Sterckx","Roosen","Lefevre","Moreau","Lambert","Rousseau","Girard","Bonnet","Fontaine","Lacroix","Marchand","Renaud","Charpentier","Lemoine","Chevalier","Gauthier","Perret","Faure","Mercier","Roussel","Brunet","Leclerc","Maillard","Pichon","Royer","Bernard","Aubert","Coste","Granger","Masson","Noel","Tissot","Vasseur","Lamy","Boucher","Rossi","Conti","Greco","Marino","Gallo","Costa","Fontana","Caruso","Ferrara","Rizzo","Lombardi","Moretti","Barbieri","Mariani","Rinaldi","Sartori","Vitali","Riva","Fabbri","Gentile","Longo","Serra","Villa","Donati","Mazza","Bellini","Parisi","Marchetti","Orlando","Testa","Sanna","Ricci","Farina","Negri","Pagani","Garcia","Fernandez","Lopez","Sanchez","Romero","Torres","Ortega","Castillo","Soler","Iglesias","Reyes","Navarro","Gallego","Herrera","Cabrera","Mendez","Vargas","Pereira","Sousa","Carvalho","Oliveira","Ferreira","Almeida","Lima","Fonseca","Tavares","Antunes","Coelho","Branco","Pinto","Matos","Nogueira","Esteves","Domingues","Quintero","Gutierrez","Restrepo","Cardenas","Munoz","Acevedo","Osorio","Rojas","Castaneda","Sierra","Velasco","Pardo","Cortes","Salazar","Mejia","Arango","Duarte","Patino","Naranjo","Ospina","Smith","Jones","Taylor","Walker","Carter","Hughes","Wright","Hill","Cooper","Turner","Cook","Bell","Ward","Morgan","Price","Bennett","Watson","Gray","Hunt","Marsh","Ellis","Shaw","Holt","Dean","Webb","Knight","Frost","Sharpe","Doyle","Brennan","Kelly","Hartley","Fletcher","Bauer","Wagner","Becker","Hoffmann","Schmid","Fischer","Weber","Meyer","Lang","Vogel","Frei","Brunner","Gerber","Keller","Widmer","Steiner","Graf","Roth","Berger","Moser","Hofer","Gruber","Wallner","Reiter","Egger","Huber","Mayer","Ebner","Kern","Sauer","Kowalski","Wojcik","Kaminski","Zielinski","Wozniak","Mazur","Krawczyk","Novak","Kovac","Zupan","Hribar","Kos","Mlinar","Golob","Bizjak","Jarc","Pavlin","Zajc","Oblak","Cerar","Miller","Davis","Brooks","Reed","Murphy","Sullivan","Bishop","Hayes","Lawson","Hammond","Whitfield","Stratton","Maddox","McKenzie","Donnelly","Boyd","Cross","Mercer","Bridges","Sutton","Hudson","Pearce","Rhodes","Vance"];
function assignUniqueName(state, r) {
  if (!state.usedNames) { state.usedNames = {}; for (const id in state.riders) { const n = state.riders[id]?.name; if (n) state.usedNames[n] = 1; } }
  const rng = makeRng((state.rng.seed ^ ((r.id + 1) * 2246822519) ^ 0x5bd1e995) >>> 0);
  let first, last, full, tries = 0;
  do { first = GIVEN[Math.floor(rng() * GIVEN.length)]; last = SURN[Math.floor(rng() * SURN.length)]; full = first + " " + last; tries++; }
  while (state.usedNames[full] && tries < 60);
  if (state.usedNames[full]) { for (let g = 0; g < 26 * 4; g++) { full = `${first} ${String.fromCharCode(65 + (g % 26))}. ${last}`; if (!state.usedNames[full]) break; } } // exhausted: insert a middle initial
  state.usedNames[full] = 1;
  r.name = full;
  r.short = first.charAt(0) + ". " + last;
  return r;
}

function augmentRider(state, r, ageOverride) {
  const rng = rngNext(state);
  const ovr = overallOf(r);
  r.age = ageOverride != null ? ageOverride : clamp(Math.round(24 + gaussish(rng) * 4.2), 19, 37);
  if (!r.nation) r.nation = NATIONS[Math.floor(rng() * NATIONS.length)];
  r.overall = ovr;
  initPersonality(rngNext(state), r);
  // peak age varies a lot: early bloomers ~23, diesels who keep improving to ~32
  r.peak = clamp(Math.round(26.5 + gaussish(rng) * 2.3), 23, 32);
  // hidden work rate: how reliably training converts to growth (nudged by pro + ambition)
  r.growthRate = clamp(0.72 + gaussish(rng) * 0.2 + (r.prof - 60) / 220 + (r.amb - 50) / 320, 0.5, 1.45);
  // shown potential = an optimistic projection above current ability for the young
  const youthBump = r.age < 24 ? (24 - r.age) * (3 + Math.abs(gaussish(rng)) * 4) : Math.abs(gaussish(rng)) * 3;
  r.potential = clamp(Math.round(ovr + youthBump), ovr, 96);
  // TRUE ceiling (hidden) — riders over/under-shoot their label, more so when young
  const spread = clamp((r.peak - r.age) * 1.1 + 3, 3, 13);
  r.ceiling = clamp(Math.round(r.potential + gaussish(rng) * spread * 0.55), ovr, 99);
  r.lastGrowth = 0; r.program = r.program || "balanced";
  if (r.baseWeight == null) r.baseWeight = r.weight;   // natural racing weight — the floor for body-comp work
  if (r.altYears == null) r.altYears = 0;
  if (!r.palmares) r.palmares = [];
  if (r.prominence == null) r.prominence = clamp(Math.round((r.overall - 52) * 1.1 + (r.career?.wins || 0) * 2.5), 0, 100);
  if (!r.career) r.career = { wins: 0, podiums: 0, top10: 0, points: 0, seasons: 0 };
  if (!r.status) r.status = defaultStatus(r);
  r.value = valueOf(r);
  r.salary = salaryOf(r);
  r.contractYears = clamp(1 + Math.floor(rng() * 4), 1, 4);
  r.scouted = true;
  return r;
}

// build a single young prospect (academy or free-agent), with wide variable upside.
// opts.quality (~0.3–1.1) lifts ceiling/potential & gem odds; opts.nation biases origin; opts.know overrides initial knowledge
function makeProspect(state, teamId, jersey, opts = {}) {
  const rng = rngNext(state);
  const q = opts.quality ?? 0.5;
  const pool = buildField(makeRng((state.rng.seed ^ (state.nextRiderId * 2654435761 + 12345)) >>> 0), 1, 16);
  const r = pool.riders[Math.floor(rng() * pool.riders.length)]; // varied name per prospect
  const nid = state.nextRiderId++;
  r.id = nid; r.teamId = teamId; r.jersey = jersey || "#9b9b9b";
  if (opts.nation) r.nation = opts.nation;
  augmentRider(state, r, 15 + Math.floor(rng() * 7)); // 15–21
  const cut = 8 + Math.floor(rng() * 12);             // depress current ability, widen upside
  if (r.abil) for (const k of ABIL_KEYS) r.abil[k] = clamp(r.abil[k] - cut, 1, 90);
  syncShadows(r);
  derivePhysicals(r); r.overall = overallOf(r);
  const qBump = Math.round((q - 0.5) * 18);           // better academies/years → higher upside
  r.potential = clamp(r.overall + 8 + qBump + Math.floor(Math.abs(gaussish(rng)) * 16), r.overall + 3, 97);
  const spread = clamp((r.peak - r.age) * 1.2 + 4, 4, 14);
  r.ceiling = clamp(Math.round(r.potential + gaussish(rng) * spread * 0.6), r.overall, 99);
  if (rng() < 0.04 + q * 0.06) {                      // gem odds rise with academy quality
    r.ceiling = clamp(Math.max(r.ceiling, Math.round(85 + Math.abs(gaussish(rng)) * 9)), r.overall, 99);
    r._gem = true;
  }
  // hidden work-rate, bust risk & late-bloom — same model the DB import uses, so the
  // generated world also produces busts, late bloomers and the occasional academy star.
  rollDevTraits(rng, r, clamp((r.ceiling - 60) / 8 + 2.5, 2.5, 6));
  if (r._gem) { r._bust = false; r.growthRate = Math.max(r.growthRate, 1.15); } // gems aren't busts
  r.dev = true; r.program = "balanced"; r.scouted = false; r.lastGrowth = 0; r.status = "prospect";
  r.confidence = clamp(Math.round(52 + gaussish(rng) * 8), 35, 72);   // young riders arrive unsure of themselves
  r.know = opts.know != null ? opts.know : clamp(Math.round(6 + Math.abs(gaussish(rng)) * 10), 2, 26);
  r.value = valueOf(r); r.salary = round2(0.06 + rng() * 0.1); r.contractYears = clamp(2 + Math.floor(rng() * 2), 2, 3);
  r.prominence = clamp(Math.round(5 + Math.abs(gaussish(rng)) * 11 + (r.potential - r.overall) * 0.5), 1, 52); // a few are already hotly tipped
  r.palmares = [];
  assignUniqueName(state, r);
  state.riders[nid] = r;
  return r;
}
function seedAcademy(state, team, n) {
  for (let i = 0; i < n; i++) team.devIds.push(makeProspect(state, team.id, team.jersey).id);
}

// ---- scouting staff + knowledge ----
function makeScout(state) {
  const rng = rngNext(state);
  const pool = buildField(makeRng((state.rng.seed ^ (state.nextScoutId * 40503 + 7)) >>> 0), 1, 8);
  const name = pool.riders[Math.floor(rng() * 8)].name;
  const homeNat = NATIONS[Math.floor(rng() * NATIONS.length)];
  const regionFam = {};
  regionFam[NATION_REGION[homeNat]] = clamp(Math.round(35 + Math.abs(gaussish(rng)) * 22), 20, 80); // already a specialist in their home patch
  return { id: state.nextScoutId++, name,
    jpa: clamp(Math.round(46 + gaussish(rng) * 16), 20, 95),   // judging current ability
    jpp: clamp(Math.round(46 + gaussish(rng) * 16), 20, 95),   // judging potential
    region: homeNat, regionFam,
    salary: round2(0.12 + rng() * 0.32), assign: null };
}
// ---- coaching staff — named specialists who bias what/how fast prospects develop ----
const COACH_SPECS = [
  { key: "climbing", label: "Climbing coach", arch: ["climber", "gc"] },
  { key: "sprint", label: "Sprint coach", arch: ["sprinter", "leadout"] },
  { key: "tt", label: "Time-trial coach", arch: ["rouleur", "gc"] },
  { key: "classics", label: "Classics coach", arch: ["puncheur", "rouleur"] },
  { key: "mentality", label: "Mentality coach", arch: null },   // steadies confidence, not power
  { key: "youth", label: "Head of youth", arch: null },         // lifts every prospect
];
export const COACH_CAP = 3;
export function makeCoach(state) {
  const rng = rngNext(state);
  state.nextCoachId = state.nextCoachId || 1;
  const pool = buildField(makeRng((state.rng.seed ^ (state.nextCoachId * 27644 + 13)) >>> 0), 1, 8);
  const name = pool.riders[Math.floor(rng() * 8)].name;
  const spec = COACH_SPECS[Math.floor(rng() * COACH_SPECS.length)];
  const rating = clamp(Math.round(50 + gaussish(rng) * 16), 32, 93);   // higher = stronger development effect
  const id = state.nextCoachId++;
  return { id, name, spec: spec.key, label: spec.label, arch: spec.arch, rating, salary: round2(0.1 + rating * 0.006 + rng() * 0.08) };
}
export function coachMarket(state) { return state.coachMarket || []; }
export function userCoaches(state) { return state.teams[state.userTeamId].coaches || []; }
export function hireCoach(state, team, id) {
  team.coaches = team.coaches || [];
  if (team.coaches.length >= COACH_CAP) return { ok: false, reason: `Staff is full (${COACH_CAP}).` };
  const i = (state.coachMarket || []).findIndex((c) => c.id === id); if (i < 0) return { ok: false, reason: "Coach unavailable." };
  const c = state.coachMarket[i];
  team.coaches.push(c); state.coachMarket.splice(i, 1);
  state.coachMarket.push(makeCoach(state));   // a new face joins the market
  return { ok: true, coach: c };
}
export function fireCoach(state, team, id) { team.coaches = (team.coaches || []).filter((c) => c.id !== id); return { ok: true }; }
// facility tier from the academy rating — names the investment level and scales dev speed
export function academyTier(yr) { yr = yr ?? 45;
  return yr >= 85 ? { lvl: 5, name: "World-Class Academy" } : yr >= 70 ? { lvl: 4, name: "Elite Academy" }
    : yr >= 55 ? { lvl: 3, name: "National Programme" } : yr >= 42 ? { lvl: 2, name: "Regional Academy" } : { lvl: 1, name: "Local Setup" }; }
// backfill fields added after a save was created (coaches, youth calendar, rider confidence) so old saves keep working
export function migrateState(state) {
  if (!state || !state.teams) return state;
  if (state.nextCoachId == null) state.nextCoachId = 1;
  if (!state.coachMarket) state.coachMarket = Array.from({ length: 5 }, () => makeCoach(state));
  for (const t of state.teams) {
    if (!t.coaches) t.coaches = t.id === state.userTeamId ? [makeCoach(state)] : [];
    if (!t.youthCalendar) t.youthCalendar = YOUTH_RACES.map((r) => r[0]);
  }
  for (const id in state.riders) { const r = state.riders[id]; if (r.confidence == null) r.confidence = clamp(Math.round((r.morale ?? 62) * 0.55 + 28 + (r.age <= 22 ? -5 : r.age >= 33 ? 4 : 0)), 35, 82); }
  if (!state.expectations) state.expectations = [];
  if (state.newsReadHigh == null) state.newsReadHigh = (state.news || []).length;   // old saves: treat existing news as already read
  return state;
}

// ---- development paths — a committed identity that shapes what a rider becomes ----
export const DEV_PATHS = [
  { key: "climber", label: "Climber", focus: "climb", fit: ["climber", "gc"] },
  { key: "gc", label: "GC contender", focus: "threshold", fit: ["gc", "climber", "rouleur"] },
  { key: "sprinter", label: "Sprinter", focus: "sprint", fit: ["sprinter", "leadout"] },
  { key: "classics", label: "Classics / puncheur", focus: "vo2", fit: ["puncheur", "rouleur"] },
  { key: "tt", label: "Time-trial specialist", focus: "tt", fit: ["rouleur", "gc"] },
  { key: "rouleur", label: "Rouleur / all-rounder", focus: "flat", fit: ["rouleur", "domestique", "puncheur"] },
];
// how well a path suits a rider's natural talent — on-grain develops faster, against-grain slower
export function pathFitOf(rider, pathKey) { const p = DEV_PATHS.find((x) => x.key === pathKey); if (!p) return 1; return p.fit.includes(rider.archetype) ? 1.12 : 0.86; }
export function setDevPath(state, rider, pathKey) {
  const p = DEV_PATHS.find((x) => x.key === pathKey); if (!p) return { ok: false, reason: "Unknown path." };
  const switching = rider.devPath && rider.devPath !== pathKey && (rider._pathSeasons || 0) >= 1;   // re-tooling an established rider costs a season
  rider.devPath = pathKey; rider._pathSeasons = 0;
  state.trainingFocus = state.trainingFocus || {}; state.trainingFocus[rider.id] = p.focus;
  if (switching) { rider.confidence = clamp((rider.confidence ?? 60) - 8, 0, 100); rider._devDrag = (rider._devDrag || 0) + 2;
    state.news.push({ season: state.season, date: 0, kind: "morale", text: `${rider.short} is being re-tooled as a ${p.label.toLowerCase()} — expect a season of adjustment.` }); }
  const fit = pathFitOf(rider, pathKey);
  return { ok: true, path: p, fit, switching, poor: fit < 1 };
}
// is a prospect ready for the pro ranks? too-early promotion rattles them; too-late wastes their prime
export function promotionReadiness(rider) {
  const oScore = clamp((rider.overall - 58) / 14, 0, 1);
  const cScore = clamp((rider.confidence ?? 60) / 85, 0, 1);
  const ageScore = rider.age >= 20 ? 1 : rider.age >= 18 ? 0.6 : 0.3;
  const score = clamp(0.5 * oScore + 0.25 * cScore + 0.25 * ageScore, 0, 1);
  const ready = rider.overall >= 64 && (rider.confidence ?? 60) >= 45 && rider.age >= 19;
  const label = score >= 0.8 ? "Ready now" : score >= 0.58 ? "Nearly ready" : score >= 0.35 ? "Needs time" : "Raw — too soon";
  return { score, ready, label };
}
// ---- prospect expectations — proactive promises the manager makes, judged at season's end ----
export const EXPECTATION_TYPES = [
  { key: "breakthrough", label: "Promise a breakthrough season", blurb: "They must visibly step up (a real jump in ability)." },
  { key: "promotion", label: "Promise promotion to the pros", blurb: "They must be on the pro roster by season's end." },
];
export function setExpectation(state, rider, type) {
  if (!EXPECTATION_TYPES.find((e) => e.key === type)) return { ok: false, reason: "Unknown expectation." };
  state.expectations = (state.expectations || []).filter((e) => e.riderLid !== rider.id);   // one live promise per rider
  state.expectations.push({ type, riderLid: rider.id, season: state.season, short: rider.short });
  rider._expectation = type;
  rider.confidence = clamp((rider.confidence ?? 60) + 4, 0, 100);   // being backed lifts them now — but the clock is ticking
  return { ok: true };
}
export function clearExpectation(state, rider) { state.expectations = (state.expectations || []).filter((e) => e.riderLid !== rider.id); delete rider._expectation; }
// judged at the end of the off-season (after development + promotions); + late-promotion agitation for over-ripe prospects
function prospectOffSeason(state) {
  for (const e of (state.expectations || [])) {
    const r = state.riders[e.riderLid]; if (!r) continue;
    let kept;
    if (e.type === "breakthrough") kept = (r.lastGrowth || 0) >= 3 || r._breakout;
    else if (e.type === "promotion") kept = !r.dev;
    else kept = true;
    if (kept) { r.confidence = clamp((r.confidence ?? 60) + 10, 0, 100); r.loyal = clamp((r.loyal ?? 55) + 8, 1, 99); r.morale = clamp((r.morale ?? 65) + 6, 1, 99);
      state.news.push({ season: state.season, date: 99, kind: "breakthrough", text: `You delivered on your promise to ${r.short} — belief and loyalty soar.` }); }
    else { r.confidence = clamp((r.confidence ?? 60) - 12, 0, 100); r.morale = clamp((r.morale ?? 65) - 10, 1, 99); r.loyal = clamp((r.loyal ?? 55) - 10, 1, 99);
      state.news.push({ season: state.season, date: 99, kind: "morale", text: `You broke your promise to ${r.short} — the trust is damaged.` }); }
    delete r._expectation;
  }
  state.expectations = [];
  // over-ripe talent left in the academy agitates: ready, 22+, still a prospect → morale/loyalty erode, they push for a move up or out
  const ut = state.teams[state.userTeamId];
  for (const id of (ut?.devIds || [])) { const r = state.riders[id]; if (!r) continue;
    if (r.age >= 22 && promotionReadiness(r).ready) {
      r.morale = clamp((r.morale ?? 65) - 7, 1, 99); r.loyal = clamp((r.loyal ?? 55) - 6, 1, 99); r.confidence = clamp((r.confidence ?? 60) - 3, 0, 100);
      state.news.push({ season: state.season, date: 99, kind: "morale", text: `${r.short} is ready and frustrated — they want a promotion to the pro ranks, or they'll look elsewhere.` });
    } }
}
function initKnowledge(state) {
  const ut = state.userTeamId;
  for (const id in state.riders) {
    const r = state.riders[id];
    if (r.teamId === ut) r.know = r.dev ? 78 : 100;                 // you know your own riders
    else if (r.teamId != null) r.know = r.dev
      ? clamp(Math.round(6 + Math.abs(gaussish(rngNext(state))) * 8), 2, 22)            // rival youth: obscure
      : clamp(Math.round((r.overall - 42) * 1.4 + gaussish(rngNext(state)) * 6), 6, 72); // rival pros: visible by results
    else r.know = clamp(Math.round(8 + Math.abs(gaussish(rngNext(state))) * 10), 3, 28);
  }
}
// progresses once per race: assigned scouts accrue knowledge of their targets
function _knownPotStar(r) { const k = Math.max(r.know ?? 0, r._regionKnow ?? 0); if (k < 14) return 0; const kp = knownPotential(r); return kp.unknown ? 0 : starOf(kp.mid); }
function _scoutReveal(state, r) {
  if (r.teamId === state.userTeamId || r.age > 23) return;
  const ns = _knownPotStar(r);
  const milestone = ns >= 4.5 ? 4.5 : ns >= 4 ? 4 : ns >= 3.5 ? 3.5 : 0;
  if (!milestone || milestone <= (r._revealed || 0)) return;
  r._revealed = milestone;
  const starTxt = milestone === 4.5 ? "★★★★½" : milestone === 4 ? "★★★★" : "★★★½";
  const where = r.teamId == null ? "unattached" : (state.teams[r.teamId]?.name || "");
  const lead = milestone >= 4.5 ? "Scouting breakthrough" : "Scout report";
  state.news.push({ season: state.season, date: 0, kind: "scout", text: `${lead}: ${r.name} (${r.age}, ${r.nation}${where ? ", " + where : ""}) grades as a ${starTxt} prospect.` });
}
// passive world-knowledge floor: every rider in a region is partly known just from how well you know that region
function applyRegionKnowledge(state) {
  const rk = state.regionKnow || {};
  for (const id in state.riders) {
    const r = state.riders[id];
    if (r.teamId === state.userTeamId) { r._regionKnow = 0; continue; }
    r._regionKnow = Math.round((rk[regionOfNation(r.nation)] || 0) * 0.8);  // maxed region ≈ 80% known on everyone there
  }
}
function scoutMonthlyMail(state) {
  const ut = state.teams[state.userTeamId];
  const assigned = (ut.scouts || []).filter((s) => s.assign && s.assign.type === "region");
  const cands = Object.values(state.riders)
    .filter((r) => r.teamId !== state.userTeamId && r.age <= 23 && Math.max(r.know ?? 0, r._regionKnow ?? 0) >= 30)
    .map((r) => ({ r, star: _knownPotStar(r), kp: knownPotential(r) }))
    .filter((x) => x.star >= 3.5)
    .sort((a, b) => b.star - a.star || (b.kp.mid || 0) - (a.kp.mid || 0));
  const starTxt = (s) => "★".repeat(Math.floor(s)) + (s % 1 ? "½" : "");
  const lines = [];
  for (const c of cands.slice(0, 3)) { const reg = REGIONS.find((x) => x.key === NATION_REGION[c.r.nation]); lines.push(`${starTxt(c.star)} ${c.r.short} · ${c.r.age}y · ${reg ? reg.name : c.r.nation} — ${c.r.teamId == null ? "available to sign" : "at " + (state.teams[c.r.teamId]?.name || "a rival")}`); }
  // region progress — only mention a region whose knowledge label has moved since the last report
  state._scoutSeenLabels = state._scoutSeenLabels || {};
  let labelChanged = false;
  for (const s of assigned) { const rk = s.assign.region; const k = Math.round(state.regionKnow[rk] || 0); const lab = knowLabel(k); if (lab !== state._scoutSeenLabels[rk]) { state._scoutSeenLabels[rk] = lab; labelChanged = true; const reg = REGIONS.find((x) => x.key === rk); lines.push(`${s.name}: knowledge of ${reg ? reg.name : rk} now ${lab} (${k}%)`); } }
  if (!cands.length && !labelChanged) return;          // nothing new worth an email
  const rec = cands[0]?.r;
  const text = rec ? `Your scouts filed their monthly report. Top recommendation: ${rec.name} (${rec.age}).` : `Your scouts filed their monthly report.`;
  const options = rec
    ? [{ label: `Shortlist ${rec.short}`, fx: { shortlist: true }, reply: `${rec.short} added to your shortlist.` }, { label: "Dismiss", fx: {} }]
    : [{ label: "Note it", fx: {} }];
  state.inbox = (state.inbox || []).filter((e) => e.kind !== "scouting");   // latest report supersedes the previous one
  state.inbox.push({ id: state.nextEventId++, season: state.season, riderLid: rec ? rec.id : null, riderShort: rec ? rec.short : "Scouting dept.", kind: "scouting", text, lines, options });
}
function tickScouting(state) {
  const ut = state.userTeamId;
  const scouts = (state.teams[ut] && state.teams[ut].scouts) || [];
  state.regionKnow = state.regionKnow || {};
  const touched = new Set();
  for (const sc of scouts) {
    const a = sc.assign; if (!a) continue;
    sc.regionFam = sc.regionFam || {};
    if (a.type === "rider") {
      const r = state.riders[a.lid]; if (!r) { sc.assign = null; continue; }
      r.know = clamp((r.know ?? 0) + (12 + sc.jpa * 0.18), 0, 100); touched.add(r.id); // deep focus on one rider = fast
    } else if (a.type === "region") {
      const rk = a.region; if (!REGIONS.find((x) => x.key === rk)) { sc.assign = null; continue; }
      const fam = sc.regionFam[rk] || 0;
      sc.regionFam[rk] = clamp(fam + 1.1, 0, 100);                                   // the longer here, the better they know it
      const cur = state.regionKnow[rk] || 0;
      const eff = (1.3 + sc.jpp * 0.025) * (0.55 + 0.45 * fam / 100);                // familiar, skilled scouts learn the patch faster
      state.regionKnow[rk] = clamp(cur + eff * (1 - cur / 100) * 1.15 + 0.15, 0, 100);
      const pool = Object.values(state.riders).filter((r) => regionOfNation(r.nation) === rk && r.teamId !== ut);
      const upside = (r) => (r.ceiling || r.overall) * 0.55 + r.overall * 0.3 + (r.prominence || 0) * 0.15 - ((r.know ?? 0) >= 85 ? 40 : 0) - (r.age > 23 ? 25 : 0);
      pool.sort((x, y) => upside(y) - upside(x));                                    // actively dig out the best young talent in the region
      const rate = 2 + sc.jpp * 0.05 + fam * 0.02;
      for (const r of pool.slice(0, 6)) { r.know = clamp((r.know ?? 0) + rate, 0, 100); touched.add(r.id); }
    }
  }
  // your scouting network passively sharpens the read on your OWN academy prospects — locked stats clear over time, faster with better scouts
  const utTeam = state.teams[ut];
  if (utTeam) { const netPow = (utTeam.scouts || []).reduce((s, sc) => s + sc.jpp, 0);
    for (const id of (utTeam.devIds || [])) { const r = state.riders[id]; if (r && (r.know ?? 0) < 100) { r.know = clamp((r.know ?? 0) + 1.5 + netPow * 0.02, 0, 100); touched.add(r.id); } } }
  applyRegionKnowledge(state);
  for (const id of touched) { const r = state.riders[id]; if (r) _scoutReveal(state, r); }
  state._scoutTick = (state._scoutTick || 0) + 1;
  if (state._scoutTick % 4 === 0) scoutMonthlyMail(state);   // a digest roughly once a month
}

// ============================================================================
//  SPONSORS & ECONOMY — the team's main revenue, with asks, bonuses & a market
// ============================================================================
const DEMONYM = { FRA: "French", BEL: "Belgian", ITA: "Italian", ESP: "Spanish", NED: "Dutch", GBR: "British", GER: "German", DEN: "Danish", NOR: "Norwegian", SLO: "Slovenian", COL: "Colombian", AUS: "Australian", USA: "American", SUI: "Swiss", POR: "Portuguese", POL: "Polish", AUT: "Austrian", KAZ: "Kazakh", ECU: "Ecuadorian", IRL: "Irish" };
const SPONSOR_NAMES = ["Cervélo", "Oakley", "Shimano", "Red Bull", "Santini", "Wahoo", "Enve", "Castelli", "Polti", "Factor", "Pinarello", "Continental", "Maap", "Rapha", "Elf", "TotalEnergies", "Trek", "Specialized", "Wilier", "Cofidis", "Arkéa", "Lotto", "Tudor", "Q36.5", "Bora", "Visma", "Soudal"];
const SLOT_DEFS = [
  { tier: "title", share: 0.55, diff: 0.95, label: "Title sponsor" },
  { tier: "co", share: 0.18, diff: 0.62, label: "Co-sponsor" },
  { tier: "co", share: 0.15, diff: 0.45, label: "Co-sponsor" },
  { tier: "equipment", share: 0.12, diff: 0.3, label: "Equipment" },
];
// total annual sponsor income a team of this prestige can attract (€M) — steep so the big teams are rich
function sponsorPool(prestige) { return round2(Math.pow(clamp(prestige, 15, 99) / 90, 2) * 54 + 2); }
const ordn = (n) => n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th");
// how many seasons a sponsor tolerates a missed ask before walking away.
// big-money title backers are the most demanding; co/equipment are more patient.
function sponsorPatience(sp) { const sc = sp?.scale; const base = sc === "mega" ? 1 : sc === "large" ? 2 : sc === "mid" ? 2 : 3; return sp?.tier === "title" ? base : base + 1; }

// map a dataset primary_ask_type to one of our evaluable categories
function askCat(s) {
  s = (s || "").toLowerCase();
  if (s.includes("roster")) return "roster";
  if (s.includes("key-race") || s.includes("key race")) return "keyrace";
  if (s.includes("season")) return "season";
  if (s.includes("star")) return "star";
  if (s.includes("equipment") || s.includes("innovation") || s.includes("product")) return "star";
  return "season"; // market activation / conduct / sustainability → a performance clause
}
// generate one evaluable ask, harder as diff → 1; biased by the company's ask type and
// carrying the company's own ask wording (`text`) for flavour.
function makeAsk(rng, state, team, diff, company) {
  // key races must come from the team's OWN tier — an ask a team can never race is a guaranteed walkout
  const userTier = state.teams[state.userTeamId]?.tier;
  const cal = team.tier === userTier ? (state.calendar || []) : (state.worldCal || []).filter((c) => c.tier === team.tier);
  const roster = (team.riderIds || []).map((id) => state.riders[id]).filter(Boolean);
  const roll = rng();
  const cat = company ? askCat(company.ask) : (roll < 0.22 ? "roster" : roll < 0.42 ? "keyrace" : roll < 0.64 ? "season" : roll < 0.83 ? "star" : "youngstar");
  let ask, flav;
  if (cat === "roster") {
    if (rng() < 0.6) { const nat = (DEMONYM[team.country] && team.country) || roster[0]?.nation || "FRA"; ask = { type: "nationality", nat, pct: diff >= 0.8 ? 55 : diff >= 0.5 ? 45 : 35 }; }
    else ask = { type: "youngstar", ovr: diff >= 0.6 ? 78 : 74 };
    flav = company?.roster;
  } else if (cat === "keyrace") {
    const mon = cal.filter((c) => c.cat === "Monument"), gts = cal.filter((c) => c.cat === "GT");
    if (diff >= 0.8 && mon.length) ask = { type: "keyrace", race: pick(rng, mon).name, need: "win" };
    else if (diff >= 0.55 && gts.length) ask = { type: "gtstage" };
    else { const pool = cal.filter((c) => c.prestige >= 48); ask = pool.length ? { type: "keyrace", race: pick(rng, pool).name, need: diff >= 0.62 ? "win" : "podium" } : { type: "wins", target: 2 }; }
    flav = company?.key;
  } else if (cat === "season") {
    if (rng() < 0.5) ask = { type: "wins", target: diff >= 0.8 ? 6 : diff >= 0.5 ? 3 : 1 };
    else { const n = state.teams.filter((x) => x.tier === team.tier).length || 18; ask = { type: "rankTop", target: diff >= 0.8 ? Math.max(2, Math.round(n * 0.15)) : diff >= 0.5 ? Math.max(5, Math.round(n * 0.35)) : Math.round(n * 0.6), tier: team.tier }; }
    flav = company?.season;
  } else if (cat === "youngstar") {
    ask = { type: "youngstar", ovr: diff >= 0.6 ? 78 : 74 }; flav = company?.roster || company?.star;
  } else {
    ask = { type: "star", ovr: diff >= 0.8 ? 86 : diff >= 0.5 ? 82 : 78 }; flav = company?.star;
  }
  if (flav) ask.text = flav;
  return ask;
}
export function labelAsk(a) {
  if (!a) return "No performance clause";
  switch (a.type) {
    case "nationality": return `${a.pct}% of the squad ${DEMONYM[a.nat] || a.nat}`;
    case "keyrace": return `${a.need === "win" ? "Win" : "Podium at"} ${a.race}`;
    case "gtstage": return "Win a Grand Tour stage";
    case "wins": return `${a.target}+ race win${a.target > 1 ? "s" : ""}`;
    case "rankTop": return `Finish top ${a.target} in the ${a.tier || "division"}`;
    case "points": return `${a.target}+ ranking points`;
    case "star": return `Field an ${a.ovr}+ OVR rider`;
    case "youngstar": return `An ${a.ovr}+ OVR rider aged 23 or under`;
    default: return "Compete well";
  }
}
// evaluate an ask against the current season → { met, text }
export function evalAsk(state, team, a) {
  if (!a) return { met: true, text: "—" };
  const roster = (team.riderIds || []).map((id) => state.riders[id]).filter(Boolean);
  const n = roster.length || 1;
  switch (a.type) {
    case "nationality": { const c = roster.filter((r) => r.nation === a.nat).length; const pct = Math.round((c / n) * 100); return { met: pct >= a.pct, text: `${pct}% (${c}/${n})` }; }
    case "star": { const b = Math.max(0, ...roster.map((r) => r.overall || 0)); return { met: b >= a.ovr, text: `best ${b}` }; }
    case "youngstar": { const ys = roster.filter((r) => r.age <= 23).map((r) => r.overall || 0); const b = ys.length ? Math.max(...ys) : 0; return { met: b >= a.ovr, text: `best U23 ${b}` }; }
    case "wins": { const w = seasonWins(state, team.id); return { met: w >= a.target, text: `${w}/${a.target}` }; }
    case "rankTop": { const ranks = tierStandings(state, a.tier || team.tier); const pos = (ranks.findIndex((x) => x.id === team.id) + 1) || ranks.length; return { met: pos > 0 && pos <= a.target, text: `${ordn(pos)}` }; }
    case "points": { const p = Math.round((state.rankings.team || {})[team.id] || 0); return { met: p >= a.target, text: `${p}/${a.target}` }; }
    case "keyrace": { const rec = Object.values(state.results || {}).find((x) => x.name === a.race); if (!rec) return { met: false, text: "not yet raced" };
      if (a.need === "win") { const won = state.riders[rec.winnerLid]?.teamId === team.id; return { met: won, text: won ? "won ✓" : "missed" }; }
      const top3 = rec.gc ? rec.gc.slice(0, 3).map((g) => g.lid) : (rec.stageResults?.[0]?.top || []).slice(0, 3).map((x) => x.lid);   // one-days podium from the finish order
      const pod = state.riders[rec.winnerLid]?.teamId === team.id || top3.some((lid) => state.riders[lid]?.teamId === team.id); return { met: pod, text: pod ? "podium ✓" : "missed" }; }
    case "gtstage": { for (const x of Object.values(state.results || {})) { if (!x.grand) continue; for (const st of x.stageResults || []) if (state.riders[st.winnerLid]?.teamId === team.id) return { met: true, text: "stage won ✓" }; } return { met: false, text: "none yet" }; }
    default: return { met: false, text: "—" };
  }
}
// which company scales fit a team of this tier as title vs co/equipment sponsor
function titleScales(tier) { return tier === "WorldTour" ? ["mega", "large"] : tier === "ProTeam" ? ["large", "mid"] : ["mid", "small"]; }
function coScales(tier) { return tier === "WorldTour" ? ["large", "mid"] : tier === "ProTeam" ? ["mid", "small"] : ["small", "micro"]; }
// the 600-company sponsor dataset lives as a module global (not on state) so it
// never bloats saves; the app sets it once on load.
let _sponsorDB = null;
export function setSponsorDB(d) { _sponsorDB = d ? (d.sponsors || d) : null; }
function sponsorList() { return Array.isArray(_sponsorDB) && _sponsorDB.length ? _sponsorDB : null; }
function pickCompany(state, scales, used) {
  const db = sponsorList(); if (!db) return null;
  const pool = db.filter((c) => scales.includes(c.scale) && !used.has(c.n));
  return pool.length ? pick(rngNext(state), pool) : null;
}
// value drawn from the company's OWN title or co band (title ≫ co), scaled by team prestige
function bandValue(company, isTitle, prestige) {
  const lo = isTitle ? company.tMin : company.cMin, hi = isTitle ? company.tMax : company.cMax, mid = isTitle ? company.tMid : company.cMid;
  const pf = clamp(((prestige || 50) - 25) / 60, 0.12, 1);
  const v = (lo != null && hi != null) ? lo + (hi - lo) * pf : (mid != null ? mid : (isTitle ? 8 : 2));
  return round2(clamp(v, isTitle ? 0.3 : 0.08, 60));
}
function sponsorFromCompany(state, team, slot, company) {
  const rng = rngNext(state); const isTitle = slot.tier === "title";
  const value = bandValue(company, isTitle, team.prestige);
  const sp = { id: state.nextSponsorId++, name: company.n, tier: slot.tier, value, years: 1 + Math.floor(rng() * 3),
    ask: makeAsk(rng, state, team, slot.diff, company), bonus: round2(value * (0.25 + slot.diff * 0.4)),
    happy: true, scale: company.scale, ind: company.ind, brief: isTitle ? company.goal : company.cgoal };
  sp.patience = sponsorPatience(sp); return sp;
}
// fallback when no sponsor dataset is loaded (old saves / offline)
function makeSponsorFallback(state, team, slot, name) {
  const rng = rngNext(state);
  const base = sponsorPool(team.prestige || 50) * slot.share;
  const value = round2(clamp(base * (0.9 + rng() * 0.2), 0.15, 60));
  const sp = { id: state.nextSponsorId++, name: name || pick(rng, SPONSOR_NAMES), tier: slot.tier, value,
    years: 1 + Math.floor(rng() * 3), ask: makeAsk(rng, state, team, slot.diff), bonus: round2(value * (0.25 + slot.diff * 0.4)), happy: true };
  sp.patience = sponsorPatience(sp); return sp;
}
// team name follows the title (and lead co) sponsor — real-cycling style
function teamNameFromSponsors(team) {
  const sp = team.sponsors || [];
  const title = sp.find((s) => s.tier === "title" && !s.vacant);
  if (!title) { const co = sp.find((s) => s.tier === "co" && !s.vacant); return co ? `${co.name} Pro Cycling` : team.name; }
  const co = sp.find((s) => s.tier === "co" && !s.vacant && s.name !== title.name);
  return co ? `${title.name}–${co.name}` : `${title.name} Pro Cycling`;
}
export function applyTeamIdentity(state, team) {
  const nm = teamNameFromSponsors(team);
  if (nm && nm !== team.name) { team.name = nm; const t = (team.sponsors || []).find((s) => s.tier === "title"); if (t) team.shortName = t.name; }
  return team.name;
}
function makeSponsors(state, team, realNames = []) {
  state.nextSponsorId = state.nextSponsorId || 1;
  const used = new Set();
  return SLOT_DEFS.map((slot, i) => {
    const scales = slot.tier === "title" ? titleScales(team.tier) : coScales(team.tier);
    const co = pickCompany(state, scales, used);
    let sp;
    if (co) { used.add(co.n); sp = sponsorFromCompany(state, team, slot, co); }
    else sp = makeSponsorFallback(state, team, slot, realNames[i]);
    // keep a recognisable real sponsor name on the lead slots for imported teams
    if (realNames[i] && !used.has(realNames[i])) { sp.name = realNames[i]; used.add(realNames[i]); }
    return sp;
  });
}
// upgrade legacy sponsor objects ({expects}) to the new model so old saves don't break
export function normalizeSponsors(state, team) {
  if (!team || !Array.isArray(team.sponsors)) return false;
  if (team.sponsors.every((sp) => sp && sp.ask)) return false;
  state.nextSponsorId = state.nextSponsorId || 1;
  team.sponsors = team.sponsors.map((sp, i) => {
    if (sp && sp.ask) return sp;
    const slot = SLOT_DEFS[Math.min(i, SLOT_DEFS.length - 1)];
    const ask = sp?.expects ? (sp.expects.type === "rankTop" ? { type: "rankTop", target: sp.expects.target, tier: team.tier } : sp.expects.type === "wins" ? { type: "wins", target: sp.expects.target } : { type: "star", ovr: sp.expects.target }) : makeAsk(rngNext(state), state, team, slot.diff);
    return { id: state.nextSponsorId++, name: sp?.name || "Sponsor", tier: slot.tier, value: sp?.value ?? 2, years: sp?.years ?? 2, ask, bonus: round2((sp?.value ?? 2) * 0.3), happy: sp?.happy !== false };
  });
  return true;
}

// ============================================================================
//  REAL PELOTON — the 18 UCI WorldTeams (2026) with their marquee riders.
//  Squad depth and the academy stay generated; lower tiers stay fictional.
//  star 0–3 scales a rider's signature abilities; nation is a 3-letter code
//  (unknown codes fall back to the "world" scouting region — harmless).
// ============================================================================
const REAL_TEAMS = [
  { name: "UAE Team Emirates-XRG", jersey: "#0b0b16", prestige: 95, riders: [
    { n: "Tadej Pogačar", nat: "SLO", age: 27, arch: "gc", star: 3 }, { n: "João Almeida", nat: "POR", age: 27, arch: "gc", star: 2 },
    { n: "Isaac del Toro", nat: "MEX", age: 22, arch: "puncheur", star: 2 }, { n: "Jhonatan Narváez", nat: "ECU", age: 29, arch: "puncheur", star: 2 },
    { n: "Adam Yates", nat: "GBR", age: 33, arch: "climber", star: 1 }, { n: "Pavel Sivakov", nat: "FRA", age: 28, arch: "climber", star: 1 },
    { n: "Tim Wellens", nat: "BEL", age: 35, arch: "puncheur", star: 1 }, { n: "Nils Politt", nat: "GER", age: 32, arch: "rouleur", star: 1 },
    { n: "Felix Großschartner", nat: "AUT", age: 32, arch: "helper", star: 0 }, { n: "Domen Novak", nat: "SLO", age: 30, arch: "helper", star: 0 } ] },
  { name: "Visma-Lease a Bike", jersey: "#f7e017", prestige: 93, riders: [
    { n: "Jonas Vingegaard", nat: "DEN", age: 29, arch: "gc", star: 3 }, { n: "Wout van Aert", nat: "BEL", age: 31, arch: "rouleur", star: 3 },
    { n: "Matteo Jorgenson", nat: "USA", age: 26, arch: "rouleur", star: 2 }, { n: "Simon Yates", nat: "GBR", age: 33, arch: "climber", star: 2 },
    { n: "Sepp Kuss", nat: "USA", age: 31, arch: "climber", star: 1 }, { n: "Tiesj Benoot", nat: "BEL", age: 32, arch: "rouleur", star: 1 },
    { n: "Christophe Laporte", nat: "FRA", age: 33, arch: "puncheur", star: 1 }, { n: "Edoardo Affini", nat: "ITA", age: 29, arch: "rouleur", star: 1 },
    { n: "Ben Tulett", nat: "GBR", age: 24, arch: "climber", star: 0 }, { n: "Jan Tratnik", nat: "SLO", age: 36, arch: "helper", star: 0 } ] },
  { name: "Red Bull-BORA-hansgrohe", jersey: "#12235c", prestige: 90, riders: [
    { n: "Primož Roglič", nat: "SLO", age: 36, arch: "gc", star: 3 }, { n: "Remco Evenepoel", nat: "BEL", age: 26, arch: "gc", star: 3 },
    { n: "Florian Lipowitz", nat: "GER", age: 25, arch: "gc", star: 2 }, { n: "Maxim Van Gils", nat: "BEL", age: 26, arch: "puncheur", star: 2 },
    { n: "Jordi Meeus", nat: "BEL", age: 27, arch: "sprinter", star: 2 }, { n: "Aleksandr Vlasov", nat: "RUS", age: 30, arch: "gc", star: 1 },
    { n: "Laurence Pithie", nat: "NZL", age: 23, arch: "puncheur", star: 1 }, { n: "Danny van Poppel", nat: "NED", age: 32, arch: "leadout", star: 1 },
    { n: "Bob Jungels", nat: "LUX", age: 33, arch: "rouleur", star: 1 }, { n: "Giovanni Aleotti", nat: "ITA", age: 27, arch: "helper", star: 0 } ] },
  { name: "Lidl-Trek", jersey: "#d11f2d", prestige: 89, riders: [
    { n: "Mads Pedersen", nat: "DEN", age: 30, arch: "puncheur", star: 3 }, { n: "Jonathan Milan", nat: "ITA", age: 25, arch: "sprinter", star: 3 },
    { n: "Juan Ayuso", nat: "ESP", age: 23, arch: "gc", star: 2 }, { n: "Mattias Skjelmose", nat: "DEN", age: 25, arch: "gc", star: 2 },
    { n: "Giulio Ciccone", nat: "ITA", age: 31, arch: "climber", star: 2 }, { n: "Thibau Nys", nat: "BEL", age: 23, arch: "puncheur", star: 2 },
    { n: "Quinn Simmons", nat: "USA", age: 25, arch: "rouleur", star: 1 }, { n: "Mathias Vacek", nat: "CZE", age: 23, arch: "rouleur", star: 1 },
    { n: "Albert Philipsen", nat: "DEN", age: 19, arch: "puncheur", star: 1 }, { n: "Carlos Verona", nat: "ESP", age: 33, arch: "helper", star: 0 } ] },
  { name: "Alpecin-Premier Tech", jersey: "#e2402a", prestige: 86, riders: [
    { n: "Mathieu van der Poel", nat: "NED", age: 31, arch: "puncheur", star: 3 }, { n: "Jasper Philipsen", nat: "BEL", age: 28, arch: "sprinter", star: 3 },
    { n: "Kaden Groves", nat: "AUS", age: 27, arch: "sprinter", star: 2 }, { n: "Axel Laurance", nat: "FRA", age: 24, arch: "puncheur", star: 1 },
    { n: "Søren Kragh Andersen", nat: "DEN", age: 31, arch: "rouleur", star: 1 }, { n: "Jonas Rickaert", nat: "BEL", age: 31, arch: "leadout", star: 0 },
    { n: "Gianni Vermeersch", nat: "BEL", age: 33, arch: "rouleur", star: 0 }, { n: "Silvan Dillier", nat: "SUI", age: 35, arch: "helper", star: 0 } ] },
  { name: "INEOS Grenadiers", jersey: "#d81f2a", prestige: 85, riders: [
    { n: "Filippo Ganna", nat: "ITA", age: 30, arch: "rouleur", star: 3 }, { n: "Carlos Rodríguez", nat: "ESP", age: 25, arch: "gc", star: 2 },
    { n: "Thymen Arensman", nat: "NED", age: 26, arch: "climber", star: 2 }, { n: "Egan Bernal", nat: "COL", age: 29, arch: "gc", star: 1 },
    { n: "Magnus Sheffield", nat: "USA", age: 24, arch: "puncheur", star: 1 }, { n: "Tobias Foss", nat: "NOR", age: 29, arch: "rouleur", star: 1 },
    { n: "Connor Swift", nat: "GBR", age: 30, arch: "helper", star: 0 }, { n: "Laurens De Plus", nat: "BEL", age: 30, arch: "helper", star: 0 } ] },
  { name: "Decathlon CMA CGM", jersey: "#0a2c8c", prestige: 84, riders: [
    { n: "Olav Kooij", nat: "NED", age: 24, arch: "sprinter", star: 3 }, { n: "Felix Gall", nat: "AUT", age: 28, arch: "climber", star: 2 },
    { n: "Aurélien Paret-Peintre", nat: "FRA", age: 29, arch: "climber", star: 1 }, { n: "Paul Lapeira", nat: "FRA", age: 25, arch: "puncheur", star: 1 },
    { n: "Daan Hoole", nat: "NED", age: 27, arch: "rouleur", star: 1 }, { n: "Sam Bennett", nat: "IRL", age: 35, arch: "sprinter", star: 1 },
    { n: "Bastien Tronchon", nat: "FRA", age: 25, arch: "puncheur", star: 0 }, { n: "Bruno Armirail", nat: "FRA", age: 32, arch: "rouleur", star: 0 } ] },
  { name: "Soudal Quick-Step", jersey: "#0a1a40", prestige: 84, riders: [
    { n: "Tim Merlier", nat: "BEL", age: 33, arch: "sprinter", star: 3 }, { n: "Jasper Stuyven", nat: "BEL", age: 34, arch: "rouleur", star: 1 },
    { n: "Ilan Van Wilder", nat: "BEL", age: 26, arch: "gc", star: 1 }, { n: "Mauri Vansevenant", nat: "BEL", age: 27, arch: "puncheur", star: 1 },
    { n: "William Junior Lecerf", nat: "BEL", age: 23, arch: "gc", star: 1 }, { n: "Luke Lamperti", nat: "USA", age: 23, arch: "sprinter", star: 1 },
    { n: "Casper Pedersen", nat: "DEN", age: 30, arch: "helper", star: 0 }, { n: "Pieter Serry", nat: "BEL", age: 37, arch: "helper", star: 0 } ] },
  { name: "Bahrain Victorious", jersey: "#e2231a", prestige: 82, riders: [
    { n: "Antonio Tiberi", nat: "ITA", age: 24, arch: "gc", star: 2 }, { n: "Santiago Buitrago", nat: "COL", age: 26, arch: "climber", star: 2 },
    { n: "Lenny Martinez", nat: "FRA", age: 22, arch: "climber", star: 2 }, { n: "Matej Mohorič", nat: "SLO", age: 31, arch: "puncheur", star: 2 },
    { n: "Phil Bauhaus", nat: "GER", age: 31, arch: "sprinter", star: 2 }, { n: "Jack Haig", nat: "AUS", age: 32, arch: "climber", star: 1 },
    { n: "Fred Wright", nat: "GBR", age: 26, arch: "rouleur", star: 1 }, { n: "Damiano Caruso", nat: "ITA", age: 38, arch: "helper", star: 0 } ] },
  { name: "EF Education-EasyPost", jersey: "#ff0095", prestige: 80, riders: [
    { n: "Richard Carapaz", nat: "ECU", age: 32, arch: "climber", star: 2 }, { n: "Ben Healy", nat: "IRL", age: 25, arch: "puncheur", star: 2 },
    { n: "Kasper Asgreen", nat: "DEN", age: 31, arch: "rouleur", star: 1 }, { n: "Neilson Powless", nat: "USA", age: 29, arch: "puncheur", star: 1 },
    { n: "Marijn van den Berg", nat: "NED", age: 26, arch: "sprinter", star: 1 }, { n: "Alberto Bettiol", nat: "ITA", age: 32, arch: "rouleur", star: 1 },
    { n: "Harry Sweeny", nat: "AUS", age: 27, arch: "rouleur", star: 0 } ] },
  { name: "Groupama-FDJ United", jersey: "#0b5cab", prestige: 80, riders: [
    { n: "David Gaudu", nat: "FRA", age: 29, arch: "climber", star: 2 }, { n: "Romain Grégoire", nat: "FRA", age: 23, arch: "puncheur", star: 2 },
    { n: "Stefan Küng", nat: "SUI", age: 32, arch: "rouleur", star: 2 }, { n: "Paul Penhoët", nat: "FRA", age: 24, arch: "sprinter", star: 1 },
    { n: "Lewis Askey", nat: "GBR", age: 25, arch: "leadout", star: 0 }, { n: "Quentin Pacher", nat: "FRA", age: 34, arch: "helper", star: 0 },
    { n: "Clément Davy", nat: "FRA", age: 28, arch: "helper", star: 0 } ] },
  { name: "Movistar Team", jersey: "#0aa0dc", prestige: 78, riders: [
    { n: "Enric Mas", nat: "ESP", age: 31, arch: "gc", star: 2 }, { n: "Iván Romeo", nat: "ESP", age: 23, arch: "rouleur", star: 2 },
    { n: "Pablo Castrillo", nat: "ESP", age: 25, arch: "climber", star: 1 }, { n: "Einer Rubio", nat: "COL", age: 28, arch: "climber", star: 1 },
    { n: "Javier Romo", nat: "ESP", age: 27, arch: "puncheur", star: 1 }, { n: "Nelson Oliveira", nat: "POR", age: 37, arch: "rouleur", star: 0 },
    { n: "Will Barta", nat: "USA", age: 30, arch: "helper", star: 0 } ] },
  { name: "Team Jayco AlUla", jersey: "#1aa05a", prestige: 78, riders: [
    { n: "Ben O'Connor", nat: "AUS", age: 30, arch: "gc", star: 2 }, { n: "Michael Matthews", nat: "AUS", age: 35, arch: "puncheur", star: 2 },
    { n: "Pascal Ackermann", nat: "GER", age: 32, arch: "sprinter", star: 2 }, { n: "Luke Plapp", nat: "AUS", age: 25, arch: "rouleur", star: 1 },
    { n: "Alessandro Covi", nat: "ITA", age: 27, arch: "climber", star: 1 }, { n: "Mauro Schmid", nat: "SUI", age: 26, arch: "rouleur", star: 1 },
    { n: "Elmar Reinders", nat: "NED", age: 33, arch: "leadout", star: 0 } ] },
  { name: "Lotto Intermarché", jersey: "#e2001a", prestige: 77, riders: [
    { n: "Biniam Girmay", nat: "ERI", age: 26, arch: "sprinter", star: 3 }, { n: "Arnaud De Lie", nat: "BEL", age: 24, arch: "sprinter", star: 2 },
    { n: "Lennert Van Eetvelt", nat: "BEL", age: 25, arch: "climber", star: 2 }, { n: "Georg Zimmermann", nat: "GER", age: 28, arch: "puncheur", star: 1 },
    { n: "Gerben Thijssen", nat: "BEL", age: 28, arch: "sprinter", star: 1 }, { n: "Jenno Berckmoes", nat: "BEL", age: 24, arch: "puncheur", star: 1 },
    { n: "Louis Meintjes", nat: "RSA", age: 34, arch: "climber", star: 0 } ] },
  { name: "NSN Cycling Team", jersey: "#0b3d91", prestige: 74, riders: [
    { n: "Derek Gee", nat: "CAN", age: 28, arch: "gc", star: 2 }, { n: "Stevie Williams", nat: "GBR", age: 29, arch: "puncheur", star: 2 },
    { n: "Matthew Riccitello", nat: "USA", age: 24, arch: "climber", star: 1 }, { n: "Joseph Blackmore", nat: "GBR", age: 23, arch: "climber", star: 1 },
    { n: "Ethan Vernon", nat: "GBR", age: 25, arch: "sprinter", star: 1 }, { n: "Michael Woods", nat: "CAN", age: 39, arch: "climber", star: 0 },
    { n: "Jake Stewart", nat: "GBR", age: 26, arch: "sprinter", star: 0 } ] },
  { name: "Picnic PostNL", jersey: "#e60050", prestige: 73, riders: [
    { n: "Oscar Onley", nat: "GBR", age: 23, arch: "gc", star: 2 }, { n: "Warren Barguil", nat: "FRA", age: 34, arch: "climber", star: 1 },
    { n: "Pavel Bittner", nat: "CZE", age: 23, arch: "sprinter", star: 1 }, { n: "Casper van Uden", nat: "NED", age: 24, arch: "sprinter", star: 1 },
    { n: "Frank van den Broek", nat: "NED", age: 25, arch: "climber", star: 1 }, { n: "Tobias Lund Andresen", nat: "DEN", age: 23, arch: "sprinter", star: 1 } ] },
  { name: "Uno-X Mobility", jersey: "#e3061b", prestige: 73, riders: [
    { n: "Tobias Halland Johannessen", nat: "NOR", age: 26, arch: "climber", star: 2 }, { n: "Magnus Cort", nat: "DEN", age: 33, arch: "puncheur", star: 2 },
    { n: "Søren Wærenskjold", nat: "NOR", age: 26, arch: "rouleur", star: 1 }, { n: "Jonas Abrahamsen", nat: "NOR", age: 30, arch: "puncheur", star: 1 },
    { n: "Andreas Leknessund", nat: "NOR", age: 27, arch: "rouleur", star: 1 }, { n: "Markus Hoelgaard", nat: "NOR", age: 31, arch: "helper", star: 0 } ] },
  { name: "XDS Astana Team", jersey: "#0a9cd8", prestige: 72, riders: [
    { n: "Lorenzo Fortunato", nat: "ITA", age: 30, arch: "climber", star: 1 }, { n: "Diego Ulissi", nat: "ITA", age: 36, arch: "puncheur", star: 1 },
    { n: "Harold Tejada", nat: "COL", age: 29, arch: "climber", star: 1 }, { n: "Sergio Higuita", nat: "COL", age: 28, arch: "puncheur", star: 1 },
    { n: "Cees Bol", nat: "NED", age: 31, arch: "sprinter", star: 1 }, { n: "Yevgeniy Fedorov", nat: "KAZ", age: 25, arch: "rouleur", star: 1 },
    { n: "Wout Poels", nat: "NED", age: 38, arch: "climber", star: 0 }, { n: "Simone Velasco", nat: "ITA", age: 30, arch: "helper", star: 0 } ] },
];
const SIG_ABIL = { gc: ["climbing", "timetrial", "stamina"], climber: ["climbing", "stamina"], sprinter: ["sprint", "flat"],
  leadout: ["flat", "positioning", "sprint"], puncheur: ["punch", "climbing", "positioning"], rouleur: ["flat", "timetrial", "cobbles"], helper: ["stamina", "positioning"] };
function makeRealAbil(arch, star, rng) {
  const a = abilFor(arch, (m, s) => clamp(Math.round(m + gaussish(rng) * s * 0.5), 1, 99));
  const floor = [73, 80, 88, 95][star] ?? 73;
  for (const k of (SIG_ABIL[arch] || ["stamina"])) a[k] = clamp(Math.max(a[k], floor + Math.round(gaussish(rng) * 2)), 1, 99);
  return a;
}
const shortName = (full) => { const p = full.trim().split(/\s+/); return p.length < 2 ? full : `${p[0][0]}. ${p.slice(1).join(" ")}`; };
// overwrite the top WorldTour squads with the real peloton; depth + academy + lower tiers stay generated


function applyRealTeams(state) {
  state.usedNames = state.usedNames || {};
  for (let ti = 0; ti < REAL_TEAMS.length && ti < state.teams.length; ti++) {
    const rt = REAL_TEAMS[ti], team = state.teams[ti];
    team.name = rt.name; team.jersey = rt.jersey; team.prestige = rt.prestige; team._real = true;
    const rids = team.riderIds.slice();
    for (const lid of rids) state.riders[lid].jersey = rt.jersey;
    for (let i = 0; i < rt.riders.length && i < rids.length; i++) {
      const r = state.riders[rids[i]], d = rt.riders[i], rng = rngNext(state);
      r.name = d.n; r.short = shortName(d.n); r._real = true;
      r.nation = d.nat; r.age = d.age; r.archetype = d.arch;
      r.abil = makeRealAbil(d.arch, d.star, rng);
      const floor = [70, 79, 86, 91][d.star] + Math.round(rng() * 2);   // established class — baked into abilities (a live floor freezes development)
      syncShadows(r); derivePhysicals(r);
      r._ovrFloor = floor;
      r.overall = clamp(overallOf(r), 1, 99);
      r.peak = clamp(d.age <= 24 ? 27 : d.age <= 29 ? 28 : 29, 24, 32);
      r.growthRate = d.age < 24 ? 1.1 : d.age > 32 ? 0.7 : 0.92;
      r.potential = clamp(r.overall + (d.age < 23 ? 7 : d.age < 26 ? 3 : 1), r.overall, 97);
      r.ceiling = clamp(r.potential + (d.age < 23 ? 3 : 0), r.overall, 99);
      r.value = valueOf(r); r.salary = round2(0.2 + Math.max(0, r.overall - 60) * 0.06 + d.star * 0.5);
      r.contractYears = 1 + Math.floor(rng() * 3);
      r.morale = 66; r.form = 62; r.confidence = 64; r.transferListed = false; r.out = 0; r.dev = false; r.status = "pro";
      r.know = 100;                                            // you know the real pros (overall is clear; their exact power still fogs until you race them)
      r.prominence = clamp(d.star * 22 + 12 + (r.overall - 70), 1, 100);
      r.palmares = r.palmares || []; r.career = r.career || { wins: 0, podiums: 0, top10: 0, points: 0, seasons: 0 };
      state.usedNames[d.n] = 1;
    }
  }
}

// ============================================================================
//  RIDER/TEAM DATABASE IMPORT (PCM-style OfficialRelease JSON) — ported, mapped to the 13-ability model
// ============================================================================
const DB_STAT_KEYS = ["plain", "mountain", "mediumMountain", "downhilling", "cobble", "timeTrial", "prologue", "sprint", "acceleration", "endurance", "resistance", "recuperation", "hill", "breakaway"];
const DB_TIER_BY_DIV = { 10: "WorldTour", 11: "ProTeam", 12: "Continental" };
const DB_TIER_NEED = { WorldTour: 18, ProTeam: 18, Continental: 24 };
function dbClampRating(x, d = 50) {
  const n = Number(x);
  const v = Number.isFinite(n) ? n : d;
  // OfficialRelease/PCM-style stats are usually around 50..85. Stretch them
  // into CycleGM's wider 1..99 range so elite DB riders are truly elite.
  return clamp(Math.round(42 + (v - 50) * 1.55), 1, 99);   // one continuous line — piecewise version inverted at the 45/90 seams
}
function dbTeamId(t) { return t?.id; }
function dbTeamTier(t) {
  const direct = t?.tier || DB_TIER_BY_DIV[t?.division?.id] || DB_TIER_BY_DIV[t?.divisionId];
  if (direct) return direct;
  const txt = String(t?.divisionCode || t?.division?.code || t?.divisionName || "").toLowerCase();
  if (txt.includes("world") || txt.includes("[1]")) return "WorldTour";
  if (txt.includes("pro") || txt.includes("[2]")) return "ProTeam";
  if (txt.includes("cont") || txt.includes("[3]")) return "Continental";
  return null;
}
function dbTeamName(t) { return t?.n || t?.name || t?.shortName || `Team ${dbTeamId(t) ?? "?"}`; }
function dbTeamShort(t) { return t?.sn || t?.shortName || t?.abbreviation || dbTeamName(t); }
function dbHex(c, fallback = "#666666") { c = (c || "").toString().trim().replace(/^#/, ""); return c.length >= 6 ? `#${c.slice(0, 6)}` : fallback; }
function dbTeamColor(t, fallback) { return dbHex(t?.c1 || t?.colors?.primary || t?.sponsor?.color, fallback); }
function dbCountry(obj) { return obj?.nation || obj?.nat || obj?.country?.code || obj?.country || obj?.nationality?.country?.code || ""; }
function dbRiderTeamId(r) { return r?.tid ?? r?.teamId ?? r?.team?.id ?? null; }
function dbStatObject(r, pot = false) {
  const keys = r?.statKeys || DB_STAT_KEYS;
  const arr = pot ? r?.ps : r?.s;
  if (Array.isArray(arr)) { const o = {}; keys.forEach((k, i) => { o[k] = arr[i]; }); return o; }
  return (pot ? r?.potentialStats : r?.stats) || {};
}
function dbStatScore(r) {
  const st = dbStatObject(r, false);
  const vals = DB_STAT_KEYS.map((k) => Number(st[k])).filter(Number.isFinite);
  if (!vals.length) return 0;
  return Math.max(...vals) * 0.45 + vals.reduce((s, x) => s + x, 0) / vals.length * 0.55;
}
function dbMapAbilities(st) {
  const g = (k, d = 50) => dbClampRating(st?.[k], d);
  return {
    climbing:   dbClampRating(0.70 * g("mountain") + 0.30 * g("mediumMountain")),
    punch:      dbClampRating(0.45 * g("hill") + 0.35 * g("acceleration") + 0.20 * g("mediumMountain")),
    flat:       dbClampRating(0.70 * g("plain") + 0.30 * g("endurance")),
    timetrial:  dbClampRating(0.72 * g("timeTrial") + 0.28 * g("prologue")),
    sprint:     dbClampRating(0.72 * g("sprint") + 0.28 * g("acceleration")),
    cobbles:    g("cobble"),
    stamina:    dbClampRating(0.64 * g("endurance") + 0.36 * g("resistance")),
    recovery:   g("recuperation"),
    positioning:dbClampRating(0.42 * g("plain") + 0.28 * g("cobble") + 0.30 * g("resistance")),
    descending: g("downhilling"),
    attacking:  dbClampRating(0.52 * g("breakaway") + 0.28 * g("acceleration") + 0.20 * g("hill")),
    gravel:     dbClampRating(0.50 * g("cobble") + 0.28 * g("mountain") + 0.22 * g("breakaway")),
    bikehandling: dbClampRating(0.55 * g("downhilling") + 0.30 * g("cobble") + 0.15 * g("acceleration")),
  };
}
function dbArchetypeFromAbilities(a) {
  const s = {
    gc:       0.43 * a.climbing + 0.20 * a.timetrial + 0.24 * a.stamina + 0.13 * a.recovery,
    climber:  0.61 * a.climbing + 0.19 * a.punch + 0.20 * a.stamina,
    sprinter: 0.54 * a.sprint + 0.25 * a.flat + 0.21 * a.positioning,
    puncheur: 0.38 * a.punch + 0.20 * a.climbing + 0.16 * a.cobbles + 0.14 * a.positioning + 0.12 * a.attacking,
    rouleur:  0.35 * a.flat + 0.27 * a.timetrial + 0.23 * a.cobbles + 0.15 * a.stamina,
    leadout:  0.34 * a.flat + 0.28 * a.positioning + 0.25 * a.sprint + 0.13 * a.cobbles,
  };
  // Avoid classifying elite cobbled/punch riders as leadouts just because they
  // are good at positioning. Leadout should mostly be for sprint-train riders.
  if (a.sprint < 82) s.leadout -= 8;
  if (a.cobbles >= 78 && a.punch >= 75) { s.puncheur += 5; s.rouleur += 3; }
  return Object.entries(s).sort((x, y) => y[1] - x[1])[0][0];
}
function dbAge(r, season) {
  if (Number.isFinite(Number(r?.age))) return clamp(Math.round(Number(r.age)), 16, 45);
  const dob = r?.dob || r?.birthDate;
  const y = typeof dob === "string" ? Number(dob.slice(0, 4)) : NaN;
  return Number.isFinite(y) ? clamp((season || 2026) - y, 16, 45) : null;
}
function dbRiderName(r) {
  const full = (r?.n || r?.name || r?.fullName || `${r?.firstName || r?.fn || ""} ${r?.lastName || r?.ln || ""}`).trim() || `Rider ${r?.id ?? ""}`;
  return full;
}
function dbPotentialOverall(baseRider, pstats) {
  const tmp = { ...baseRider, abil: dbMapAbilities(pstats || {}) };
  syncShadows(tmp); derivePhysicals(tmp);
  return overallOf(tmp);
}
function dbPalmares(r) {
  const compact = r?.cy?.p;
  if (Array.isArray(compact)) return compact.map((p) => ({
    s: p[0], place: p[1], race: p[2], kind: p[3] || "oneday", prestige: Math.max(20, Math.round((p[4] || 45) * 0.7)), dbType: p[5] || undefined,
  })).filter((p) => p.race && p.place <= 3).slice(-50);
  const pal = r?.history?.palmares || [];
  return pal.filter((p) => p?.rank <= 3).slice(0, 50).map((p) => {
    const race = p.race || {}, cls = race.class || {}, typ = p.type || {};
    return { s: p.year, place: p.rank, race: race.name || "Race", kind: typ.code === "ETAPE" ? "stage" : (cls.isStageRace ? "tour" : "oneday"), prestige: Math.max(20, Math.round((race.popularity || 45) * 0.7)), dbType: typ.code };
  });
}
function dbCareer(r, palmares) {
  const wins = r?.cy?.w ?? r?.history?.totalVictories ?? palmares.filter((p) => p.place === 1).length;
  const podiums = Math.max(palmares.length, wins);
  return { wins: Math.round(wins || 0), podiums: Math.round(podiums || 0), top10: Math.round(podiums || 0), points: 0, seasons: 0 };
}
function dbSponsorObjects(state, t, team) {
  const names = Array.isArray(t?.sponsors) ? t.sponsors : (t?.sponsors || []).map((x) => x?.sponsor?.name).filter(Boolean);
  return makeSponsors(state, team, names);   // real sponsor names seed the title/co slots; asks generated to the model
}
function dbSelectTeams(db) {
  const teams = Array.isArray(db?.teams) ? db.teams : [];
  const riders = Array.isArray(db?.riders) ? db.riders : [];
  if (!teams.length || !riders.length) return [];
  if (db?.schema === "cyclegm-rider-team-db-v1" && teams.length <= 60) return teams.map((team) => ({ team, tier: dbTeamTier(team) || "Continental" }));
  const byTeam = new Map();
  for (const r of riders) { const tid = dbRiderTeamId(r); if (!byTeam.has(tid)) byTeam.set(tid, []); byTeam.get(tid).push(r); }
  const teamStrength = (t) => {
    const rs = byTeam.get(dbTeamId(t)) || [];
    const top = rs.map(dbStatScore).sort((a, b) => b - a).slice(0, 12);
    return top.length ? top.reduce((s, x) => s + x, 0) / top.length : 0;
  };
  const groups = { WorldTour: [], ProTeam: [], Continental: [] };
  for (const t of teams) { const tier = dbTeamTier(t); if (groups[tier]) groups[tier].push(t); }
  groups.Continental.sort((a, b) => teamStrength(b) - teamStrength(a));
  const out = [];
  const used = new Set();
  const take = (tier, pool, n) => { for (const t of pool) { if (out.filter((x) => x.tier === tier).length >= n) break; if (used.has(dbTeamId(t))) continue; out.push({ team: t, tier }); used.add(dbTeamId(t)); } };
  take("WorldTour", groups.WorldTour, DB_TIER_NEED.WorldTour);
  take("ProTeam", groups.ProTeam, DB_TIER_NEED.ProTeam);
  if (out.filter((x) => x.tier === "ProTeam").length < DB_TIER_NEED.ProTeam) take("ProTeam", groups.Continental, DB_TIER_NEED.ProTeam);
  take("Continental", groups.Continental, DB_TIER_NEED.Continental);
  return out.slice(0, DB_TIER_NEED.WorldTour + DB_TIER_NEED.ProTeam + DB_TIER_NEED.Continental);
}
export function applyRiderTeamDatabase(state, db, opts = {}) {
  if (!db || !Array.isArray(db.teams) || !Array.isArray(db.riders)) return false;
  if (opts.sponsorDB) setSponsorDB(opts.sponsorDB);   // sponsor dataset powers tiered title/co values
  const selected = dbSelectTeams(db);
  if (!selected.length) return false;
  const maxTeams = Math.min(state.teams.length, selected.length);
  const teamMap = new Map();
  state.usedNames = {};
  for (let i = 0; i < state.teams.length; i++) {
    const slot = state.teams[i];
    slot.riderIds = []; slot.devIds = []; slot.prizeYTD = 0;
    if (i >= maxTeams) continue;
    const { team: src, tier } = selected[i];
    teamMap.set(dbTeamId(src), i);
    slot.name = dbTeamName(src); slot.shortName = dbTeamShort(src); slot.abbr = src.ab || src.abbreviation || "";
    slot.jersey = dbTeamColor(src, slot.jersey); slot.secondary = dbHex(src.c2 || src.colors?.secondary, "#888888");
    slot.tier = tier; slot._dbId = dbTeamId(src); slot._db = true; slot.pcmHistory = src.h || src.history || [];
  }
  const pickedTeamIds = new Set([...teamMap.keys()]);
  const teamRows = db.riders.filter((r) => pickedTeamIds.has(dbRiderTeamId(r)));
  const freeRows = db.riders.filter((r) => !pickedTeamIds.has(dbRiderTeamId(r))).sort((a, b) => dbStatScore(b) - dbStatScore(a)).slice(0, opts.freeAgents ?? 300);
  const rows = [...teamRows, ...freeRows];
  state.riders = {}; state.nextRiderId = 0;
  for (const src of rows) {
    const oldTid = dbRiderTeamId(src), teamId = teamMap.has(oldTid) ? teamMap.get(oldTid) : null;
    const team = teamId != null ? state.teams[teamId] : null;
    const stats = dbStatObject(src, false);
    const abil = dbMapAbilities(stats);
    const archetype = dbArchetypeFromAbilities(abil);
    const name = dbRiderName(src);
    const id = state.nextRiderId++;
    const r = { id, _dbId: src.id, _db: true, teamId, jersey: team?.jersey || "#9b9b9b", archetype,
      role: ["gc", "sprinter", "puncheur"].includes(archetype) ? "leader" : "helper",
      weight: clamp(Math.round(Number(src.wgt ?? src.weightKg ?? 70) || 70), 50, 95), height: Math.round(Number(src.hgt ?? src.heightCm ?? 0) || 0),
      birthDate: src.dob || src.birthDate || null, nation: dbCountry(src) || "", abil, name, short: shortName(name),
      _ovrFloor: clamp(Math.round(35 + (dbStatScore(src) - 45) * 1.6), 40, 96),
      dbCurrentAbility: src.ca ?? src.currentAbilityRaw ?? src.currentAbility ?? null, dbPotential: src.pot ?? src.potentialStars ?? src.potential ?? null, dbStats: stats,
    };
    syncShadows(r); derivePhysicals(r); augmentRider(state, r, dbAge(src, state.season));
    r.weatherRes = clamp(Math.round(0.55 * r.abil.cobbles + 0.45 * r.abil.stamina), 1, 99);
    r.consistency = clamp(Math.round(0.5 * r.abil.recovery + 0.3 * r.abil.positioning + 18), 1, 99);
    r.form = 62; r.morale = 66; r.confidence = 62; r.out = 0; r.transferListed = false;
    const drng = rngNext(state);
    // The DB anchors strength via _ovrFloor, but a floor in overallOf() FREEZES growth
    // (ability gains stay below the floor, so overall never moves). Bake the floor into the
    // abilities, then drop it — now overall is computed live and the rider can actually develop.
    // _ovrFloor stays as the established-class anchor (overallOf takes the max) —
    // baking it into abilities pinned a dozen stats at 99 on the top imports.
    // The freeze problem is solved in developAll: the floor DECAYS once past peak.
    r.overall = overallOf(r);
    // potential comes from the DB star rating (the per-stat "potential" stats equal current
    // stats, so they carry no upside) — an aggressive star→ceiling map, tapered by age so the
    // young keep the full headroom. Realising it is gated by hidden work-rate (rollDevTraits).
    const potRaw = Number(src.pot ?? src.potentialStars ?? src.potential ?? 0) || 0;
    const baseCeil = starCeiling(potRaw);
    const ageF = clamp(1 - Math.max(0, r.age - 20) / ((r.peak ?? 27) - 20 + 4), 0.12, 1);
    const head = Math.max(0, baseCeil - r.overall);
    r.ceiling = clamp(Math.round(r.overall + head * ageF + gaussish(drng) * 2), r.overall, 99);
    r.potential = clamp(Math.round(r.overall + (r.ceiling - r.overall) * (r.age < 24 ? 0.55 : 0.4)), r.overall, 98);
    rollDevTraits(drng, r, potRaw);
    r.palmares = dbPalmares(src);
    r.career = dbCareer(src, r.palmares);
    r.prominence = clamp(Math.round((r.overall - 54) * 1.15 + Math.min(35, r.career.wins * 0.9) + r.palmares.filter((p) => p.place === 1).length * 1.2), 0, 100);
    const contractEnd = Array.isArray(src.ct) ? Number(src.ct[0]) : Number(src.contract?.yearEnd);
    r.contractYears = Number.isFinite(contractEnd) && contractEnd > state.season ? clamp(contractEnd - state.season + 1, 1, 5) : r.contractYears;
    r.value = valueOf(r); r.salary = round2(Math.max(0.04, salaryOf(r) * (team ? 1 : 0.75))); r.status = defaultStatus(r); r.know = teamId === state.userTeamId ? 100 : r.know;
    state.riders[id] = r;
    state.usedNames[name] = 1;
    if (team) team.riderIds.push(id);
  }
  for (const team of state.teams) {
    const cfg = TIER_CFG[team.tier] || TIER_CFG.Continental;
    const strength = team.riderIds.map((id) => state.riders[id]?.overall || 45).sort((a, b) => b - a);
    const core = strength.slice(0, 8).reduce((s, x) => s + x, 0) / Math.max(1, Math.min(8, strength.length));
    team.prestige = clamp(Math.round((core - 48) * 1.6 + cfg.presBase + (team.tier === "WorldTour" ? 10 : 0)), 10, 96);
    team.budget = cfg.budget(team.prestige); team.sponsors = dbSponsorObjects(state, selected.find((x) => team._dbId === dbTeamId(x.team))?.team || {}, team);
    team.youthRating = clamp(Math.round(team.prestige * 0.62 + 22), 20, 88);
    team.salaryTotal = round2(team.riderIds.reduce((s, id) => s + (state.riders[id]?.salary || 0), 0));
  }
  for (const t of state.teams) seedAcademy(state, t, 4);                 // youth stays generated
  const _ut = state.teams[state.userTeamId]; if (_ut) _ut.pendingIntake = previewIntake(state, _ut);
  const _prng = rngNext(state);
  for (const id in state.riders) { const r = state.riders[id]; r.powerKnow = r.teamId === state.userTeamId ? 80 + Math.floor(_prng() * 16) : 3 + Math.floor(_prng() * 30); }
  planSeason(state); recountValues(state);
  state._externalDb = { schema: db.schema || db.metadata?.format || "verbose-riders-teams", source: db.source || db.metadata?.sourceFile || "imported JSON", teams: maxTeams, riders: rows.length, compact: (db.schema || db.metadata?.format) === "cyclegm-rider-team-db-v1" };
  return true;
}

export function newLeague(opts = {}) {
  const seed = (opts.seed ?? 1) >>> 0;
  const state = { v: 2, rng: { seed, n: 0 }, season: opts.season ?? 2026, phase: "racing",
    calIndex: 0, userTeamId: 0, teams: [], riders: {}, nextRiderId: 0, nextRaceId: 0,
    calendar: [], worldCal: [], worldIdx: 0, results: {}, rankings: { rider: {}, team: {} }, news: [], history: [],
    inbox: [], promises: [], expectations: [], pending: [], newsReadHigh: 0, nextEventId: 1, trainingFocus: {}, altitudeCamp: [], boardConfidence: 62, objective: null, regionKnow: {}, nextSponsorId: 1 };
  if (opts.sponsorDB) setSponsorDB(opts.sponsorDB);

  const total = TIERS.reduce((s, t) => s + TIER_CFG[t].count, 0); // 60 teams
  const base = buildField(makeRng(seed ^ 0x9e37), total, 9);      // 540 pros from validated gen
  base.riders.forEach((r) => { augmentRider(state, r); assignUniqueName(state, r); state.riders[r.id] = r; });
  state.nextRiderId = base.riders.length;

  const used = new Set(TEAM_NAMES);
  let ti = 0, hue = 20;
  for (const tier of TIERS) {
    const cfg = TIER_CFG[tier];
    for (let k = 0; k < cfg.count; k++) {
      const bt = base.teams[ti];
      const ids = bt.riders;
      if (cfg.drop > 0) for (const id of ids) {
        const r = state.riders[id];
        if (r.abil) for (const k of ABIL_KEYS) r.abil[k] = clamp(r.abil[k] - cfg.drop, 1, 99);
        syncShadows(r); derivePhysicals(r); r.overall = overallOf(r);
        r.potential = clamp(Math.max(r.potential - cfg.drop, r.overall), r.overall, 96);
        r.ceiling = clamp(Math.max(r.ceiling - cfg.drop, r.overall), r.overall, 99);
        r.value = valueOf(r); r.salary = salaryOf(r); r.status = defaultStatus(r);
      }
      const strength = ids.map((id) => state.riders[id].overall).sort((a, b) => b - a);
      const core = strength.slice(0, 6).reduce((s, x) => s + x, 0) / 6;
      const prestige = clamp(Math.round((core - 50) * 2.0 + cfg.presBase + gaussish(rngNext(state)) * 4), 10, 95);
      const name = (tier === "WorldTour" && TEAM_NAMES[k]) ? TEAM_NAMES[k] : genTeamName(rngNext(state), used);
      hue = (hue + 47) % 360;
      const jersey = (tier === "WorldTour" && bt.jersey) ? bt.jersey : hslHex(hue, 60, 46);
      state.teams.push({ id: ti, name, jersey, prestige, tier,
        riderIds: ids, devIds: [], scouts: [], coaches: [], youthCalendar: YOUTH_RACES.map((r) => r[0]), sponsors: makeSponsors(state, { prestige, riderIds: ids, tier, country: null }),
        youthRating: clamp(Math.round(prestige * 0.62 + 22 + gaussish(rngNext(state)) * 9), 20, 88),
        budget: cfg.budget(prestige), prizeYTD: 0, debtSeasons: 0 });
      ti++;
    }
  }

  state.userTeamId = clamp(opts.userTeamId ?? 0, 0, total - 1);
  if (opts.real !== false) applyRealTeams(state);   // real 2026 WorldTour peloton (depth + academy stay generated)
  for (const t of state.teams) seedAcademy(state, t, 4);
  state.teams[state.userTeamId].pendingIntake = previewIntake(state, state.teams[state.userTeamId]); // first crop to reveal next off-season
  state.nextScoutId = 1;
  state.teams[state.userTeamId].scouts = [makeScout(state), makeScout(state)];
  state.scoutMarket = [makeScout(state), makeScout(state), makeScout(state), makeScout(state), makeScout(state)];
  state.nextCoachId = 1;
  state.teams[state.userTeamId].coaches = [makeCoach(state)];   // you start with one head coach
  state.coachMarket = [makeCoach(state), makeCoach(state), makeCoach(state), makeCoach(state), makeCoach(state)];
  state.shortlist = [];
  initKnowledge(state);
  // seed world knowledge: a little everywhere, a head start in the home patch (plurality of the starting roster)
  for (const reg of REGIONS) state.regionKnow[reg.key] = 6;
  { const counts = {}; for (const id of state.teams[state.userTeamId].riderIds) { const n = state.riders[id]?.nation; if (n) counts[NATION_REGION[n]] = (counts[NATION_REGION[n]] || 0) + 1; }
    const home = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]; if (home) state.regionKnow[home[0]] = 34; }
  applyRegionKnowledge(state);
  rebuildCalendars(state);
  recountValues(state);
  planSeason(state);
  for (const id in state.riders) { const r = state.riders[id]; r.powerKnow = r.teamId === state.userTeamId ? clamp(Math.round(80 + rngNext(state)() * 12), 70, 95) : clamp(Math.round(6 + Math.abs(gaussish(rngNext(state))) * 16), 3, 32);
    if (r.confidence == null) r.confidence = clamp(Math.round((r.morale ?? 62) * 0.55 + 28 + (r.age <= 22 ? -5 : r.age >= 33 ? 4 : 0)), 35, 82); }  // self-belief seeded off morale/age; young start humbler
  setSeasonObjective(state);
  const ut = state.teams[state.userTeamId];
  state.news.push({ season: state.season, date: 0, kind: "season", text: `${state.season} season begins — ${ut.name} race in the ${ut.tier}. Board brief: ${state.objective?.text || ""}` });
  return state;
}

// build the user's calendar (their tier) + the background world calendar (other tiers)
function rebuildCalendars(state) {
  const userTier = state.teams[state.userTeamId].tier;
  state.calendar = buildCalendar(state, userTier);
  state.worldCal = [];
  for (const tier of TIERS) if (tier !== userTier) state.worldCal.push(...buildCalendar(state, tier));
  state.worldCal.sort((a, b) => a.week - b.week);
  state.worldIdx = 0;
}

// ---- the WorldTour: lightly-altered real calendar. fingerprints, not fixed routes — the
//      generator samples a fresh parcours each season from each race's character. ----
const WT_CALENDAR = [
  { week: 4,  kind: "stage",  name: "Tour Down Under",        cat: "WT-stage", country: "AUS", region: "Oceania", coef: 0.50, purse: 200, prestige: 50, stages: 6, summit: [1,1], hills: [1,2], cross: [1,1], finale: "sprint" },
  { week: 5,  kind: "oneday", name: "Cadel Evans Road Race",  cat: "Semi-classic", country: "AUS", region: "Oceania", coef: 0.40, purse: 110, type: "hilly", prestige: 44 },
  { week: 8,  kind: "stage",  name: "UAE Tour",               cat: "WT-stage", country: "UAE", region: "Asia", coef: 0.50, purse: 200, prestige: 50, stages: 7, summit: [2,2], hills: [0,1], itt: [0,1], cross: [1,2], finale: "sprint" },
  { week: 9,  kind: "oneday", name: "Omloop Het Nieuwsblad",  cat: "Semi-classic", country: "BEL", region: "Flanders", coef: 0.42, purse: 120, type: "cobbles", prestige: 46 },
  { week: 9,  kind: "oneday", name: "Kuurne-Brussels-Kuurne", cat: "Semi-classic", country: "BEL", region: "Flanders", coef: 0.34, purse: 90,  type: "flat", prestige: 38 },
  { week: 10, kind: "oneday", name: "Strade Bianche",         cat: "WT-1day", country: "ITA", region: "Tuscany", coef: 0.55, purse: 200, type: "gravel", prestige: 60 },
  { week: 11, kind: "stage",  name: "Paris-Nice",             cat: "WT-stage", country: "FRA", region: "Europe", coef: 0.60, purse: 280, prestige: 60, stages: 8, summit: [2,3], hills: [2,2], itt: [1,1], cross: [1,2], finale: "summit", theme: true },
  { week: 11, kind: "stage",  name: "Tirreno-Adriatico",      cat: "WT-stage", country: "ITA", region: "Europe", coef: 0.60, purse: 280, prestige: 60, stages: 7, summit: [2,2], hills: [2,2], itt: [1,1], cross: [1,1], finale: "sprint", theme: true },
  { week: 12, kind: "oneday", name: "Milan-San Remo",         cat: "Monument", country: "ITA", region: "Europe", coef: 0.85, purse: 600, type: "rolling", prestige: 70 },
  { week: 12, kind: "stage",  name: "Volta a Catalunya",      cat: "WT-stage", country: "ESP", region: "Europe", coef: 0.55, purse: 250, prestige: 56, stages: 7, summit: [3,4], hills: [1,2], finale: "summit", theme: true },
  { week: 13, kind: "oneday", name: "E3 Saxo Classic",        cat: "WT-1day", country: "BEL", region: "Flanders", coef: 0.50, purse: 180, type: "cobbles", prestige: 52 },
  { week: 13, kind: "oneday", name: "Gent-Wevelgem",          cat: "WT-1day", country: "BEL", region: "Flanders", coef: 0.48, purse: 170, type: "crosswind", prestige: 50 },
  { week: 14, kind: "oneday", name: "Dwars door Vlaanderen",  cat: "Semi-classic", country: "BEL", region: "Flanders", coef: 0.42, purse: 130, type: "cobbles", prestige: 46 },
  { week: 14, kind: "oneday", name: "Tour of Flanders",       cat: "Monument", country: "BEL", region: "Flanders", coef: 0.90, purse: 620, type: "cobbles", prestige: 72 },
  { week: 15, kind: "oneday", name: "Paris-Roubaix",          cat: "Monument", country: "FRA", region: "Europe", coef: 0.90, purse: 620, type: "cobbles", prestige: 72 },
  { week: 15, kind: "stage",  name: "Itzulia Basque Country", cat: "WT-stage", country: "ESP", region: "Europe", coef: 0.55, purse: 250, prestige: 56, stages: 6, summit: [3,3], hills: [2,2], itt: [1,1], finale: "summit", theme: true },
  { week: 16, kind: "oneday", name: "Amstel Gold Race",       cat: "WT-1day", country: "NED", region: "Europe", coef: 0.55, purse: 200, type: "hilly", prestige: 56 },
  { week: 16, kind: "oneday", name: "La Fleche Wallonne",     cat: "WT-1day", country: "BEL", region: "Ardennes", coef: 0.55, purse: 200, type: "uphill_short", prestige: 56 },
  { week: 17, kind: "oneday", name: "Liege-Bastogne-Liege",   cat: "Monument", country: "BEL", region: "Ardennes", coef: 0.85, purse: 600, type: "hilly", prestige: 70 },
  { week: 18, kind: "oneday", name: "Eschborn-Frankfurt",     cat: "Semi-classic", country: "GER", region: "Europe", coef: 0.40, purse: 130, type: "flat", prestige: 44 },
  { week: 18, kind: "stage",  name: "Tour de Romandie",       cat: "WT-stage", country: "SUI", region: "Europe", coef: 0.52, purse: 230, prestige: 54, stages: 6, summit: [2,3], hills: [1,1], itt: [1,1], itt_mtn: 0.4, finale: "itt", theme: true },
  { week: 20, kind: "stage",  name: "Giro d'Italia",          cat: "GT", country: "ITA", region: "Europe", coef: 1.0, purse: 2300, prestige: 78, gt: true, stages: 21, summit: [5,6], hills: [3,4], itt: [1,2], itt_mtn: 0.4, cross: [0,1], features: [{ type: "gravel", p: 0.6 }], finale: "auto", theme: true },
  { week: 24, kind: "stage",  name: "Criterium du Dauphine",  cat: "WT-stage", country: "FRA", region: "Europe", coef: 0.58, purse: 260, prestige: 56, stages: 8, summit: [4,4], hills: [1,1], itt: [1,1], itt_mtn: 0.3, finale: "summit", theme: true },
  { week: 25, kind: "stage",  name: "Tour de Suisse",         cat: "WT-stage", country: "SUI", region: "Europe", coef: 0.58, purse: 260, prestige: 56, stages: 8, summit: [4,4], hills: [2,2], itt: [1,2], finale: "itt", theme: true },
  { week: 27, kind: "stage",  name: "Tour de France",         cat: "GT", country: "FRA", region: "Europe", coef: 1.0, purse: 2600, prestige: 82, gt: true, stages: 21, summit: [5,6], hills: [3,4], itt: [1,2], cross: [1,2], features: [{ type: "cobbles", p: 0.35 }], finale: "sprint", theme: true },
  { week: 31, kind: "oneday", name: "Clasica San Sebastian",  cat: "WT-1day", country: "ESP", region: "Europe", coef: 0.50, purse: 180, type: "hilly", prestige: 54 },
  { week: 32, kind: "stage",  name: "Tour de Pologne",        cat: "WT-stage", country: "POL", region: "Europe", coef: 0.50, purse: 200, prestige: 50, stages: 7, summit: [2,3], hills: [2,2], itt: [0,1], cross: [1,1], finale: "sprint" },
  { week: 35, kind: "oneday", name: "Bretagne Classic",       cat: "Semi-classic", country: "FRA", region: "Europe", coef: 0.40, purse: 120, type: "hilly", prestige: 44 },
  { week: 35, kind: "stage",  name: "Renewi Tour",            cat: "WT-stage", country: "BEL", region: "Benelux", coef: 0.48, purse: 180, prestige: 48, stages: 5, summit: [0,1], hills: [1,2], itt: [1,1], cross: [2,2], features: [{ type: "cobbles", p: 0.6 }], finale: "sprint" },
  { week: 35, kind: "stage",  name: "Vuelta a Espana",        cat: "GT", country: "ESP", region: "Europe", coef: 1.0, purse: 2300, prestige: 76, gt: true, stages: 21, summit: [6,8], hills: [3,3], itt: [1,1], cross: [1,1], finale: "summit", theme: true },
  { week: 37, kind: "oneday", name: "GP de Quebec",           cat: "WT-1day", country: "CAN", region: "America", coef: 0.48, purse: 170, type: "uphill_short", prestige: 50 },
  { week: 37, kind: "oneday", name: "GP de Montreal",         cat: "WT-1day", country: "CAN", region: "America", coef: 0.48, purse: 170, type: "hilly", prestige: 50 },
  { week: 39, kind: "oneday", name: "World Championships RR",  cat: "Worlds", country: "UCI", region: "World", coef: 0.90, purse: 300, type: "hilly", prestige: 76 },
  { week: 41, kind: "oneday", name: "Il Lombardia",           cat: "Monument", country: "ITA", region: "Europe", coef: 0.85, purse: 600, type: "summit", prestige: 70 },
  { week: 41, kind: "oneday", name: "Paris-Tours",            cat: "Semi-classic", country: "FRA", region: "Europe", coef: 0.40, purse: 120, type: "flat", prestige: 44 },
  { week: 42, kind: "stage",  name: "Tour of Guangxi",        cat: "WT-stage", country: "CHN", region: "Asia", coef: 0.45, purse: 160, prestige: 44, stages: 6, summit: [1,2], hills: [1,2], cross: [1,1], finale: "sprint" },
];

// per-season route generator: turns a race fingerprint into an ordered stage list, fresh each year
function genStageTypes(rng, fp) {
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const rr = (rg, d = 0) => (rg ? clamp(ri(rg[0], rg[1]) + d, 0, 30) : 0);
  const n = Array.isArray(fp.stages) ? ri(fp.stages[0], fp.stages[1]) : fp.stages;
  let dMtn = 0, dItt = 0; if (fp.theme) { const t = rng(); if (t < 0.30) dMtn = 1; else if (t < 0.50) dItt = 1; }  // yearly emphasis
  let summit = rr(fp.summit, dMtn), hilly = rr(fp.hills), punch = rr(fp.punch), itt = rr(fp.itt, dItt), cross = rr(fp.cross);
  let mtt = (fp.itt_mtn && itt > 0 && rng() < fp.itt_mtn) ? 1 : 0; if (mtt) itt -= 1;
  const feats = []; for (const f of (fp.features || [])) if (rng() < f.p) feats.push(f.type);
  const cap = n - 1;
  const tot = () => summit + hilly + punch + itt + mtt + cross + feats.length;
  while (tot() > cap) { if (hilly > 0) hilly--; else if (cross > 0) cross--; else if (punch > 0) punch--; else if (summit > 1) summit--; else if (itt > 0) itt--; else break; }
  let flat = Math.max(0, cap - tot());
  const early = [], mid = [], late = [], drop = (z, t, k) => { for (let i = 0; i < k; i++) z.push(t); };
  const sLate = Math.max(0, summit - (summit >= 4 ? 1 : 0));                  // keep the big mountain block at the back
  drop(late, "summit", sLate); drop(mid, "summit", summit - sLate);
  drop(late, "itt_mtn", mtt);
  if (itt >= 1) { drop(mid, "itt", 1); drop(late, "itt", itt - 1); }          // a TT mid-race, extras late
  drop(mid, "hilly", Math.ceil(hilly / 2)); drop(early, "hilly", Math.floor(hilly / 2));
  drop(mid, "uphill_short", punch);
  drop(early, "crosswind", cross);                                            // crosswinds early
  for (const ft of feats) drop(ft === "cobbles" || ft === "gravel" ? early : mid, ft, 1);
  const fLate = flat >= 3 ? 1 : 0, fMid = Math.floor((flat - fLate) * 0.35), fEarly = flat - fLate - fMid;
  drop(early, "flat", fEarly); drop(mid, "flat", fMid); drop(late, "flat", fLate);  // sprints front-loaded
  const shuf = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  let seq = [...shuf(early), ...shuf(mid), ...shuf(late)];
  while (seq.length < cap) seq.push("flat");
  seq = seq.slice(0, cap);
  let finale = fp.finale;
  if (finale === "auto") finale = rng() < 0.7 ? "flat" : "summit";            // GT last day: usually a sprint, sometimes a summit
  seq.push(finale === "summit" ? "summit" : finale === "itt" ? "itt" : "flat");
  for (let i = 1; i < seq.length - 1; i++)                                    // avoid 3 summits in a row
    if (seq[i] === "summit" && seq[i - 1] === "summit" && seq[i + 1] === "summit")
      for (let j = 0; j < i - 1; j++) if (seq[j] !== "summit") { [seq[j], seq[i]] = [seq[i], seq[j]]; break; }
  return seq;
}

// ---- season calendar: tier-aware spread of one-day races + stage tours ----
function buildCalendar(state, tier) {
  const rng = rngNext(state);
  const cal = [];
  const pf = tier === "WorldTour" ? 1 : tier === "ProTeam" ? 0.62 : 0.4; // prestige factor by tier
  const od = (week, name, type, prestige, m = {}) => cal.push({
    id: state.nextRaceId++, week, name, kind: "oneday", tier, prestige: Math.round(prestige * pf),
    stages: [makeStage(type, name, Math.round(gaussish(rng) * 8))], ...m,
  });
  const gt = (week, name, types, prestige, grand = false, m = {}) => cal.push({
    id: state.nextRaceId++, week, name, kind: "tour", tier, prestige: Math.round(prestige * pf), grand,
    stages: types.map((ty, k) => makeStage(ty, `${name} · St.${k + 1}`, Math.round(gaussish(rng) * 6))), ...m,
  });

  if (tier === "WorldTour") {
    for (const r of WT_CALENDAR) {
      const m = { cat: r.cat, country: r.country, region: r.region, coef: r.coef, purse: r.purse };
      if (r.kind === "oneday") od(r.week, r.name, r.type, r.prestige, m);
      else gt(r.week, r.name, genStageTypes(rng, r), r.prestige, !!r.gt, m);
    }
    overlayRealCourses(cal);   // swap in real .cds courses where we have them
  } else {
    const s = tier === "ProTeam" ? "" : " Conti";
    od(3, "GP Ouverture" + s, "flat", 26); od(5, "Trofeo Collina" + s, "hilly", 28); od(7, "Ronde Pavé" + s, "rolling", 30);
    od(9, "Mur Challenge" + s, "uphill_short", 30);
    gt(12, "Tour Régional" + s, ["flat", "hilly", "summit", "rolling"], 34);
    od(16, "Classic Sprint" + s, "flat", 24); od(18, "Col Open" + s, "summit", 30); od(20, "Hellingen Cup" + s, "hilly", 28);
    gt(23, "Semaine " + (tier === "ProTeam" ? "Pro" : "Espoir"), ["flat", "uphill_short", "summit", "rolling", "flat"], 36);
    od(28, "Montagne GP" + s, "summit", 30); od(31, "Vallée Cup" + s, "uphill_short", 26);
    gt(34, "Tour " + (tier === "ProTeam" ? "National" : "Avenir"), ["flat", "hilly", "summit", "flat", "rolling", "summit", "flat"], 40);
    od(40, "Autumn Cup" + s, "hilly", 28); od(43, "Finale" + (s || " Pro"), "rolling", 26);
    if (tier === "ProTeam") od(45, "Pro Criterium", "flat", 24);
  }
  return cal.sort((a, b) => a.week - b.week);
}

// fast-resolve a race the user is NOT in (lower/other tiers) — strength + noise, no physics ticks
function fastResolve(state, race, isUser = false) {
  const teams = state.teams.filter((t) => t.tier === race.tier);
  const size = race.kind === "tour" ? 8 : 7;
  const riders = teams.flatMap((t) => aiSquad(state, t.id, race, size).riderIds || []);
  const perStage = race.stages.map((stage) => {
    const base = (stage.lengthKm / 40) * 3600;
    const scored = riders.map((lid) => {
      const r = state.riders[lid]; if (!r) return { lid, score: -999 };
      const cond = 0.6 * (r.form ?? 60) + 0.4 * (r.morale ?? 65);
      return { lid, score: fitFor(r, stage.finishType) + cond * 0.25 + gaussish(rngNext(state)) * 16 };
    }).filter((x) => x.score > -900).sort((a, b) => b.score - a.score);
    const top = scored.length ? scored[0].score : 0;
    const results = scored.map((x, i) => {
      const gap = i === 0 ? 0 : Math.round((top - x.score) * 1.4 + Math.pow(i, 1.1) * 1.2);
      return { lid: x.lid, timeSec: Math.round(base + gap), gapSec: gap };
    });
    return { stageName: stage.name, finishType: stage.finishType, results };
  });
  commitRaceResult(state, race, perStage, null, isUser);
}
// instant strength-based run of the user's remaining calendar (used for "sim to off-season")
export function fastSimSeason(state) {
  let g = 0;
  while (state.phase === "racing" && g++ < 200) {
    const race = state.calendar[state.calIndex]; if (!race) break;
    fastResolve(state, race, true);      // commitRaceResult already ticks scouting once per race
  }
  return state;
}
function flushWorld(state) {
  for (; state.worldIdx < state.worldCal.length; state.worldIdx++) fastResolve(state, state.worldCal[state.worldIdx]);
}
// resolve background-tier races up to a given week, so cross-tier standings stay live through the season
function advanceWorld(state, week) {
  while (state.worldIdx < state.worldCal.length && state.worldCal[state.worldIdx].week <= week) {
    fastResolve(state, state.worldCal[state.worldIdx]); state.worldIdx++;
  }
}
// promotion & relegation across the pyramid (computed from this season's team points)
function promoteRelegate(state) {
  const stand = (tier) => state.teams.filter((t) => t.tier === tier)
    .map((t) => ({ t, pts: state.rankings.team[t.id] || 0 })).sort((a, b) => b.pts - a.pts);
  const wt = stand("WorldTour"), pt = stand("ProTeam"), co = stand("Continental");
  const moves = [];
  const apply = (arr, dir, tier) => arr.forEach((x) => { x.t.tier = tier; moves.push({ id: x.t.id, name: x.t.name, dir, tier }); });
  apply(pt.slice(0, SWAP_N), "promoted", "WorldTour");        // ProTeam best → WT
  apply(wt.slice(-SWAP_N), "relegated", "ProTeam");           // WT worst → ProTeam
  apply(co.slice(0, SWAP_N), "promoted", "ProTeam");          // Conti best → ProTeam
  apply(pt.slice(-SWAP_N), "relegated", "Continental");       // ProTeam worst → Conti
  state.lastMoves = moves;
  moves.forEach((m) => state.news.push({ season: state.season, date: 99, kind: "season",
    text: `${m.name} ${m.dir} to ${m.tier}${m.id === state.userTeamId ? " — that's you!" : ""}.` }));
}

function recountValues(state) {
  for (const id in state.riders) { const r = state.riders[id]; r.overall = overallOf(r); r.value = valueOf(r); }
  for (const t of state.teams) t.salaryTotal = round2(t.riderIds.reduce((s, id) => s + (state.riders[id]?.salary || 0), 0));
}

// ============================================================================
//  SQUAD SELECTION
// ============================================================================
export function dominantType(race) {
  // the finish type that most defines the race / tour
  if (race.kind === "oneday") return race.stages[0].finishType;
  const counts = {};
  race.stages.forEach((s) => (counts[s.finishType] = (counts[s.finishType] || 0) + (s.finishType === "summit" ? 2 : 1)));
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}
export function aiSquad(state, teamId, race, size) {
  const t = state.teams[teamId];
  const dt = dominantType(race);
  // rotate the squad: drop riders who are blocked (GT cap, too fatigued, injured),
  // and discount tired legs so AI rests stars and spreads the load across the roster.
  let roster = t.riderIds.map((id) => state.riders[id]).filter((r) => r && !riderRaceBlock(state, r, race));
  if (roster.length < size) roster = t.riderIds.map((id) => state.riders[id]).filter((r) => r && (r.out | 0) <= 0); // fall back if too thin
  const eff = (r) => fatigueDrag(r);                              // ~1 fresh → <1 tired
  const leader = [...roster].sort((a, b) => fitFor(b, dt) * eff(b) - fitFor(a, dt) * eff(a))[0];
  const rest = roster.filter((r) => r !== leader).sort((a, b) => b.overall * eff(b) - a.overall * eff(a)).slice(0, size - 1);
  const squad = [leader, ...rest].filter(Boolean).slice(0, size);
  return { riderIds: squad.map((r) => r.id), leaderId: leader?.id, plan: "auto" };
}

// ============================================================================
//  RACE RESOLUTION
// ============================================================================
// build an engine field from chosen squads; remember league-id mapping
// ---- stage-race fatigue: riders wear down across a tour; durable engines fade less ----
const STAGE_LOAD = { flat: 0.72, hilly: 1.05, uphill_short: 0.95, summit: 1.42, rolling: 0.95, tt: 0.55, cobbles: 1.32, crosswind: 0.88, gravel: 1.22 };
function stageLoad(st) { const base = STAGE_LOAD[st.finishType] ?? (st.mode === "itt" ? 0.55 : 0.9); return base * ((st.lengthKm || 170) / 175); }
function riderDurability(lr) {
  const a = lr.abil;
  if (a) return clamp(0.74 + (a.recovery - 70) / 150 + (a.stamina - 70) / 220 - (lr.age > 32 ? (lr.age - 32) * 0.02 : 0), 0.62, 1.3);
  return clamp(0.82 + (lr.threshold - 70) / 130 + (((lr.wPrime || 16000) - 16000) / 40000)
    + ({ rouleur: 0.12, helper: 0.09, domestique: 0.08, gc: 0.05, climber: 0.02 }[lr.archetype] || 0)
    - (lr.age > 32 ? (lr.age - 32) * 0.02 : 0), 0.62, 1.3);
}
// season-form condition: out-of-form ~0.94, top form ~1.03 (a bigger swing than the old ±3.5%)
function condition(r) { const f = (0.65 * (r.form ?? 60) + 0.35 * (r.morale ?? 65)) / 100; return 0.92 + 0.11 * f; }

// ── PERSISTENT SEASON FATIGUE (0 = fresh, 100 = exhausted) ──────────────────
// builds with race load, recovers in idle weeks (recovery STAT is the big driver),
// drags performance when deep, gates Grand Tour starts, and resets each off-season.
const FATIGUE_LOAD_K = 2.25;            // race load units → fatigue points
const recAbilOf = (r) => r.abil?.recovery ?? 60;
const staAbilOf = (r) => r.abil?.stamina ?? 60;
// fatigue healed per idle (non-racing) week — recovery stat dominates, age hurts
function fatigueRecovery(r) { return clamp(6 + (recAbilOf(r) - 50) * 0.2 - (r.age > 32 ? (r.age - 32) * 0.45 : 0), 4, 18); }
// how much a race's total load tires this rider (durable, fast-recovering engines wear less)
function raceFatigueAdd(r, totalLoad) { const durMul = clamp(0.82 + (recAbilOf(r) - 70) * 0.0065 + (staAbilOf(r) - 70) * 0.003, 0.7, 1.25); return totalLoad * FATIGUE_LOAD_K / durMul; }
// performance multiplier from season fatigue: ~nil below 35, steep past 65 (to ~-22% at 100)
function fatigueDrag(r) { const f = r.fatigue || 0; return f <= 35 ? 1 : 1 - Math.pow((f - 35) / 65, 1.7) * 0.22; }
export const fatigueLabel = (f) => (f < 25 ? "Fresh" : f < 45 ? "Worked" : f < 65 ? "Tired" : f < 80 ? "Fatigued" : "Exhausted");
// Grand Tours a rider can start per season: 2, or 3 for high-recovery engines
export function gtCapFor(r) { return recAbilOf(r) >= 85 ? 3 : 2; }
// recover EVERY rider's fatigue up to a given race-week (idle weeks heal the legs)
function advanceFatigueTo(state, week) {
  for (const id in state.riders) {
    const r = state.riders[id]; const last = r._fatWeek ?? week; const gap = Math.max(0, week - last);
    if (gap > 0 && (r.fatigue || 0) > 0) r.fatigue = Math.max(0, round2((r.fatigue || 0) - gap * fatigueRecovery(r)));
    r._fatWeek = Math.max(last, week);   // monotonic — world races commit out of order and must not rewind the clock
  }
}
// is a rider blocked from starting this race? returns a reason string or null (ok)
export function riderRaceBlock(state, r, race) {
  if (!r) return null;
  if ((r.out | 0) > 0) return r.suspended ? "suspended" : "injured";
  if (race && race.grand) {
    const cap = gtCapFor(r);
    if ((r._gtSeason || 0) >= cap) return `already ridden ${cap} Grand Tour${cap > 1 ? "s" : ""} this season`;
    if ((r.fatigue || 0) > 70) return `too fatigued (${Math.round(r.fatigue)}) for a Grand Tour`;
  }
  return null;
}

// ── PERIODIZATION ─────────────────────────────────────────────────────────
// A rider targets up to 2 races; fitness builds toward each, peaks in a tight
// window, then drops into a real trough before rebuilding. Themed peaks decide
// where the +bonus lands. Form is the fitness axis (plan-driven); morale is the
// psychological axis (result-driven). condition() blends them.
export const PEAK_THEMES = [{ key: "climb", label: "Climbing" }, { key: "tt", label: "Time trial" }, { key: "sprint", label: "Sprint" }, { key: "allround", label: "All-round" }];
const PEAK_FORM = 95, TROUGH_FORM = 47;
export function periodizedForm(state, rider, week) {
  const base = clamp(Math.round(60 + (((rider.abil?.stamina ?? 70) - 70) / 9)), 50, 66);
  const targets = (rider.plan && rider.plan.targets) || [];
  const ts = targets.map((t) => ({ ...t, wk: state.calendar[t.calIndex]?.week })).filter((t) => t.wk != null).sort((a, b) => a.wk - b.wk);
  if (!ts.length) return { form: base - 2, peakTheme: null, phase: "base" };
  let chosen = null, mind = 999;
  ts.forEach((t, i) => { const d = week - t.wk; if (d >= -3 && d <= 5 && Math.abs(d) < mind) { mind = Math.abs(d); chosen = { t, d, i }; } });
  if (!chosen) return { form: base - 2, peakTheme: null, phase: "base" };
  const { t, d, i } = chosen;
  const prevGap = i > 0 ? t.wk - ts[i - 1].wk : 99;          // a second peak stacked too close is blunted
  const closeness = clamp(prevGap / 6, 0.62, 1);
  const peak = Math.round(base + (PEAK_FORM - base) * closeness);
  let form, theme = null, phase;
  if (d <= 1) { const ramp = d <= 0 ? (3 + d) / 3 : 1; form = base + (peak - base) * ramp; if (d >= -1) { theme = t.theme || "allround"; phase = "peak"; } else phase = "build"; }
  else { form = TROUGH_FORM + (base - TROUGH_FORM) * clamp((d - 2) / 3, 0, 1); phase = "trough"; }
  return { form: clamp(Math.round(form), 1, 99), peakTheme: theme, phase, peakStrength: closeness };
}
// emergent fallback peak (used only if a rider somehow rides while peaking without a theme set)
function peakMul(r) {
  const th = r._peakTheme;
  if (!th) { if ((r.form ?? 60) < 88) return { sus: 1, ana: 1, spr: 1, on: false }; const a = (r.form - 88) / 11 * 0.03; return { sus: 1 + a, ana: 1 + a, spr: 1 + a, on: true }; }
  const amt = 0.06 * (r._peakStrength ?? 1);
  if (th === "allround") { const m = 1 + amt * 0.6; return { sus: m, ana: m, spr: m, on: true }; }
  const tgt = { climb: "sus", tt: "sus", sprint: "spr", punch: "ana" }[th] || "sus";
  const mul = (k) => 1 + (k === tgt ? amt : amt * 0.4);
  return { sus: mul("sus"), ana: mul("ana"), spr: mul("spr"), on: true };
}
// per-race "how the legs feel today" — deterministic from race + rider, ±3%
function dayRoll(daySeed, r) {
  let h = ((daySeed * 374761393) ^ (r.id * 668265263)) >>> 0; h = (Math.imul(h ^ (h >>> 13), 1274126177)) >>> 0;
  return 0.97 + (h % 10000) / 10000 * 0.06;
}
// peak theme that best matches a race's dominant terrain
function planThemeFor(race) { const dt = dominantType(race); return dt === "summit" || dt === "mountain" ? "climb" : dt === "tt" ? "tt" : dt === "flat" ? "sprint" : "allround"; }
// pick up to n well-spaced peak targets for a rider, best-fit & highest-prestige first
function pickTargets(state, rider, n) {
  if (!state.calendar.length || n <= 0) return [];
  const scored = state.calendar.map((race, ci) => ({ ci, wk: race.week, score: fitFor(rider, dominantType(race)) * (race.prestige / 50), theme: planThemeFor(race) }))
    .sort((a, b) => b.score - a.score);
  const gtCap = gtCapFor(rider);
  const picks = [];
  for (const c of scored) {
    if (picks.length >= n) break;
    if (state.calendar[c.ci]?.grand && picks.filter((p) => state.calendar[p.ci]?.grand).length >= gtCap) continue;  // don't plan more GTs than the legs allow
    if (picks.every((p) => Math.abs(p.wk - c.wk) >= 5)) picks.push(c);
  }
  if (!picks.length && scored.length) picks.push(scored[0]);   // never leave a rider planless if races exist
  return picks.map((p) => ({ calIndex: p.ci, theme: p.theme }));
}
// assign targets so EVERY rider gets a plan: leaders peak for two big races, the
// rest get a single best-suited peak. User leaders get sensible defaults to edit.
export function planSeason(state) {
  for (const team of state.teams) {
    const roster = team.riderIds.map((id) => state.riders[id]).filter(Boolean).sort((a, b) => b.overall - a.overall);
    const nLeaders = team.id === state.userTeamId ? 4 : 3;
    roster.forEach((r, idx) => { r.plan = { targets: pickTargets(state, r, idx < nLeaders ? 2 : 1) }; });
  }
}
// user-facing auto-plan for the Season Plan screen. fillOnly => only touch riders
// that currently have no targets. Returns how many riders were (re)planned.
export function autoPlanUser(state, opts = {}) {
  const team = state.teams[state.userTeamId];
  const roster = team.riderIds.map((id) => state.riders[id]).filter(Boolean).sort((a, b) => b.overall - a.overall);
  let n = 0;
  roster.forEach((r, idx) => {
    if (opts.fillOnly && r.plan && r.plan.targets && r.plan.targets.length) return;
    r.plan = { targets: pickTargets(state, r, idx < 4 ? 2 : 1) };
    n++;
  });
  return n;
}
export function setRiderTarget(state, rider, slot, calIndex, theme) {
  rider.plan = rider.plan || { targets: [] };
  const ts = rider.plan.targets;
  if (calIndex == null) { ts.splice(slot, 1); }
  else { ts[slot] = { calIndex, theme: theme || "allround" }; }
  rider.plan.targets = ts.filter(Boolean).slice(0, 2);
}

function buildRaceField(state, entries, stage, priorLoad = 0, daySeed = 0, week = 0) {
  const teams = [], riders = [];
  let rid = 0;
  entries.forEach((entry, ti) => {
    const lt = state.teams[entry.teamId];
    teams.push({ id: ti, jersey: lt.jersey, name: lt.name, riders: [] });
    const leaderId = entry.leaderId;
    const duties = entry.duties || null;
    for (const lid of entry.riderIds) {
      const lr = state.riders[lid];
      if (!lr) continue;
      const pf = periodizedForm(state, lr, week);                     // fitness from the rider's season plan
      lr.form = pf.form; lr._peakTheme = pf.peakTheme; lr._peakStrength = pf.peakStrength; lr._phase = pf.phase;
      const duty = duties ? (duties[lid] || "domestique") : (lid === leaderId ? "leader" : "domestique");
      const sheltered = duty === "leader" || duty === "coleader" || duty === "sprinter";
      const cond = condition(lr), day = dayRoll(daySeed, lr), pk = peakMul(lr);
      const fatigue = priorLoad > 0 ? clamp(priorLoad * 0.007 / riderDurability(lr), 0, 0.13) : 0; // within-race (this tour's) tiredness
      const sdrag = fatigueDrag(lr);                                   // persistent season fatigue drags the legs
      const fatMul = (1 - fatigue) * sdrag;
      const p = expressPower(lr, stage, { sus: cond * day * pk.sus * fatMul, ana: cond * day * pk.ana * fatMul, spr: cond * day * pk.spr * (0.6 + 0.4 * sdrag) });
      const er = {
        id: rid++, lid, teamId: ti, jersey: lt.jersey, duty,
        archetype: lr.archetype, role: sheltered ? "leader" : "helper",
        aggr: p.aggr, name: lr.name, short: lr.short, fresh: Math.round(100 - (fatigue / 0.13) * 40), seasonFat: Math.round(lr.fatigue || 0),
        weight: lr.weight, massKg: lr.massKg, threshold: lr.threshold,
        punch: lr.punch, sprint: p.sprint, cp: p.cp, wPrime: p.wPrime, cdA: p.cdA, cobbleSkill: p.cobbleSkill,
        gravelSkill: clamp(0.18 + (((lr.abil?.gravel ?? 50) * 0.6 + (lr.abil?.bikehandling ?? 60) * 0.25 + (lr.abil?.cobbles ?? 50) * 0.15) / 99) * 0.9, 0.12, 1.05),
        handling: clamp(((lr.abil?.bikehandling ?? 60) * 0.6 + (lr.abil?.positioning ?? 60) * 0.4) / 99, 0.2, 1),
        weatherRes: lr.weatherRes ?? 60, consistency: lr.consistency ?? 64,
      };
      // duties + plans bias who animates the race
      if (duty === "attacker") er.aggr = clamp(er.aggr + 0.32, 0, 1);
      if (entry.plan === "breakaway" && !sheltered) er.aggr = clamp(er.aggr + 0.3, 0, 1);
      if (entry.plan === "gc" && duty === "leader") er.aggr = clamp(er.aggr - 0.2, 0, 1);
      teams[ti].riders.push(er.id);
      riders.push(er);
    }
  });
  return { teams, riders };
}

// resolve ONE stage; returns engine output + lid-keyed finish times
export function runStage(state, race, stage, entries, seedBump, userCommands = [], wantFrames = false) {
  const dt = stage.finishType;
  const stageIdx = Math.max(0, race.stages.indexOf(stage));
  let priorLoad = 0; for (let j = 0; j < stageIdx; j++) priorLoad += stageLoad(race.stages[j]); // tour wears the legs down
  const field = buildRaceField(state, entries, stage, priorLoad, race.id * 131 + stageIdx, race.week || 0);
  const seed = (state.rng.seed ^ (race.id * 7919) ^ (seedBump * 104729)) >>> 0;
  const userIdx = entries.findIndex((e) => e.isUser);
  const userRids = userIdx >= 0 ? field.riders.filter((er) => er.teamId === userIdx).map((er) => er.id) : [];
  // --- per-stage difficulty + breakaway tuning -------------------------------
  const isTour = race.kind === "tour";
  const cs = stage._stage;
  const gpk = cs && cs.distanceKm ? cs.climbM / cs.distanceKm : ({ summit: 22, mountain: 24, hilly: 11, uphill_short: 9 }[stage.finishType] || 3);
  const diff = clamp((gpk - 6) / 16, 0, 1.2);             // 0 flat … ~1.2 a queen stage
  const tune = {};
  if (diff > 0.02) {
    tune.climbSelectivity = 1 + diff * 0.48;              // burn the bunch harder the steeper the day
    if (stage.finishType === "summit") tune.climbSelectivity += 0.12;
    tune.wPrimeScale = clamp(1 - diff * 0.17, 0.78, 1);   // hard days = more brittle = riders crack, gaps open
  }
  const flatish = stage.finishType === "flat" && !stage.cobbles;
  const summit = stage.finishType === "summit";
  tune.breakSize = 5 + (isTour ? 2 : 0) + (flatish ? 0 : 2) + (gpk > 14 ? 1 : 0);
  tune.breakBias = flatish ? (isTour ? 0.10 : 0.05)          // bunch wants the sprint — break caught
                 : summit  ? (isTour ? 0.20 : 0.12)          // favourites reel it in on the final climb
                 :           (isTour ? 0.46 : 0.28);          // hilly / medium-mountain / transition: break thrives
  const out = simulate(field, stage, tune, seed, userCommands, { frames: wantFrames, track: userRids });
  // attach league rider ids onto results via field lookup
  const lidByRid = {}; field.riders.forEach((er) => (lidByRid[er.id] = er.lid));
  out.results.forEach((res) => (res.lid = lidByRid[res.id]));
  if (out.tracked) out.tracked.forEach((tk) => (tk.lid = lidByRid[tk.id]));
  return { out, field };
}

// award points + prize for an ordered finish (array of {lid, place, teamId})
function award(state, order, ptsTable, prestige) {
  order.forEach((o, i) => {
    const r = state.riders[o.lid];
    if (r && i < 10) { r.career = r.career || { wins: 0, podiums: 0, top10: 0, points: 0, seasons: 0 };
      r.career.top10++; if (i < 3) r.career.podiums++; if (i === 0) r.career.wins++; }
    const pts = (ptsTable[i] || 0) * (prestige / 40);
    if (pts > 0) {
      state.rankings.rider[o.lid] = (state.rankings.rider[o.lid] || 0) + pts;
      const tId = state.riders[o.lid]?.teamId;
      if (tId != null) state.rankings.team[tId] = (state.rankings.team[tId] || 0) + pts;
    }
    const prize = prizeFor(i + 1, prestige);
    const tId = state.riders[o.lid]?.teamId;
    if (prize > 0 && tId != null) state.teams[tId].prizeYTD = round2(state.teams[tId].prizeYTD + prize);
  });
}

// Build the startlist (squads) for a race. userEntry overrides the user team.
export function buildEntries(state, race, userEntry = null) {
  const size = race.kind === "tour" ? 8 : 7;
  const teams = race.tier ? state.teams.filter((t) => t.tier === race.tier || t.id === state.userTeamId) : state.teams;
  if (userEntry && userEntry.riderIds) {                                   // an injured/suspended rider can't start
    const fit = userEntry.riderIds.filter((id) => !riderRaceBlock(state, state.riders[id], race));
    userEntry = { ...userEntry, riderIds: fit, leaderId: fit.includes(userEntry.leaderId) ? userEntry.leaderId : fit[0] };
  }
  return teams.map((t) =>
    t.id === state.userTeamId && userEntry ? { teamId: t.id, ...userEntry, isUser: true }
                                           : { teamId: t.id, ...aiSquad(state, t.id, race, size) });
}

// Commit a fully-run race to state: points, prize, GC, archive, news, advance.
// perStage = [{ stageName, finishType, results:[{lid,timeSec,gapSec}] }]
export function commitRaceResult(state, race, perStage, userLeaderLid = null, isUserRace = true) {
  advanceFatigueTo(state, race.week || 0);   // heal everyone's legs up to this race week first
  if (userLeaderLid != null && state.riders[userLeaderLid]) state.riders[userLeaderLid].timesLed = (state.riders[userLeaderLid].timesLed || 0) + 1;
  const gc = {}, cb = {};
  const stageResults = perStage.map((st) => {
    const order = st.results.map((r, i) => ({ lid: r.lid, place: i + 1 }));
    if (race.kind === "tour") {
      award(state, order, STAGE_PTS, race.prestige * 0.5);
      st.results.forEach((r, i) => { gc[r.lid] = (gc[r.lid] || 0) + r.timeSec; cb[r.lid] = (cb[r.lid] || 0) + (i + 1); });
    } else {
      award(state, order, ONEDAY_PTS, race.prestige);
    }
    return { stageName: st.stageName, finishType: st.finishType,
      top: st.results.slice(0, 10).map((r) => ({ lid: r.lid, gapSec: r.gapSec })),
      winnerLid: st.results[0]?.lid };
  });

  let gcOrder = null, points = null, kom = null, youth = null, jerseys = null;
  if (race.kind === "tour") {
    gcOrder = Object.entries(gc).map(([lid, sec]) => ({ lid: +lid, sec })).sort((a, b) => a.sec - b.sec || (cb[a.lid] || 0) - (cb[b.lid] || 0));
    award(state, gcOrder.map((g, i) => ({ lid: g.lid, place: i + 1 })), GC_PTS, race.prestige);
    // secondary classifications, accumulated across the stages
    const ptsAcc = {}, komAcc = {}, teamGc = {};
    const crng = rngNext(state);
    perStage.forEach((st, si) => {
      const stage = race.stages[si] || {};
      const [pW] = stageClassWeights(stage);
      st.results.forEach((r, i) => { if (pW > 0 && i < PTS_FINISH.length) ptsAcc[r.lid] = (ptsAcc[r.lid] || 0) + Math.round(PTS_FINISH[i] * pW); }); // finish points (green)
      // intermediate sprints on road stages — contested by fast men & the breakaway
      if (stage.mode !== "itt") {
        const nSpr = 1 + ((stage.lengthKm || 0) > 170 ? 1 : 0);
        for (let q = 0; q < nSpr; q++) {
          const order = st.results.map((r) => { const rr = state.riders[r.lid], a = rr?.abil; return { lid: r.lid, s: (a ? a.sprint * 0.55 + a.positioning * 0.2 + a.attacking * 0.25 : 50) + gaussish(crng) * 22 }; }).sort((x, y) => y.s - x.s);
          order.slice(0, INTERMED_PTS.length).forEach((x, i) => (ptsAcc[x.lid] = (ptsAcc[x.lid] || 0) + Math.round(INTERMED_PTS[i] * 0.7)));
        }
      }
      // categorized climbs → KOM points to the cresters (summit finishes scored by the finish order)
      for (const c of deriveClimbs(stage)) {
        const tbl = KOM_CAT_PTS[c.cat] || [1];
        const summitFinish = c.endKm >= (stage.lengthKm || 1) - 1 && stage.finishType === "summit";
        const order = summitFinish ? st.results.map((r) => r.lid)
          : st.results.map((r) => ({ lid: r.lid, s: climbCresterScore(state.riders[r.lid], c.cat) + gaussish(crng) * 26 })).sort((x, y) => y.s - x.s).map((x) => x.lid);
        order.slice(0, tbl.length).forEach((lid, i) => (komAcc[lid] = (komAcc[lid] || 0) + tbl[i]));
      }
      // team classification: sum of each team's best three finishers this stage
      const perTeam = {};
      st.results.forEach((r) => { const tid = state.riders[r.lid]?.teamId; if (tid == null) return; (perTeam[tid] = perTeam[tid] || []).push(r.timeSec); });
      for (const tid in perTeam) { const best3 = perTeam[tid].sort((a, b) => a - b).slice(0, 3); if (best3.length >= 3) teamGc[tid] = (teamGc[tid] || 0) + best3.reduce((a, b) => a + b, 0); }
    });
    points = Object.entries(ptsAcc).map(([lid, p]) => ({ lid: +lid, pts: p })).sort((a, b) => b.pts - a.pts).slice(0, 15);
    kom = Object.entries(komAcc).map(([lid, p]) => ({ lid: +lid, pts: p })).sort((a, b) => b.pts - a.pts).slice(0, 12);
    youth = gcOrder.filter((g) => { const rr = state.riders[g.lid]; return rr && rr.age <= 25; }).slice(0, 12).map((g) => ({ lid: g.lid, sec: g.sec }));
    if (youth.length) { const yl = youth[0].sec; youth.forEach((y) => (y.gap = y.sec - yl)); }
    var teamClass = Object.entries(teamGc).map(([tid, sec]) => ({ tid: +tid, sec })).sort((a, b) => a.sec - b.sec).slice(0, 12);
    if (teamClass.length) { const tl = teamClass[0].sec; teamClass.forEach((t) => (t.gap = t.sec - tl)); }
    jerseys = { gc: gcOrder[0].lid, points: points[0]?.lid ?? null, kom: kom[0]?.lid ?? null, youth: youth[0]?.lid ?? null, teams: teamClass[0]?.tid ?? null };
    // season points toward the standings for the secondary jerseys (sprinters/climbers/young riders earn from these)
    const jbase = [90, 60, 45, 32, 22], jpAward = (arr) => arr.slice(0, 5).forEach((x, i) => { const f = jbase[i] * (race.prestige / 50); state.rankings.rider[x.lid] = (state.rankings.rider[x.lid] || 0) + f; const tId = state.riders[x.lid]?.teamId; if (tId != null) state.rankings.team[tId] = (state.rankings.team[tId] || 0) + f; });
    jpAward(points); jpAward(kom); jpAward(youth);
    for (const [label, lid] of [["Points", jerseys.points], ["Mountains", jerseys.kom], ["Youth", jerseys.youth]]) {
      if (lid == null || lid === jerseys.gc) continue; const rr = state.riders[lid]; if (!rr) continue;
      rr.palmares = rr.palmares || []; rr.palmares.push({ s: state.season, race: `${race.name} (${label})`, place: 1, kind: "jersey", prestige: race.prestige * 0.5 });
      if (rr.palmares.length > 50) rr.palmares.shift();
      rr.prominence = clamp((rr.prominence || 0) + 1.5 * (race.prestige / 45), 0, 100);
    }
  }
  const winnerLid = race.kind === "tour" ? gcOrder[0].lid : stageResults[0].winnerLid;
  const wr = state.riders[winnerLid];
  const rec = { raceId: race.id, season: state.season, name: race.name, kind: race.kind, week: race.week, grand: !!race.grand,
    stageResults, gc: gcOrder ? gcOrder.slice(0, 25).map((g) => ({ lid: g.lid, sec: g.sec, gap: g.sec - gcOrder[0].sec })) : null,
    points, kom, youth, jerseys, teamClass: race.kind === "tour" ? (typeof teamClass !== "undefined" ? teamClass : null) : null, winnerLid };
  state.results[race.id] = rec;
  // palmares + prominence for the podium of the final classification
  const podium = race.kind === "tour"
    ? gcOrder.slice(0, 3).map((g, i) => ({ lid: g.lid, place: i + 1 }))
    : (perStage[0]?.results || []).slice(0, 3).map((r, i) => ({ lid: r.lid, place: i + 1 }));
  podium.forEach((p) => { const rr = state.riders[p.lid]; if (!rr) return;
    rr.palmares = rr.palmares || [];
    rr.palmares.push({ s: state.season, race: race.name, place: p.place, kind: race.kind, prestige: race.prestige });
    if (rr.palmares.length > 50) rr.palmares.shift();
    rr.prominence = clamp((rr.prominence || 0) + (p.place === 1 ? 4 : p.place === 2 ? 2 : 1) * (race.prestige / 45), 0, 100);
  });
  // season fatigue: racers take on this race's total load; deep fatigue risks a breakdown
  const totalLoad = (race.stages || []).reduce((s, st) => s + stageLoad(st), 0);
  const participants = new Set();
  for (const st of perStage) for (const r of st.results) participants.add(r.lid);
  for (const lid of participants) {
    const r = state.riders[lid]; if (!r) continue;
    r.fatigue = clamp(round2((r.fatigue || 0) + raceFatigueAdd(r, totalLoad)), 0, 100);
    if (race.grand) r._gtSeason = (r._gtSeason || 0) + 1;
    if (r.teamId === state.userTeamId && r.fatigue > 62) {   // user 'out' ticks down via weeklyTick
      const p = ((r.fatigue - 62) / 38) * 0.10;
      if (rngNext(state)() < p) {                            // graded injury — real stakes for the young especially
        const roll = rngNext(state)(), young = r.age <= 25;
        let add, sev, cf, gmult = null;
        if (roll < 0.62) { add = 1 + Math.floor(rngNext(state)() * 2); sev = "a knock"; cf = -3; }
        else if (roll < 0.9) { add = 3 + Math.floor(rngNext(state)() * 3); sev = "a real injury"; cf = -8; gmult = 0.62; }
        else { add = 6 + Math.floor(rngNext(state)() * 4); sev = "a serious injury"; cf = -14; gmult = 0.4; }
        r.out = (r.out || 0) + add; r.fatigue = clamp(r.fatigue - 12, 0, 100);
        r.confidence = clamp((r.confidence ?? 60) + cf, 0, 100);
        if (young && gmult != null) r._injGrowthMult = Math.min(r._injGrowthMult ?? 1, gmult);   // a lost season stunts growth
        if (young && add >= 6 && rngNext(state)() < 0.4) r.ceiling = Math.max(r.overall, (r.ceiling ?? r.overall) - (2 + Math.floor(rngNext(state)() * 3))); // rare: a bad injury clips the ceiling itself
        state.news.push({ season: state.season, date: race.week, kind: "injury", riderLid: r.id, text: `${r.short} breaks down with ${sev} — out ${add} race${add > 1 ? "s" : ""}.` });
      }
    }
  }
  applyRaceOutcome(state, race, perStage, rngNext(state));
  if (isUserRace) {
    const seen = new Set();                                        // racing a rider sharpens your read of their power (heavy fog early)
    for (const st of perStage) for (let i = 0; i < st.results.length; i++) {
      const lid = st.results[i].lid; if (seen.has(lid)) continue; seen.add(lid);
      const r = state.riders[lid]; if (!r) continue;
      let gain = (100 - (r.powerKnow ?? 10)) * 0.18 + 4; if (i < 5) gain += 4; // a clear, visible ride tells you more
      r.powerKnow = clamp(Math.round((r.powerKnow ?? 10) + gain), 0, 100);
    }
  }
  if (isUserRace) weeklyTick(state, rngNext(state), race);
  if (isUserRace) tickScouting(state);
  if (isUserRace) advanceWorld(state, race.week);
  state.news.push({ season: state.season, date: race.week, kind: "result", raceId: race.id,
    text: `${race.name}: ${wr ? wr.name : "?"} (${wr && state.teams[wr.teamId] ? state.teams[wr.teamId].name : "—"}) ${race.kind === "tour" ? "wins overall" : "wins"}.` });
  if (isUserRace) {
    // curated inbox report — the tidy "how it went" line for your squad
    const uid = state.userTeamId; let bestPlace = 99, bestName = null;
    const consider = (lid, place) => { const rr = state.riders[lid]; if (rr && rr.teamId === uid && place && place < bestPlace) { bestPlace = place; bestName = rr.short; } };
    if (rec.gc) rec.gc.forEach((g, i) => consider(g.lid, i + 1));
    (rec.stageResults || []).forEach((sr) => (sr.top || []).forEach((p) => consider(p.lid, p.place)));
    const ord = (p) => p === 1 ? "1st" : p === 2 ? "2nd" : p === 3 ? "3rd" : p + "th";
    const won = bestPlace === 1;
    state.news.push({ season: state.season, date: race.week, kind: "report", raceId: race.id,
      text: bestName ? `${race.name}: your best was ${bestName} ${ord(bestPlace)}${race.kind === "tour" ? " on GC" : ""}${won ? " — a win! 🎉" : bestPlace <= 3 ? " — on the podium." : ""}` : `${race.name}: no notable result for your squad.` });
    state.calIndex++;
    if (state.calIndex >= state.calendar.length) state.phase = "offseason";
  }
  return rec;
}

// Auto-resolve the race at calIndex (no watching). userEntry optional.
// ============================================================================
//  TACTIC COMPILER — turns a pre-race plan into deterministic engine commands
// ============================================================================
// tactic = { intent, leaderLid, roles:{id:role}, team:{breakCommit,gapPolicy,tempo,risk},
//   sprint:{sprinterLid,train:[ids,last=final],hitFromKm,launchKm,fallback},
//   satellites:[{lid,work,dropAt:(km|'on_bridge'),purpose}],
//   markers:[{km,type:'attack'|'bridge'|'tempo'|'move_up'|'ease',who:(lid|role|'team')}] }
export function compileTactic(state, race, stage, tactic, teamId) {
  const cmds = [];
  if (!tactic) return cmds;
  const len = stage.lengthKm;
  const riderIds = new Set(state.teams[teamId].riderIds);
  const has = (id) => id != null && riderIds.has(id);
  const roleRiders = (role) => Object.entries(tactic.roles || {}).filter(([id, r]) => r === role && riderIds.has(+id)).map(([id]) => +id);

  // gap policy → peloton chase behaviour
  if (tactic.team) {
    if (tactic.team.gapPolicy === "chase") cmds.push({ type: "chase", teamId, level: "hard", fromKm: 0 });
    else if (tactic.team.gapPolicy === "let_go") cmds.push({ type: "chase", teamId, level: "ease", fromKm: 0 });
  }
  // satellites — seed into the early break, drop back to escort the leader
  for (const sat of tactic.satellites || []) {
    if (!has(sat.lid)) continue;
    const onBridge = sat.dropAt === "on_bridge";
    cmds.push({ type: "satellite", lid: sat.lid, work: sat.work || "build",
      dropAtKm: onBridge ? null : (typeof sat.dropAt === "number" ? sat.dropAt : null),
      onBridge, leaderLid: tactic.leaderLid ?? null, purpose: sat.purpose });
  }
  // sprint train (hit/launch expressed as km from the finish so they translate across stages)
  if (tactic.sprint && has(tactic.sprint.sprinterLid)) {
    const hitFromKm = tactic.sprint.hitFromEnd != null ? Math.max(0, len - tactic.sprint.hitFromEnd) : (tactic.sprint.hitFromKm ?? Math.max(0, len - 5));
    const launchKm = tactic.sprint.launchFromEnd != null ? Math.max(0, len - tactic.sprint.launchFromEnd) : (tactic.sprint.launchKm ?? Math.max(0, len - 0.25));
    cmds.push({ type: "leadout", teamId, sprinterLid: tactic.sprint.sprinterLid,
      train: (tactic.sprint.train || []).filter(has), hitFromKm, launchKm, fallback: tactic.sprint.fallback });
  }
  // protect: shelter specific riders (sit in, draft, conserve)
  for (const lid of tactic.protect || []) if (has(lid)) cmds.push({ type: "protect", lid });
  // tempo: designated domestiques drive the pace over a section
  for (const tz of tactic.tempos || []) {
    const lids = (tz.lids || []).filter(has);
    if (lids.length && tz.toKm > tz.fromKm) cmds.push({ type: "tempo", lids, fromKm: clamp(tz.fromKm, 0, len), toKm: clamp(tz.toKm, 0, len), level: tz.level || "hard" });
  }
  // course markers
  for (const mk of tactic.markers || []) {
    const km = clamp(mk.km ?? 0, 0, len);
    const targets = mk.who === "team" ? [null] : (typeof mk.who === "string" ? roleRiders(mk.who) : [mk.who]);
    for (const wl of targets) {
      if (mk.type === "attack") cmds.push(wl == null ? { type: "attack", teamId, fromKm: km } : { type: "attack", lid: wl, fromKm: km });
      else if (mk.type === "bridge") cmds.push(wl == null ? { type: "attack", teamId, fromKm: km, _bridge: true } : { type: "attack", lid: wl, fromKm: km, _bridge: true });
      else if (mk.type === "tempo") cmds.push({ type: "chase", teamId, level: "hard", fromKm: km });
      else if (mk.type === "move_up" && wl != null) cmds.push({ type: "moveup", lid: wl, fromKm: km });
      else if (mk.type === "ease" && wl != null) cmds.push({ type: "ease", lid: wl, fromKm: km });
    }
  }
  return cmds;
}

// fast-forward: auto-resolve the user's races (auto lineup) up to — but not including — targetIndex
export function skipToRace(state, targetIndex) {
  const ti = clamp(targetIndex, 0, state.calendar.length);
  const done = [];
  let guard = 0;
  while (state.calIndex < ti && guard++ < 80) {
    const race = state.calendar[state.calIndex];
    const rec = resolveRace(state, null);                                  // null → auto squad
    if (!rec) break;
    const rows = rec.gc ? rec.gc : (rec.stageResults?.[0]?.top || []);
    let userBest = null;
    rows.forEach((row, i) => { const r = state.riders[row.lid]; if (r && r.teamId === state.userTeamId && userBest == null) userBest = i + 1; });
    done.push({ name: race.name, week: race.week, cat: race.cat, winnerLid: rec.winnerLid, win: state.riders[rec.winnerLid]?.teamId === state.userTeamId, userBest });
  }
  return done;
}
// what the player should know before fast-forwarding past these races
export function skipWarnings(state, targetIndex) {
  const w = [], big = [];
  for (let i = state.calIndex; i < targetIndex && i < state.calendar.length; i++) {
    const r = state.calendar[i];
    if (r.cat === "GT" || r.cat === "Monument" || r.cat === "Worlds" || (r.prestige || 0) >= 66) big.push(r.name);
  }
  if (big.length) w.push(`Auto-racing ${big.length} major race${big.length > 1 ? "s" : ""}: ${big.slice(0, 4).join(", ")}${big.length > 4 ? "…" : ""}`);
  const unread = (state.inbox || []).filter((m) => !m.read).length;
  if (unread) w.push(`${unread} unread inbox message${unread > 1 ? "s" : ""}`);
  const team = state.teams[state.userTeamId];
  const top = team.riderIds.map((id) => state.riders[id]).filter(Boolean).sort((a, b) => b.overall - a.overall)[0];
  if (top && (top.form ?? 60) < 50) w.push(`${top.short} (your strongest rider) is well off form`);
  return w;
}

export function resolveRace(state, userEntry = null) {
  const race = state.calendar[state.calIndex];
  if (!race) return null;
  const entries = buildEntries(state, race, userEntry);
  const perStage = race.stages.map((stage, si) => {
    const { out } = runStage(state, race, stage, entries, si + 1);
    return { stageName: stage.name, finishType: stage.finishType,
      results: out.results.map((r) => ({ lid: r.lid, timeSec: r.timeSec, gapSec: r.gapSec })) };
  });
  return commitRaceResult(state, race, perStage, userEntry ? userEntry.leaderId : null);
}

// ============================================================================
//  FINANCES & SPONSORS (settled at season end)
// ============================================================================
function teamRankPositions(state) {
  const arr = state.teams.map((t) => ({ id: t.id, pts: state.rankings.team[t.id] || 0 }))
    .sort((a, b) => b.pts - a.pts);
  const pos = {}; arr.forEach((x, i) => (pos[x.id] = i + 1));
  return pos;
}
function seasonWins(state, teamId) {
  let w = 0;
  for (const rid in state.results) { const r = state.results[rid]; if (state.riders[r.winnerLid]?.teamId === teamId) w++; }
  return w;
}
// the soft "wage budget": what this team can sustainably pay (sponsor income net of running costs)
export function wageBudget(t) {
  const income = (t.sponsors || []).reduce((s, sp) => s + (sp.value || 0), 0);
  const ops = round2((t.prestige || 50) * 0.05 + (t.riderIds || []).length * 0.4);
  return round2(income - ops);
}
function settleFinances(state) {
  const pos = teamRankPositions(state);
  for (const t of state.teams) {
    normalizeSponsors(state, t);
    const salaries = t.riderIds.reduce((s, id) => s + (state.riders[id]?.salary || 0), 0);
    const devCost = (t.devIds || []).reduce((s, id) => s + (state.riders[id]?.salary || 0), 0);
    const scoutCost = (t.scouts || []).reduce((s, sc) => s + (sc.salary || 0), 0) + (t.coaches || []).reduce((s, c) => s + (c.salary || 0), 0);
    const sponsorIncome = t.sponsors.reduce((s, sp) => s + sp.value, 0);
    const ops = round2(t.prestige * 0.05 + t.riderIds.length * 0.4); // staff, travel, bikes
    // sponsor asks: hit them for a lump-sum bonus; miss them and patience erodes — when it
    // runs out the sponsor WALKS, leaving the slot empty (lost income) and denting the board.
    let bonusTotal = 0; const bonusHit = []; let confDrop = 0; const walked = [];
    t.sponsors.forEach((sp) => {
      if (sp.vacant || !sp.ask) return;
      const { met } = evalAsk(state, t, sp.ask);
      sp.happy = met;
      if (met) {
        sp.patience = sponsorPatience(sp);
        if (sp.bonus) { bonusTotal += sp.bonus; bonusHit.push({ name: sp.name, bonus: sp.bonus, ask: labelAsk(sp.ask) }); }
        sp.years = Math.max(0, (sp.years || 0) - 1);
      } else {
        sp.patience = (sp.patience ?? sponsorPatience(sp)) - 1;
        confDrop += sp.tier === "title" ? 6 : 2;
        if (sp.patience <= 0) {
          walked.push({ name: sp.name, tier: sp.tier });
          confDrop += sp.tier === "title" ? 16 : 5;
          Object.assign(sp, { name: "(vacant)", value: 0, years: 0, ask: null, bonus: 0, happy: true, vacant: true, brief: null, scale: undefined, patience: undefined });
        } else { sp.years = Math.max(0, (sp.years || 0) - 1); }
      }
    });
    bonusTotal = round2(bonusTotal);
    const net = sponsorIncome + t.prizeYTD + bonusTotal - salaries - devCost - scoutCost - ops;
    t.budget = round2(t.budget + net);
    t.lastNet = round2(net); t.opsCost = ops; t.devCost = round2(devCost); t.scoutCost = round2(scoutCost);
    t.sponsorIncome = round2(sponsorIncome); t.wageBill = round2(salaries); t.bonusTotal = bonusTotal;
    if (t.id === state.userTeamId) t.bonusHit = bonusHit;
    // soft cap: overspending into debt has consequences
    if (t.budget < 0) t.debtSeasons = (t.debtSeasons || 0) + 1; else t.debtSeasons = 0;
    let confPenalty = 0;
    if (t.debtSeasons >= 1) confPenalty = t.debtSeasons >= 2 ? -8 : -4;
    // sponsor fallout (missed asks erode confidence; a walkout stings, a title walkout is a crisis)
    if (t.id === state.userTeamId) {
      if (confPenalty || confDrop) state.boardConfidence = clamp(Math.round((state.boardConfidence ?? 62) + confPenalty - confDrop), 0, 100);
      for (const w of walked) state.news.push({ season: state.season, date: 0, kind: "season", text: w.tier === "title" ? `SPONSOR CRISIS — title backer ${w.name} walks away with their target unmet. The team loses its headline funding and must find a new title sponsor.` : `SPONSOR — ${w.name} (${w.tier}) ends the deal early, their target unmet.` });
      if (confDrop && !walked.length) state.news.push({ season: state.season, date: 0, kind: "season", text: `SPONSORS — unmet targets have your backers unhappy (board confidence ${-confDrop}). Deliver, or they walk.` });
    }
    if (walked.some((w) => w.tier === "title")) applyTeamIdentity(state, t);
    // forced sale: two seasons under water → offload the priciest rider to balance the books
    if (t.debtSeasons >= 2 && t.riderIds.length > 7) {
      const pricey = t.riderIds.map((id) => state.riders[id]).filter(Boolean).sort((a, b) => (b.salary || 0) - (a.salary || 0))[0];
      if (pricey) {
        releaseFrom(state, t, pricey); pricey.teamId = null; pricey.contractYears = 0; pricey.salary = salaryOf(pricey);
        t.budget = round2(t.budget + (pricey.value || 0) * 0.5);   // a transfer fee eases the squeeze
        if (t.id === state.userTeamId) state.news.push({ season: state.season, date: 0, kind: "season", text: `FINANCES — debt forces a sale: ${pricey.name} is let go to balance the books.` });
      }
    }
    t.prestige = clamp(Math.round(t.prestige + (pos[t.id] <= 5 ? 2 : pos[t.id] >= 14 ? -2 : 0) + (t.budget < 0 ? -2 : 0)), 15, 97);
  }
}
// expired sponsors: AI teams auto-renew/replace; the user's expired slots are left "open"
// (years 0) to renegotiate or replace from the market in the Finance screen.
function renewSponsors(state) {
  for (const t of state.teams) {
    normalizeSponsors(state, t);
    if (t.id === state.userTeamId) continue;   // user handles their own sponsors interactively
    t.sponsors = t.sponsors.map((sp) => {
      const slot = SLOT_DEFS.find((s) => s.tier === sp.tier) || SLOT_DEFS[1];
      if (sp.vacant || !sp.ask) {              // a sponsor walked → sign a replacement of that tier
        const used = new Set(t.sponsors.map((s) => s.name));
        const co = pickCompany(state, sp.tier === "title" ? titleScales(t.tier) : coScales(t.tier), used);
        return co ? sponsorFromCompany(state, t, slot, co) : makeSponsorFallback(state, t, slot);
      }
      if (sp.years > 0) return sp;
      const rr = rngNext(state);
      const adj = sp.happy ? 1.06 + rr() * 0.14 : 0.74 + rr() * 0.14;
      const base = sponsorPool(t.prestige) * slot.share;
      return { ...sp, value: round2(clamp(sp.value * adj, base * 0.5, base * 1.4)), years: 1 + Math.floor(rr() * 3),
        patience: sponsorPatience(sp), ask: makeAsk(rngNext(state), state, t, slot.diff) };
    });
  }
}

// --- player-facing sponsor management (Finance screen) ----------------------
// a market of available offers, refreshed each season; high pay ⇄ harder asks
export function sponsorMarket(state, teamId) {
  const t = state.teams[teamId]; if (!t) return [];
  if (t._sponsorMarket && t._sponsorMarketSeason === state.season) return t._sponsorMarket;
  state.nextSponsorId = state.nextSponsorId || 1;
  const used = new Set((t.sponsors || []).map((s) => s.name));
  const offers = ["title", "co", "co", "equipment", "co", "title"].map((tier) => {
    const slot = SLOT_DEFS.find((s) => s.tier === tier) || SLOT_DEFS[1];
    const scales = slot.tier === "title" ? titleScales(t.tier) : coScales(t.tier);
    const co = pickCompany(state, scales, used);
    if (co) { used.add(co.n); return sponsorFromCompany(state, t, slot, co); }
    return makeSponsorFallback(state, t, slot);
  });
  t._sponsorMarket = offers; t._sponsorMarketSeason = state.season;
  return offers;
}
export function openSponsorSlots(t) { return (t.sponsors || []).filter((s) => (s.years || 0) <= 0).length; }
// sign an offer into an OPEN slot OF THE SAME TIER (one title slot only — a title
// offer can only fill the title slot). buy out the current backer of that tier first.
export function signSponsor(state, teamId, offerId) {
  const t = state.teams[teamId]; const offers = sponsorMarket(state, teamId);
  const offer = offers.find((o) => o.id === offerId); if (!offer) return { ok: false, reason: "offer no longer available" };
  const idx = t.sponsors.findIndex((s) => s.tier === offer.tier && (s.years || 0) <= 0);
  if (idx < 0) {
    const lbl = offer.tier === "title" ? "title" : offer.tier === "equipment" ? "equipment" : "co-sponsor";
    return { ok: false, reason: `no open ${lbl} slot — buy out your current ${lbl} first` };
  }
  t.sponsors[idx] = { ...offer, happy: true, vacant: false, patience: offer.patience ?? sponsorPatience(offer) };
  t._sponsorMarket = offers.filter((o) => o.id !== offerId);
  const renamed = applyTeamIdentity(state, t);   // team name follows its title/lead-co sponsor
  return { ok: true, sponsor: t.sponsors[idx], teamName: renamed };
}
// renew an expired sponsor (terms swing on last season's happiness)
export function renegotiateSponsor(state, teamId, sponsorId) {
  const t = state.teams[teamId]; const sp = (t.sponsors || []).find((s) => s.id === sponsorId); if (!sp) return { ok: false };
  if (sp.vacant || !sp.ask) return { ok: false, reason: "empty slot — sign a sponsor from the market" };
  if ((sp.years || 0) > 0) return { ok: false, reason: "still under contract" };
  const slot = SLOT_DEFS.find((s) => s.tier === sp.tier) || SLOT_DEFS[1];
  const rng = rngNext(state);
  const adj = sp.happy ? 1.06 + rng() * 0.14 : 0.8 + rng() * 0.12;
  const base = sponsorPool(t.prestige) * slot.share;
  sp.value = round2(clamp(sp.value * adj, base * 0.5, base * 1.5));
  sp.years = 2 + Math.floor(rng() * 2);
  sp.ask = makeAsk(rng, state, t, slot.diff);
  sp.bonus = round2(sp.value * (0.25 + slot.diff * 0.4));
  sp.patience = sponsorPatience(sp);
  return { ok: true, sponsor: sp };
}
// terminate a sponsor early (pays a buyout fee) so the slot can be replaced
export function buyoutSponsor(state, teamId, sponsorId) {
  const t = state.teams[teamId]; const sp = (t.sponsors || []).find((s) => s.id === sponsorId); if (!sp) return { ok: false };
  if ((sp.years || 0) <= 0) return { ok: false, reason: "already open" };
  const fee = round2(sp.value * Math.max(1, sp.years) * 0.5);
  if ((t.budget || 0) < fee) return { ok: false, reason: `need ${fee.toFixed(2)}M to buy out` };
  t.budget = round2(t.budget - fee); sp.years = 0; sp.happy = true;
  return { ok: true, fee };
}
// full finance summary for the Finance screen (with live ask progress)
export function teamFinances(state, teamId) {
  const t = state.teams[teamId]; normalizeSponsors(state, t);
  const income = round2(t.sponsors.reduce((s, sp) => s + sp.value, 0));
  const wageBill = round2(t.riderIds.reduce((s, id) => s + (state.riders[id]?.salary || 0), 0));
  const dev = round2((t.devIds || []).reduce((s, id) => s + (state.riders[id]?.salary || 0), 0));
  const scouts = round2((t.scouts || []).reduce((s, sc) => s + (sc.salary || 0), 0));
  const ops = round2(t.prestige * 0.05 + t.riderIds.length * 0.4);
  const sponsors = t.sponsors.map((sp) => ({ ...sp, askLabel: labelAsk(sp.ask), prog: evalAsk(state, t, sp.ask) }));
  const projBonus = round2(sponsors.filter((s) => s.prog.met).reduce((s, sp) => s + (sp.bonus || 0), 0));
  const net = round2(income + (t.prizeYTD || 0) + projBonus - wageBill - dev - scouts - ops);
  const wb = wageBudget(t);
  return { budget: t.budget, income, prize: round2(t.prizeYTD || 0), wageBill, dev, scouts, ops, net,
    wageBudget: wb, wageOver: round2(wageBill - wb), sponsors, projBonus, debtSeasons: t.debtSeasons || 0 };
}

// ============================================================================
//  DEVELOPMENT · AGING · RETIREMENT · YOUTH INTAKE
// ============================================================================
const PRIMARY = { gc: "climbing", climber: "climbing", rouleur: "flat",
                  sprinter: "sprint", leadout: "sprint", puncheur: "punch" };
// "auto" training spreads work across the abilities that actually drive a rider's
// overall (threshold = climbing+flat+tt; plus the archetype's signature stat), so a
// developing rider's rating climbs efficiently instead of dumping into one dead-end stat.
const AUTO_GROW = {
  gc:       { climbing: 1.0, flat: 0.5, timetrial: 0.35, punch: 0.2 },
  climber:  { climbing: 1.0, flat: 0.45, timetrial: 0.3, punch: 0.2 },
  rouleur:  { flat: 1.0, climbing: 0.45, timetrial: 0.45 },
  sprinter: { sprint: 1.0, flat: 0.5, timetrial: 0.2, punch: 0.3 },
  leadout:  { sprint: 1.0, flat: 0.5, timetrial: 0.2, punch: 0.3 },
  puncheur: { punch: 1.0, climbing: 0.5, flat: 0.3, timetrial: 0.2 },
};

// ---- specialist training focuses: where the season's work is directed + side effects ----
// punch === VO2/anaerobic engine (drives W′). weight loss raises W/kg (climbing).
const FOCI = {
  auto:      { label: "Auto (by type)", grow: null },
  threshold: { label: "Threshold · FTP", grow: { climbing: 0.5, flat: 0.5, timetrial: 0.35 } },
  vo2:       { label: "VO₂ · punch", grow: { punch: 1.0, climbing: 0.25 } },
  sprint:    { label: "Sprint", grow: { sprint: 1.0, punch: 0.2 } },
  tt:        { label: "Time trial", grow: { timetrial: 0.9, flat: 0.4 }, aero: 0.0045 },
  climb:     { label: "Climbing + weight", grow: { climbing: 0.9 }, weight: -0.9 },
  flat:      { label: "Flat power", grow: { flat: 0.9, timetrial: 0.3 } },
  cobbles:   { label: "Cobbles", grow: { cobbles: 0.9, flat: 0.3 } },
  endurance: { label: "Endurance", grow: { stamina: 0.8, recovery: 0.5 } },
  weight:    { label: "Body composition", grow: {}, weight: -1.4 },
  durab:     { label: "Durability", grow: { stamina: 0.5, recovery: 0.6 } },
  recover:   { label: "Recover / maintain", grow: {}, recover: true },
};
const normFocus = (f) => (f === "punch" ? "vo2" : FOCI[f] ? f : "auto");
export const TRAINING_FOCI = Object.entries(FOCI).map(([key, v]) => ({ key, label: v.label }));
function weightFloor(r) { const base = r.baseWeight ?? r.weight; return clamp(base - 5, 52, base); }

// Power–duration profile from the CP/W′ model + body mass. This is the "test" sheet:
// FTP≈CP, 20-min, 5-min (VO₂), 1-min from W′; sprint is neuromuscular (rating-based).
export function powerProfile(r) {
  const cp = r.cp, wp = r.wPrime, kg = r.weight;
  const sprintW = Math.round(640 + (r.sprint || 50) * 12.5); // ~5 s neuromuscular peak
  const wkg = (w) => +(w / kg).toFixed(2);
  // CP + W′/τ with τ tuned so short efforts read like real pro mean-max power
  return {
    weight: kg,
    ftp: { w: cp, wkg: wkg(cp) },
    p20: { w: Math.round(cp + wp / 1400), wkg: wkg(Math.round(cp + wp / 1400)) },
    p5:  { w: Math.round(cp + wp / 360), wkg: wkg(Math.round(cp + wp / 360)) },
    p1:  { w: Math.round(cp + wp / 110), wkg: wkg(Math.round(cp + wp / 110)) },
    sprint: { w: sprintW, wkg: wkg(sprintW) },
  };
}

// ---- altitude camp: limited team resource, real adaptation + diminishing returns ----
const ALT_SLOTS = 4;
const ALT_COST = 0.18; // €m per camp
export function altitudeRoster(state) { return state.altitudeCamp || []; }
export function altitudeSlots() { return ALT_SLOTS; }
export function altitudeCost() { return ALT_COST; }
export function toggleAltitude(state, lid) {
  state.altitudeCamp = state.altitudeCamp || [];
  const i = state.altitudeCamp.indexOf(lid);
  if (i >= 0) state.altitudeCamp.splice(i, 1);
  else if (state.altitudeCamp.length < ALT_SLOTS) state.altitudeCamp.push(lid);
  return state.altitudeCamp;
}

// performance signal: this season's ranking points vs peers of the same ability (both directions)
function seasonPerf(state) {
  const rostered = Object.values(state.riders).filter((r) => r.teamId != null);
  const buckets = {};
  for (const r of rostered) { const b = Math.max(40, Math.round(r.overall / 5) * 5); (buckets[b] = buckets[b] || []).push(state.rankings.rider[r.id] || 0); }
  const stat = {};
  for (const b in buckets) { const a = buckets[b]; const m = a.reduce((s, x) => s + x, 0) / a.length;
    const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); stat[b] = { m, sd: Math.max(sd, m * 0.5 + 2) }; }
  return (r) => { const b = Math.max(40, Math.round(r.overall / 5) * 5); const s = stat[b] || { m: 0, sd: 1 };
    return clamp(((state.rankings.rider[r.id] || 0) - s.m) / s.sd, -2.5, 2.5); };
}
// shared breakout readiness (0..1): drives BOTH the off-season leap odds and the live "watch" meter, so the meter honestly predicts the payoff
function breakoutScoreOf(r, perf) {
  const peakGap = (r.peak ?? 27) - r.age;
  const youthF = clamp((peakGap + 1) / 7, 0, 1);                  // young = capacity to leap; ~0 at/after peak
  const room = (r.ceiling ?? r.potential ?? r.overall) - r.overall;
  const roomF = clamp(room / 12, 0, 1);
  const moraleF = clamp(((r.morale ?? 65) - 45) / 45, 0, 1);
  const perfF = clamp((perf + 0.2) / 1.6, 0, 1);                  // results this season — the gate
  const academy = r.dev ? 1.12 : 1;
  const base = 0.30 * youthF + 0.16 * roomF + 0.10 * moraleF;     // latent capacity (max .56)
  let score = (base + 0.44 * perfF) * (0.4 + 0.6 * perfF) * academy;  // results gate it up to full
  score *= youthF > 0 ? 1 : 0;
  return clamp(score, 0, 1);
}
// live squad watch: who's trending toward a breakthrough, with band + limiter hint (pure; safe on old saves)
export function breakoutWatch(state, opts = {}) {
  const perfFn = seasonPerf(state);
  const t = state.teams[state.userTeamId];
  const ids = opts.all ? Object.keys(state.riders).map(Number) : (t.riderIds || []);
  const out = [];
  for (const id of ids) {
    const r = state.riders[id]; if (!r || r.teamId == null) continue;
    const peakGap = (r.peak ?? 27) - r.age;
    if (peakGap < -1) continue;                                   // only developing riders are candidates
    const perf = perfFn(r);
    const score = breakoutScoreOf(r, perf);
    const room = (r.potential ?? r.overall) - r.overall;          // shown (potential-based) headroom
    const perfF = clamp((perf + 0.2) / 1.6, 0, 1);
    let band, label;
    if (score >= 0.72) { band = "cusp"; label = "On the cusp of a breakthrough"; }
    else if (score >= 0.5) { band = "pushing"; label = "Pushing for a step up"; }
    else if (score >= 0.28) { band = "developing"; label = "Developing"; }
    else { band = "settled"; label = "Settled"; }
    let hint;
    if (room <= 1) hint = "near his ceiling";
    else if (perfF < 0.35) hint = "needs results to convert it";
    else if ((r.morale ?? 65) < 50) hint = "morale is holding him back";
    else if (score >= 0.72) hint = "one strong block from a leap";
    else hint = "trending up";
    out.push({ lid: id, short: r.short, name: r.name, age: r.age, overall: r.overall, potential: r.potential, jersey: r.jersey, archetype: r.archetype, dev: !!r.dev, score, pct: Math.round(score * 100), band, label, hint, perf, room });
  }
  return out.sort((a, b) => b.score - a.score);
}
// theoretical ceiling from a PCM-style potential star rating (~2.5–6.0).
// 2.5★→68 · 3.5★→76 · 4.5★→84 · 5.5★→92 · 6.0★→96 — aggressive, but reaching it is never guaranteed.
function starCeiling(pot) { const p = clamp(Number(pot) || 3.5, 2.0, 6.0); return clamp(Math.round(68 + (p - 2.5) * 8), 50, 99); }
// hidden development traits: work-rate (how much of the ceiling is realised), bust
// risk (talent that never clicks), and late bloomers (keep improving, peak late).
function rollDevTraits(rng, r, pot) {
  const headroom = (r.ceiling ?? r.potential ?? r.overall) - r.overall;
  let gr = clamp(0.82 + gaussish(rng) * 0.26 + ((Number(pot) || 3.5) - 4) * 0.04, 0.45, 1.55);
  r._bust = false; r._lateBloom = false;
  if (headroom >= 8 && rng() < 0.27) { gr = 0.35 + rng() * 0.2; r._bust = true; }                  // high-potential bust: stalls well short
  if (rng() < 0.13) { r.peak = clamp((r.peak ?? 27) + 3 + Math.floor(rng() * 3), 26, 33); gr = Math.max(gr, 0.95); r._lateBloom = true; } // late bloomer
  r.growthRate = gr;
}
// dynamic ceiling: drifts every off-season on results + morale + age, both ways, with leaps/slumps.
// leaps are talent-led — latent potential gives a base chance even with no results (a star can be
// born from the academy); results amplify it; busts rarely click; bigger potential → bigger jumps,
// with a small chance of a generational mega-leap.
function updateCeiling(rng, r, perf) {
  const peakGap = (r.peak ?? 27) - r.age;
  const gr = r.growthRate ?? 1;
  const ageBias = peakGap > 2 ? 0.6 : peakGap >= -1 ? 0 : -clamp(-peakGap, 0, 8) * 0.45;  // young drift up, veterans decay
  const moraleBias = clamp(((r.morale ?? 65) - 62) / 40, -1, 1) * 1.2;
  const conf = r.confidence ?? 60;
  const confBias = clamp((conf - 60) / 42, -1, 1) * 1.0;          // self-belief nudges the ceiling both ways
  const perfBias = perf * 1.6;
  let drift = ageBias + moraleBias + confBias + perfBias + gaussish(rng) * 1.5;
  r._leap = 0; r._slump = 0;
  const room = (r.ceiling ?? r.potential ?? r.overall) - r.overall;
  const youthF = clamp((peakGap + 1) / 8, 0, 1);
  const potF = clamp(room / 18, 0, 1);
  let leapP = (0.11 * youthF * potF * (0.45 + 0.55 * clamp(gr, 0, 1.5) / 1.5)) + 0.22 * breakoutScoreOf(r, perf);
  leapP *= 0.75 + 0.5 * clamp(conf, 0, 100) / 100;               // a confident kid is likelier to break out; a rattled one isn't
  if (r._leapPrimed) leapP += 0.18;                              // a breakout the manager backed in-season is primed to land now
  if (gr < 0.7) leapP *= 0.35;                                   // busts rarely break out
  const slumpP = 0.03 + ((r.morale ?? 65) < 45 ? 0.04 : 0) + (conf < 45 ? 0.05 : 0) + (peakGap < -2 ? 0.03 : 0) + (r._bust ? 0.05 : 0);
  const roll = rng();
  if (roll < leapP) {
    let m = 3 + Math.floor(rng() * 5) + Math.round(potF * 3);    // ~3–11, larger with remaining potential
    const megaP = 0.06 + (r._leapPrimed ? 0.06 : 0) + (conf >= 80 ? 0.03 : 0);
    if (rng() < megaP) m += 4 + Math.floor(rng() * 7);          // rare mega-leap → a generational explosion, likelier when primed & confident
    drift += m; r._leap = m;
  } else if (roll < leapP + slumpP) { const m = 3 + Math.floor(rng() * 4); drift -= m; r._slump = m; }
  r.ceiling = clamp(Math.round((r.ceiling ?? r.potential ?? r.overall) + drift), r.overall, 99);
  return drift;
}
function devGrowth(rng, r) {
  const ceil = r.ceiling ?? r.potential ?? r.overall;
  const room = ceil - r.overall;
  const gr = r.growthRate ?? 1;
  const morale = devMoraleFactor(r);
  const prog = r.program === "develop" ? 1.25 : r.program === "race" ? 0.9 : 1.0;
  const devBonus = r.dev ? clamp(1.6 - (r.age - 18) * 0.06, 1.2, 1.6) : 1.0; // academy coaching focus — develops markedly faster, youngest fastest
  let delta;
  if (r.age < r.peak) {
    const youthBoost = clamp((r.peak - r.age) / 5.5, 0.5, 1.5);            // the younger they are, the faster work converts to ability
    delta = clamp(room, 0, 26) * (0.26 + rng() * 0.18) * gr * morale * prog * devBonus * youthBoost;
    if (r._bust) delta *= 0.55;                                            // a bust realises little of the talent
    delta += (rng() - 0.4) * 0.9;
  } else {
    // PRIME + DECLINE: at/past peak a rider can still make marginal gains for a couple of years IF they have untapped
    // ceiling and the belief to realise it (career-best seasons) — the decline curve is unchanged underneath.
    const peakOver = r.age - r.peak;
    const belief = clamp((((r.confidence ?? 60) + (r.morale ?? 65)) / 2) / 68, 0.5, 1.3);
    const primeTail = clamp(1 - peakOver / 2.5, 0, 1);                      // 1 at peak → 0 by ~peak+2.5
    const prime = clamp(room, 0, 18) * 0.15 * gr * belief * primeTail * prog;
    const decline = -clamp(peakOver * 0.4, 0, 5) * (0.35 + rng() * 0.45) - rng() * 0.25;
    delta = prime + decline;
  }
  return delta;
}
function trainRating(rng, r, focusRaw, inAltitude, perf = 0) {
  const before = r.overall, beforeWkg = r.cp / r.weight;
  r._breakout = false; r._overlean = false;
  const focus = normFocus(focusRaw);
  const F = FOCI[focus] || FOCI.auto;
  let delta = devGrowth(rng, r);
  delta *= clamp(1 + perf * 0.16, 0.7, 1.4);                            // good results compound growth, bad seasons dampen it
  if (delta > 0) delta *= clamp(0.82 + ((r.confidence ?? 60) - 60) / 90, 0.62, 1.28);  // belief turns latent talent into realised ability
  if (F.recover) delta = delta > 0 ? delta * 0.45 : delta * 0.5;        // maintain: damp growth & decline
  let altBonus = 0;
  if (inAltitude) { altBonus = Math.max(0.6, 2.4 - (r.altYears || 0) * 0.5); r.altYears = (r.altYears || 0) + 1; } // diminishing

  // distribute the season's work onto the focus targets (auto/recover -> archetype primary)
  const grow = F.grow == null ? { ...(AUTO_GROW[r.archetype] || { climbing: 1.0, flat: 0.4 }) } : { ...F.grow };
  if (altBonus) { grow.climbing = (grow.climbing || 0) + 1.0; grow.punch = (grow.punch || 0) + 0.4; }
  const totW = Object.values(grow).reduce((s, x) => s + x, 0);
  let pool = delta + altBonus;
  if (r._youthWin) { pool += r._youthWin * 0.7; r._youthWin = 0; }   // a winning U23 season sharpens them
  if (r._leap) { pool += r._leap * 0.85; r._breakout = true; }       // a dynamic-ceiling leap is partly realised now — a big jump
  if (r._slump) pool -= r._slump * 0.75;                             // a slump bites into ability
  if (r._devPool) { pool += r._devPool; r._devPool = 0; }            // mid-season progress the manager banked now cashes in
  if (r._devDrag) { pool -= r._devDrag; r._devDrag = 0; }            // mid-season setbacks bite into the year's growth
  if (r._injGrowthMult != null) { if (pool > 0) pool *= r._injGrowthMult; r._injGrowthMult = null; }  // a season disrupted by injury realises less
  if (r._coachMult) { if (pool > 0) pool *= r._coachMult; r._coachMult = null; }  // facilities + coaching staff speed development
  if (r.devPath && pool > 0) pool *= pathFitOf(r, r.devPath);        // a committed path develops faster on-grain, slower against it
  r._leapPrimed = 0;                                                 // the priming is spent this off-season, win or lose
  if (totW > 0 && r.abil) for (const k of Object.keys(grow)) { const cur = r.abil[k] ?? 50; let add = pool * grow[k] / totW;
    if (add > 0 && cur >= 92) add *= clamp(1 - (cur - 92) / 9, 0.12, 1);   // diminishing returns near the ceiling — a 99 stat stays genuinely rare
    r.abil[k] = clamp(Math.round(cur + add), 1, 99); }
  syncShadows(r);

  // body composition: lose mass toward a healthy floor -> higher W/kg (climbing)
  if (F.weight) {
    const floor = weightFloor(r), room = Math.max(0, r.weight - floor);
    const cut = Math.abs(F.weight) * (0.55 + rng() * 0.5);
    r.weight = Math.round((r.weight - Math.min(cut, room * 0.8)) * 10) / 10;
    if (r.weight < (r.baseWeight ?? r.weight) - 3) { if (rng() < 0.5 && r.abil) r.abil.sprint = clamp(r.abil.sprint - 1, 1, 99); r._overlean = true; } // too lean costs power
  } else if (r.age > r.peak && rng() < 0.4) {
    r.weight = Math.round((r.weight + 0.6) * 10) / 10;   // veterans drift up
  }
  if (F.aero) r.aeroAdj = Math.min((r.aeroAdj || 0) + F.aero, 0.02);     // TT: permanent cdA trim
  syncShadows(r);

  derivePhysicals(r);
  r.overall = overallOf(r);
  const conv = r._leap ? 0.6 : 0.32;                          // shown potential tracks the (now dynamic) ceiling, fast on a leap
  if (r.age < r.peak) r.potential = clamp(Math.round(r.potential + ((r.ceiling ?? r.potential) - r.potential) * conv), r.overall, 99);
  else r.potential = Math.max(r.overall, Math.round(r.potential * 0.55 + r.overall * 0.45));
  r.value = valueOf(r);
  r.lastGrowth = r.overall - before;
  r.lastWkg = +((r.cp / r.weight) - beforeWkg).toFixed(2);
  r.trainedAlt = !!inAltitude;
}
export function developAll(state, trainingFocus = {}) {
  const alt = new Set((state.altitudeCamp || []).map(Number));
  const perfFn = seasonPerf(state);     // results vs peers — drives the dynamic ceiling
  // your academy's facilities + coaching staff bias who develops and how fast (user team only; AI runs baseline)
  const ut = state.teams[state.userTeamId];
  const coaches = ut?.coaches || [];
  const youthCoach = coaches.filter((c) => c.spec === "youth").reduce((m, c) => m + c.rating, 0);
  const mentCoach = coaches.filter((c) => c.spec === "mentality").reduce((m, c) => m + c.rating, 0);
  const facFactor = academyTier(ut?.youthRating).lvl;   // 1..5
  // rank the sport by the season's points → a handful of star display-floor targets (results make stars, not hidden ceilings)
  const rankPts = state.rankings?.rider || {};
  const ranked = Object.keys(rankPts).filter((id) => rankPts[id] > 0).sort((a, b) => rankPts[b] - rankPts[a]);
  const starFloorTarget = {};
  ranked.forEach((id, i) => { starFloorTarget[id] = i < 3 ? 92 : i < 8 ? 90 : i < 18 ? 87 : i < 32 ? 84 : 0; });
  const staffMult = (r) => {
    let m = 1;
    if (r.dev) m += (facFactor - 1) * 0.03;                       // better facilities → faster in-house growth
    if (r.dev && youthCoach) m += youthCoach / 520;              // head of youth lifts every prospect
    const spec = coaches.find((c) => c.arch && c.arch.includes(r.archetype)); // a specialist who fits this rider
    if (spec) m += spec.rating / 620;
    return m;
  };
  for (const id in state.riders) {
    const r = state.riders[id];
    r.age += 1;
    const perf = r.teamId != null ? perfFn(r) : 0;
    if (r.teamId === state.userTeamId && r.age <= 27) { r._coachMult = staffMult(r); if (mentCoach) r.confidence = clamp((r.confidence ?? 60) + mentCoach / 110, 0, 100); } // mentality coaching rebuilds belief each winter
    updateCeiling(rngNext(state), r, perf);
    trainRating(rngNext(state), r, trainingFocus[id], alt.has(+id), perf);
    // STARDOM = RESULTS: the season's very best riders earn a display anchor so the sport always has genuine stars,
    // even as the imported originals age out. Bounded by world rank (only a handful qualify each year) so it can't run
    // away with ceiling drift; NEVER baked into abilities. An ACTIVE star (still ranked) holds the anchor at any age;
    // once they drop out of the top, the floor decays like any veteran's.
    const tf = starFloorTarget[id]; // 0 unless this rider ranked near the top of the sport this season
    if (tf) { const step = Math.min(tf, (r._ovrFloor || r.overall) + 4); if (step > (r._ovrFloor || 0)) { r._ovrFloor = step; r.overall = overallOf(r); } }
    // the established-class floor erodes past peak — but not while the rider is still an active top-ranked star
    if (r._ovrFloor > 0 && !tf && r.age > (r.peak ?? 27)) {
      r._ovrFloor = Math.max(0, r._ovrFloor - clamp((r.age - (r.peak ?? 27)) * 0.7, 0.5, 4));
      r.overall = overallOf(r);
    }
    if (r.devPath != null) r._pathSeasons = (r._pathSeasons || 0) + 1;   // seasons committed to the current path (re-tooling penalty applies only to established paths)
    r.history = r.history || [];
    r.history.push({ s: state.season, ovr: r.overall, ftp: r.cp, wkg: +(r.cp / r.weight).toFixed(2), kg: r.weight });
    if (r.history.length > 16) r.history.shift();
  }
  state.altitudeCamp = [];   // camp consumed for the season
}
function retireAndRegen(state) {
  const retired = [];
  for (const id in state.riders) {
    const r = state.riders[id]; const rng = rngNext(state);
    const p = (r.age >= 39 ? 1 : r.age >= 36 ? 0.35 + (40 - r.overall) * 0.01 : r.age >= 33 ? 0.10 : 0.005) * retireMoraleFactor(r);
    if (rng() < clamp(p, 0, 1)) retired.push(+id);
  }
  retired.forEach((id) => {
    const r = state.riders[id];
    if (r.teamId != null && state.teams[r.teamId]) {
      state.teams[r.teamId].riderIds = state.teams[r.teamId].riderIds.filter((x) => x !== id);
      state.teams[r.teamId].devIds = (state.teams[r.teamId].devIds || []).filter((x) => x !== id);
    }
    // build a career tribute before the rider is removed
    const wins = r.career?.wins || 0;
    const bestPalm = (r.palmares || []).filter((p) => p.place === 1).sort((a, b) => (b.prestige || 0) - (a.prestige || 0))[0];
    const seasons = r.career?.seasons || Math.max(1, (r.age || 32) - 20);   // est. pro years if the DB carried none
    const tier = wins >= 60 || (bestPalm && bestPalm.prestige >= 70) ? "great" : wins >= 20 || r.overall >= 80 ? "stalwart" : "journeyman";
    state._osRetire = state._osRetire || [];
    state._osRetire.push({ name: r.name, short: r.short, age: r.age, nation: r.nation, seasons, wins,
      podiums: r.career?.podiums || 0, best: bestPalm ? bestPalm.race : null, mine: r.teamId === state.userTeamId,
      team: r.teamId != null ? state.teams[r.teamId]?.name : null, peakOverall: r.overall, tier });
    state.news.push({ season: state.season, date: 99, kind: "retire", text: `${r.name} retires at ${r.age}${wins ? ` after ${wins} career win${wins !== 1 ? "s" : ""}` : ""}.` });
    delete state.riders[id];
  });
  for (const t of state.teams) t.devIds = (t.devIds || []).filter((id) => state.riders[id]);
  // free-agent prospect pool: a handful of neo-pros hit the market each year
  const n = retired.length + 3 + Math.floor(rngNext(state)() * 4);
  for (let i = 0; i < n; i++) {
    const r = makeProspect(state, null, "#9b9b9b");
    r.dev = false; r.teamId = null; r.salary = salaryOf(r); r.contractYears = 0;
  }
  // academy intake: AI teams top their development squad toward the cap, quality scaled by their academy.
  // (the user's intake is handled interactively via osIntake / autoIntake.)
  for (const t of state.teams) {
    if (t.id === state.userTeamId) continue;
    const golden = rngNext(state)() < 0.05 + (t.youthRating ?? 45) / 1100;
    const q = youthQuality(state, t, golden);
    const add = clamp(DEVCAP - t.devIds.length, 0, 2 + Math.floor(rngNext(state)() * 2));
    for (let i = 0; i < add; i++) { const r = makeProspect(state, t.id, t.jersey, { quality: clamp(q + gaussish(rngNext(state)) * 0.12, 0.3, 1.15) }); t.devIds.push(r.id); }
  }
}

// ---- contracts & transfers ----
function expireContracts(state) {
  for (const t of state.teams) {
    const keep = [];
    for (const id of t.riderIds) {
      const r = state.riders[id]; if (!r) continue;
      r.contractYears = Math.max(0, r.contractYears - 1);
      if (r.contractYears <= 0) { r.teamId = t.id; keep.push(id); r._expiring = true; } // still here but expiring; AI decides, the user re-signs in the off-season
      else keep.push(id);
    }
    t.riderIds = keep;
  }
}
export function freeAgents(state) {
  return Object.values(state.riders).filter((r) => r.teamId == null);
}
function aiTransfers(state) {
  // 1) teams re-sign or release expiring riders; 2) fill rosters from free agents
  for (const t of state.teams) {
    if (t.id === state.userTeamId) continue; // user handles own team in UI
    const proj = () => t.sponsors.reduce((s, sp) => s + sp.value, 0) - t.riderIds.reduce((s, id) => s + (state.riders[id]?.salary || 0), 0);
    // expiring: keep good ones if affordable, else release
    for (const id of [...t.riderIds]) {
      const r = state.riders[id];
      if (!r || !r._expiring) continue;
      r._expiring = false;
      const want = r.overall >= 55 || r.potential >= 70;
      if (want && (proj() > -1 || t.budget > 3)) { signTo(state, t, r, 2 + Math.floor(rngNext(state)() * 2)); }
      else { releaseFrom(state, t, r); }
    }
  }
  // free-agent pool filling (AI), weakest teams pick first to balance
  let fas = freeAgents(state).sort((a, b) => (b.value ?? valueOf(b)) - (a.value ?? valueOf(a)));   // sorted once; entries removed as they sign
  const pool = () => fas;
  const order = [...state.teams].filter((t) => t.id !== state.userTeamId).sort((a, b) => a.prestige - b.prestige);
  let guard = 0;
  while (guard++ < 400) {
    fas = fas.filter((r) => r.teamId == null);
    let any = false;
    for (const t of order) {
      if (t.riderIds.length >= ROSTER_CAP) continue;
      const proj = t.sponsors.reduce((s, sp) => s + sp.value, 0) - t.riderIds.reduce((s, id) => s + (state.riders[id]?.salary || 0), 0);
      const fa = pool().find((r) => r.salary <= Math.max(proj + 2, 0.4) || (t.budget > 2 && r.salary < 2));
      if (fa && t.riderIds.length < ROSTER_CAP) { const o = fa.overall, nm = fa.name, ar = fa.archetype; signTo(state, t, fa, 1 + Math.floor(rngNext(state)() * 3)); if (o >= 66) (state._osMoves = state._osMoves || []).push({ name: nm, to: t.name, overall: o, archetype: ar }); any = true; }
    }
    if (!any) break;
  }
  // make sure no team is below 7 — top up with cheapest FA regardless
  for (const t of state.teams) {
    if (t.id === state.userTeamId) continue;
    while (t.riderIds.length < ROSTER_MIN) {
      const fa = freeAgents(state).sort((a, b) => a.salary - b.salary)[0];
      if (!fa) break; signTo(state, t, fa, 1);
    }
  }
}
export function signTo(state, team, rider, years, salary) {
  rider.teamId = team.id; rider.jersey = team.jersey; rider.salary = salary != null ? salary : salaryOf(rider);
  rider.contractYears = years; rider._expiring = false;
  if (team.id === state.userTeamId) rider.know = 100;
  if (!team.riderIds.includes(rider.id)) team.riderIds.push(rider.id);
  return rider;
}
export function releaseFrom(state, team, rider) {
  team.riderIds = team.riderIds.filter((x) => x !== rider.id);
  rider.teamId = null; rider.jersey = "#9b9b9b";
}

// ============================================================================
//  TRANSFERS & CONTRACTS (FM-style: fees, bids, negotiation, squad status)
// ============================================================================
const STATUS_LABEL = { leader: "Team Leader", coleader: "Co-Leader", rotation: "Rotation", domestique: "Domestique", prospect: "Prospect" };
const STATUS_MULT = { leader: 1.35, coleader: 1.12, rotation: 1.0, domestique: 0.85, prospect: 0.5 };
export { STATUS_LABEL };
function defaultStatus(r) {
  if (r.dev) return "prospect";
  if (r.overall >= 80) return "leader";
  if (r.overall >= 72) return "coleader";
  if (r.overall >= 62) return "rotation";
  return "domestique";
}
// transfer fee a selling club expects (0 = expiring / Bosman free)
export function askingPrice(state, rider) {
  const yrs = Math.max(0, rider.contractYears || 0);
  if (yrs <= 0) return 0;
  const v = rider.value || 0.5;
  let mult = 1 + yrs * 0.35;
  if (rider.age <= 24) mult *= 1.3; else if (rider.age >= 32) mult *= 0.55;
  mult *= 0.9 + ((rider.form ?? 60) / 100) * 0.3;
  return round2(v * mult);
}
// selling club's response to a fee for one of its riders
export function evaluateBid(state, rider, fee) {
  const team = state.teams[rider.teamId];
  const ask = askingPrice(state, rider);
  if (ask <= 0) return { ok: true, free: true };
  const willing = rider.transferListed || (team && team.riderIds.length > ROSTER_CAP - 2) || (rider.morale ?? 65) < 42;
  if (fee >= ask) return { ok: true };
  if (fee >= ask * 0.85 && willing) return { ok: true };
  if (fee >= ask * 0.7) return { ok: false, counter: ask, reason: "Hold out for the valuation" };
  return { ok: false, reason: rider.transferListed ? "Below our valuation" : "Not for sale at that price", counter: ask };
}
// rider's wage/length demand for a given squad role at a given club
export function contractDemand(state, team, rider, role) {
  const base = rider.value || 0.4;
  const rm = STATUS_MULT[role] || 1;
  const ambition = rider.amb ?? 50, prestige = team.prestige || 50;
  let wage = base * SALARY_FACTOR * rm * (0.9 + (ambition - 50) / 200) * (1 - (prestige - 50) / 420);
  if ((rider.morale ?? 65) < 45) wage *= 1.12;
  wage = round2(Math.max(0.05, wage));
  const years = rider.age >= 32 ? 1 : rider.age <= 23 ? 4 : 3;
  return { wage, years, role };
}
// will the rider accept {wage, years, role}?
export function offerAcceptance(state, team, rider, offer) {
  const want = contractDemand(state, team, rider, offer.role);
  if ((rider.amb ?? 50) >= 75 && rider.overall >= 72 && (offer.role === "domestique" || offer.role === "prospect"))
    return { accept: false, reason: "Wants a bigger role than that", want };
  if (offer.wage < want.wage * 0.95) return { accept: false, reason: `Wants about €${want.wage}M/yr`, want };
  if ((offer.years || 0) < 1) return { accept: false, reason: "Wants a real contract", want };
  return { accept: true, want };
}
// finalise a signing/purchase with agreed personal terms
export function completeTransfer(state, buyerId, rider, fee, terms) {
  const buyer = state.teams[buyerId], seller = rider.teamId != null ? state.teams[rider.teamId] : null;
  if (seller) { seller.riderIds = seller.riderIds.filter((id) => id !== rider.id); seller.devIds = (seller.devIds || []).filter((id) => id !== rider.id); seller.budget = round2(seller.budget + (fee || 0)); }
  buyer.budget = round2(buyer.budget - (fee || 0) - (terms.signOn || 0));
  rider.teamId = buyer.id; rider.jersey = buyer.jersey; rider.dev = false;
  rider.salary = terms.wage; rider.contractYears = terms.years; rider.status = terms.role; rider._expiring = false; rider.transferListed = false;
  if (buyer.id === state.userTeamId) rider.know = 100;
  if (!buyer.riderIds.includes(rider.id)) buyer.riderIds.push(rider.id);
  rider.morale = clamp((rider.morale ?? 65) + 6, 1, 99);
  recountValues(state);
  return rider;
}
export function setTransferListed(state, rider, v) { rider.transferListed = !!v; }
// rival clubs that would bid for your rider, around asking price
export function solicitOffers(state, rider) {
  const ask = askingPrice(state, rider);
  if (ask <= 0) return [];
  const offers = [];
  for (const t of state.teams) {
    if (t.id === rider.teamId || t.id === state.userTeamId) continue;
    const bigger = t.prestige > (state.teams[rider.teamId]?.prestige || 50);
    const need = t.riderIds.length < ROSTER_MIN + 2 && rngNext(state)() < 0.16 + (bigger ? 0.12 : 0) + (rider.transferListed ? 0.1 : 0);
    if (need && rider.overall >= 58) {
      const fee = round2(ask * (0.8 + rngNext(state)() * 0.5));
      if (t.budget >= fee) offers.push({ teamId: t.id, teamName: t.name, fee });
    }
  }
  return offers.sort((a, b) => b.fee - a.fee).slice(0, 3);
}
export function acceptSale(state, rider, offer) {
  const seller = state.teams[rider.teamId], buyer = state.teams[offer.teamId];
  seller.riderIds = seller.riderIds.filter((id) => id !== rider.id);
  seller.devIds = (seller.devIds || []).filter((id) => id !== rider.id);
  seller.budget = round2(seller.budget + offer.fee);
  buyer.budget = round2(buyer.budget - offer.fee);   // the buyer actually pays — this used to mint money
  rider.teamId = buyer.id; rider.jersey = buyer.jersey; rider.transferListed = false;
  rider.salary = salaryOf(rider); rider.contractYears = Math.max(2, rider.contractYears || 2);
  if (!buyer.riderIds.includes(rider.id)) buyer.riderIds.push(rider.id);
  recountValues(state);
}
// season-end: squad-status expectations affect morale (leaders who never led, etc.)
function statusMoraleTick(state) {
  const t = state.teams[state.userTeamId];
  for (const id of t.riderIds) {
    const r = state.riders[id]; if (!r) continue;
    if ((r.status === "leader" || r.status === "coleader")) {
      if ((r.timesLed || 0) > 0) r.morale = clamp((r.morale ?? 65) + 4, 1, 99);
      else { r.morale = clamp((r.morale ?? 65) - 10, 1, 99); state.news.push({ season: state.season, date: 98, kind: "morale", text: `${r.short} expected to lead races as ${STATUS_LABEL[r.status]} and didn't.` }); }
    }
  }
}

// ============================================================================
//  SEASON TRANSITION
// ============================================================================
// ---- board objectives & confidence ----
export function setSeasonObjective(state) {
  const t = state.teams[state.userTeamId];
  const n = state.teams.filter((x) => x.tier === t.tier).length || 18;
  const tierTeams = state.teams.filter((x) => x.tier === t.tier).sort((a, b) => b.prestige - a.prestige);
  const pos = tierTeams.findIndex((x) => x.id === t.id);
  const pct = 1 - pos / Math.max(1, tierTeams.length - 1);   // 1 = strongest in tier
  let rankTarget = clamp(Math.round(n * (1 - pct) * 0.9) + 1, 1, n);
  const winsTarget = t.tier === "WorldTour" ? (pct > 0.7 ? 6 : pct > 0.4 ? 3 : 1) : t.tier === "ProTeam" ? (pct > 0.6 ? 3 : 1) : (pct > 0.6 ? 2 : 1);
  let text;
  if (t.tier !== "WorldTour" && pct > 0.72) { rankTarget = 3; text = `Win promotion: finish top 3 of the ${t.tier} and take ${winsTarget}+ wins.`; }
  else if (t.tier !== "Continental" && pct < 0.2) { rankTarget = n - 3; text = `Survive: stay out of the relegation places and show fight (${winsTarget}+ wins).`; }
  else text = `Finish ${rankTarget <= 3 ? "top " + rankTarget : "in the top " + rankTarget} of the ${t.tier}, and win ${winsTarget}+ race${winsTarget > 1 ? "s" : ""}.`;
  state.objective = { rankTarget, winsTarget, tier: t.tier, text, season: state.season };
  return state.objective;
}
export function objectiveProgress(state) {
  const o = state.objective, t = state.teams[state.userTeamId];
  if (!o) return null;
  const ranks = tierStandings(state, o.tier);
  const rank = (ranks.findIndex((x) => x.id === t.id) + 1) || ranks.length;
  let wins = 0; for (const id of t.riderIds) { const r = state.riders[id]; if (r) wins += (r.palmares || []).filter((p) => p.s === state.season && p.place === 1 && p.kind !== "jersey" && p.kind !== "u23").length; }
  return { rank, rankTarget: o.rankTarget, wins, winsTarget: o.winsTarget, n: ranks.length, text: o.text, onTrack: rank <= o.rankTarget && wins >= o.winsTarget };
}
export function evaluateObjective(state) {
  const o = state.objective, t = state.teams[state.userTeamId];
  if (!o) return null;
  const ranks = tierStandings(state, o.tier);
  const rank = (ranks.findIndex((x) => x.id === t.id) + 1) || ranks.length;
  let wins = 0; for (const id of t.riderIds) { const r = state.riders[id]; if (r) wins += (r.palmares || []).filter((p) => p.s === state.season && p.place === 1 && p.kind !== "jersey" && p.kind !== "u23").length; }
  const rankMet = rank > 0 && rank <= o.rankTarget, winsMet = wins >= o.winsTarget;
  const met = rankMet && winsMet, exceeded = met && (rank <= Math.max(1, o.rankTarget - 2) || wins >= o.winsTarget + 2), partial = !met && (rankMet || winsMet);
  const delta = exceeded ? 16 : met ? 9 : partial ? -2 : -14;
  state.boardConfidence = clamp(Math.round((state.boardConfidence ?? 62) + delta), 0, 100);
  const verdict = exceeded ? "exceeded" : met ? "met" : partial ? "missed" : "failed";
  const msg = exceeded ? `The board are delighted — you smashed the brief: ${rank}${rank === 1 ? "st" : rank === 2 ? "nd" : rank === 3 ? "rd" : "th"} in the ${o.tier}, ${wins} win${wins !== 1 ? "s" : ""}.`
    : met ? `Season objective met (${rank}th in the ${o.tier}, ${wins} win${wins !== 1 ? "s" : ""}). The board are pleased.`
    : partial ? `A mixed season (${rank}th, ${wins} win${wins !== 1 ? "s" : ""}) — the board expected more.`
    : `The board are unhappy: objectives missed (${rank}th, ${wins} win${wins !== 1 ? "s" : ""}).`;
  state.news.push({ season: state.season, date: 0, kind: "season", text: msg });
  return { verdict, rank, wins, rankTarget: o.rankTarget, winsTarget: o.winsTarget, delta, confidence: state.boardConfidence, text: o.text };
}
export function seasonChampions(state) {
  const r = Object.entries(state.rankings.rider).sort((a, b) => b[1] - a[1])[0];
  const t = Object.entries(state.rankings.team).sort((a, b) => b[1] - a[1])[0];
  return { riderLid: r ? +r[0] : null, riderPts: r ? Math.round(r[1]) : 0,
           teamId: t ? +t[0] : null, teamPts: t ? Math.round(t[1]) : 0 };
}
// ---- off-season as interactive phases (UI steps through them; endSeason runs them all) ----
function _suitor(state) {
  return (r) => { const bigger = state.teams.filter((t) => t.id !== state.userTeamId && t.prestige > state.teams[state.userTeamId].prestige);
    const t = bigger.length ? bigger[Math.floor(rngNext(state)() * bigger.length)] : state.teams[(state.userTeamId + 1) % state.teams.length]; return t.name; };
}
// ============================================================================
//  YOUTH INTAKE — FM-style annual academy crop: previewed a year ahead, then
//  revealed for the manager to pick from. Quality blends academy rating,
//  club prestige, scouting-region knowledge, and luck (golden generations).
// ============================================================================
const DEVCAP = 10;            // academy slots
const ROSTER_CAP = 25, ROSTER_MIN = 18;   // pro roster bounds
export function youthUpgradeCost(team) { return round2(0.6 + Math.max(0, (team.youthRating ?? 45) - 38) * 0.055); } // €m, rises with level
export function investYouth(state, team) {
  const cost = youthUpgradeCost(team);
  if ((team.youthRating ?? 45) >= 95) return { ok: false, reason: "Academy is already elite." };
  if ((team.budget ?? 0) < cost) return { ok: false, reason: "Not enough budget." };
  team.budget = round2(team.budget - cost);
  team.youthRating = clamp((team.youthRating ?? 45) + 3, 20, 95);
  return { ok: true, youthRating: team.youthRating, spent: cost };
}
function youthQuality(state, team, golden) {
  const yr = team.youthRating ?? 45;
  const reg = state.regionKnow ? (Object.values(state.regionKnow).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(state.regionKnow).length)) : 30;
  return clamp(0.34 + yr / 170 + (team.prestige - 40) / 240 + reg / 600 + (golden ? 0.26 : 0), 0.3, 1.12);
}
function pickIntakeNation(state, rng) {
  if (state.regionKnow && REGIONS.length) {
    const w = REGIONS.map((rg) => ({ rg, w: 7 + (state.regionKnow[rg.key] || 6) }));
    let tot = w.reduce((a, b) => a + b.w, 0), x = rng() * tot;
    for (const e of w) { x -= e.w; if (x <= 0) return e.rg.nats[Math.floor(rng() * e.rg.nats.length)]; }
  }
  return NATIONS[Math.floor(rng() * NATIONS.length)];
}
// a Head-of-Youth report on next season's crop — graded & hinted, never numeric
function previewIntake(state, team) {
  const rng = rngNext(state);
  const golden = rng() < 0.05 + (team.youthRating ?? 45) / 1100;
  const q = youthQuality(state, team, golden);
  const size = clamp(5 + Math.round((team.youthRating ?? 45) / 28) + (golden ? 2 : 0) + (rng() < 0.4 ? 1 : 0), 5, 10);
  const grade = golden ? "exceptional" : q > 0.78 ? "strong" : q > 0.62 ? "promising" : q > 0.5 ? "average" : "thin";
  const headline = { exceptional: "A golden generation — the best crop the academy has ever seen.", strong: "A very strong class coming through; real quality this year.", promising: "A promising group, with one or two who could make the grade.", average: "An ordinary year, but a few worth developing.", thin: "A thin year — temper your expectations for this intake." }[grade];
  const hints = [];
  if (golden || q > 0.8) hints.push("Our head of youth is unusually excited about one rider in particular.");
  hints.push(rng() < 0.5 ? "Good strength among the climbers this year." : "Some powerful engines for the classics and the flat.");
  if (q < 0.55) hints.push("Depth is lacking — it may come down to one or two names.");
  return { season: state.season + 1, profile: { q, size, golden }, grade, headline, hints };
}
// materialise the previewed crop into real (unsigned) prospects
function revealIntake(state, team, pend) {
  const { q, size, golden } = pend.profile;
  const crop = [];
  for (let i = 0; i < size; i++) {
    const nat = pickIntakeNation(state, rngNext(state));
    const qi = clamp(q + gaussish(rngNext(state)) * 0.12, 0.3, 1.16);
    const know = clamp(Math.round(28 + (team.youthRating ?? 45) * 0.42 + Math.abs(gaussish(rngNext(state))) * 10), 18, 92); // your own academy judges its kids fairly well
    const r = makeProspect(state, null, team.jersey, { quality: qi, nation: nat, know });
    r.status = "intake"; r._intakeFor = team.id; r.teamId = null;
    crop.push(r.id);
  }
  if (golden && !crop.some((id) => state.riders[id]._gem)) { const r = state.riders[crop[0]]; r._gem = true; r.ceiling = clamp(Math.max(r.ceiling, 88), r.overall, 99); }
  return crop;
}
export function signIntake(state, team, lid) {
  if ((team.devIds || []).length >= DEVCAP) return { ok: false, reason: "Academy full." };
  const r = state.riders[lid]; if (!r || r.status !== "intake") return { ok: false, reason: "Unavailable." };
  r.status = "prospect"; r.teamId = team.id; r.jersey = team.jersey; r.dev = true;
  team.devIds = team.devIds || []; team.devIds.push(lid);
  team.intakeCrop = (team.intakeCrop || []).filter((x) => x !== lid);
  return { ok: true };
}
export function closeIntake(state, team) {
  for (const lid of (team.intakeCrop || [])) {
    const r = state.riders[lid]; if (!r) continue;
    if ((r.potential || 0) >= 66 || r._gem) { r.status = "prospect"; r.teamId = null; r.dev = false; r.jersey = "#9b9b9b"; } // the good ones hit the open market
    else { delete state.riders[lid]; }                                                                                       // the rest drift out of the sport
  }
  team.intakeCrop = [];
}
// interactive (user) step: reveal last year's previewed crop, then preview next year's
export function osIntake(state) {
  const team = state.teams[state.userTeamId];
  const revealedPreview = team.pendingIntake ? { grade: team.pendingIntake.grade, headline: team.pendingIntake.headline, hints: team.pendingIntake.hints } : null;
  const crop = team.pendingIntake ? revealIntake(state, team, team.pendingIntake) : [];
  team.intakeCrop = crop;
  team.pendingIntake = previewIntake(state, team);
  return { crop, slots: DEVCAP - (team.devIds || []).length, revealedPreview,
    nextPreview: { grade: team.pendingIntake.grade, headline: team.pendingIntake.headline, hints: team.pendingIntake.hints },
    youthRating: team.youthRating, upgradeCost: youthUpgradeCost(team) };
}
// non-interactive (fast-sim) — auto-sign the best of the crop to fill the academy
function autoIntake(state, team) {
  if (!team.pendingIntake) { team.pendingIntake = previewIntake(state, team); return; }
  const crop = revealIntake(state, team, team.pendingIntake);
  crop.sort((a, b) => (state.riders[b].ceiling || 0) - (state.riders[a].ceiling || 0));
  team.intakeCrop = crop;
  let slots = DEVCAP - (team.devIds || []).length;
  for (const lid of crop) { if (slots <= 0) break; if (signIntake(state, team, lid).ok) slots--; }
  closeIntake(state, team);
  team.pendingIntake = previewIntake(state, team);
}

// ── STORYTELLING: a data-driven season report in a cycling-press voice ──────
// Pure: reads the just-finished season's rankings/results (call before osFinish
// resets them). Returns the recap, state-of-the-peloton, and award citations.
export function seasonStory(state, objective = null) {
  const ut = state.teams[state.userTeamId];
  const teams = teamStandings(state);
  const riders = riderStandings(state, 300);
  const champ = seasonChampions(state);
  const rN = (lid) => state.riders[lid]?.name || "—";
  const rS = (lid) => state.riders[lid]?.short || "—";
  const tN = (tid) => state.teams[tid]?.name || "—";

  const myTeamRank = teams.findIndex((t) => t.id === state.userTeamId) + 1;
  const myRiders = riders.filter((r) => state.riders[r.lid]?.teamId === state.userTeamId);
  const myBest = myRiders[0] || null;

  // this season's wins, counted from race result winners
  let myWins = 0, bestWin = null;
  for (const rid in state.results) {
    const rec = state.results[rid]; const w = state.riders[rec.winnerLid];
    if (w && w.teamId === state.userTeamId) {
      myWins++;
      const race = (state.calendar || []).find((c) => c.id === rec.raceId) || {};
      const prestige = race.prestige || rec.prestige || 0;
      if (!bestWin || prestige > bestWin.prestige) bestWin = { rider: w.short, race: rec.name, prestige, grand: !!rec.grand };
    }
  }

  const topTeams = teams.slice(0, 6).map((t, i) => ({ rank: i + 1, name: tN(t.id), pts: t.pts, tier: state.teams[t.id].tier, me: t.id === state.userTeamId }));
  const topRiders = riders.slice(0, 8).map((r, i) => ({ rank: i + 1, lid: r.lid, name: rN(r.lid), team: tN(state.riders[r.lid]?.teamId), pts: r.pts, me: state.riders[r.lid]?.teamId === state.userTeamId }));

  const awards = [];
  if (champ.riderLid != null) awards.push({ key: "rider", title: "Rider of the Year", name: rN(champ.riderLid), lid: champ.riderLid, sub: tN(state.riders[champ.riderLid]?.teamId), cite: `Topped the world rankings on ${champ.riderPts} pts.` });
  if (champ.teamId != null) awards.push({ key: "team", title: "Team of the Year", name: tN(champ.teamId), cite: `The peloton's most consistent squad — ${champ.teamPts} pts.`, me: champ.teamId === state.userTeamId });
  if (myBest) awards.push({ key: "mvp", title: `${ut.shortName || ut.name} · MVP`, name: rN(myBest.lid), lid: myBest.lid, cite: `Your leading scorer with ${myBest.pts} pts.`, me: true });

  const recap = [];
  if (champ.riderLid != null) recap.push(`The ${state.season} season is in the books, and ${rN(champ.riderLid)} of ${tN(state.riders[champ.riderLid]?.teamId)} stands above it all — world number one ahead of ${rN(riders[1]?.lid)} and ${rN(riders[2]?.lid)}.`);
  let arc = `${ut.name} closed the year ${ordn(myTeamRank)} of ${teams.length}`;
  arc += myWins ? `, with ${myWins} win${myWins !== 1 ? "s" : ""} to show for it` : ", still hunting a first win of the campaign";
  if (bestWin && bestWin.prestige >= 50) arc += ` — none bigger than ${bestWin.rider}'s ride at ${bestWin.race}`;
  arc += ".";
  recap.push(arc);
  if (myBest) recap.push(`${rN(myBest.lid)} led the line for the team, the squad's top points scorer across the season.`);
  const v = objective?.verdict;
  const vtxt = { exceeded: "In the boardroom there are smiles: the brief was beaten.", met: "The board got what they asked for — objective met.", missed: "The board wanted more; the target slipped through their fingers.", failed: "Patience is thin upstairs — the season fell well short of the brief." }[v];
  if (vtxt) recap.push(vtxt);

  return { season: state.season, headline: `${state.season} Season Review`, topTeams, topRiders, awards, recap,
    team: { rank: myTeamRank, of: teams.length, wins: myWins, bestWin, mvpLid: myBest ? myBest.lid : null } };
}

export function osReview(state) {
  const ut0 = state.teams[state.userTeamId]; const tierBefore = ut0.tier;
  flushWorld(state);
  const objective = evaluateObjective(state);   // judged on the season just completed, before reshuffling
  settleFinances(state);
  const finance = { budget: state.teams[state.userTeamId].budget, prizeYTD: state.teams[state.userTeamId].prizeYTD, salaryTotal: state.teams[state.userTeamId].salaryTotal };
  promoteRelegate(state);
  const champ = seasonChampions(state);
  state.history.push({ season: state.season, champion: champ.riderLid, championName: state.riders[champ.riderLid]?.name, teamChampion: champ.teamId, teamChampionName: state.teams[champ.teamId]?.name });
  statusMoraleTick(state);
  seasonPersonalityTick(state, rngNext(state), _suitor(state));
  const ut = state.teams[state.userTeamId];
  return { champRider: state.riders[champ.riderLid]?.name, champRiderLid: champ.riderLid, champTeam: state.teams[champ.teamId]?.name,
    tierBefore, tierAfter: ut.tier, moved: tierBefore !== ut.tier, finance, objective, boardConfidence: state.boardConfidence,
    sponsorUnhappy: (ut.sponsors || []).filter((sp) => sp.happy === false).map((sp) => sp.name) };
}
export function osYouthRaces(state) { return runYouthSeason(state); }   // build prominence; user headhunt window opens after
export function osYouthClose(state) { aiHeadhunt(state); }              // rivals grab the remaining hot youth
export function youthRaces() { return YOUTH_RACES.map(([name, ft, prestige]) => ({ name, ft, prestige })); }
export function toggleYouthRace(state, team, name) {
  team.youthCalendar = team.youthCalendar || YOUTH_RACES.map((r) => r[0]);
  const i = team.youthCalendar.indexOf(name);
  if (i >= 0) team.youthCalendar.splice(i, 1); else team.youthCalendar.push(name);
  return team.youthCalendar;
}
export function osDevelop(state, trainingFocus = {}) {
  const altN = (state.altitudeCamp || []).length;
  if (altN && state.teams[state.userTeamId].budget != null) state.teams[state.userTeamId].budget = Math.round((state.teams[state.userTeamId].budget - altN * ALT_COST) * 100) / 100;
  developAll(state, trainingFocus);
  const mine = (state.teams[state.userTeamId].riderIds || []).concat(state.teams[state.userTeamId].devIds || []).map((id) => state.riders[id]).filter(Boolean);
  const report = mine.map((r) => ({ lid: r.id, short: r.short, archetype: r.archetype, age: r.age, delta: r.lastGrowth || 0, dWkg: r.lastWkg || 0, breakout: !!r._breakout, slump: !!r._slump, overall: r.overall, dev: !!r.dev, alt: !!r.trainedAlt })).sort((a, b) => b.delta - a.delta);
  for (const r of mine) { if (r._breakout && (r.lastGrowth || 0) >= 3) state.news.push({ season: state.season, date: 0, kind: "season", text: `BREAKTHROUGH — ${r.name} takes a leap (+${r.lastGrowth}, now ${r.overall} OVR).` }); }
  const leagueBreakouts = Object.values(state.riders).filter((r) => r._breakout && r.teamId !== state.userTeamId && r.age <= 24).sort((a, b) => (b.lastGrowth || 0) - (a.lastGrowth || 0)).slice(0, 5).map((r) => ({ short: r.short, team: state.teams[r.teamId]?.name, delta: r.lastGrowth, overall: r.overall }));
  // winter movers, peloton-wide — the storytelling layer for the development step
  const movers = Object.values(state.riders).filter((r) => r.teamId != null).map((r) => ({ lid: r.id, name: r.name, short: r.short, team: state.teams[r.teamId]?.name, mine: r.teamId === state.userTeamId, delta: Math.round(r.lastGrowth || 0), overall: r.overall, age: r.age, breakout: !!r._breakout, bust: !!r._bust, late: !!r._lateBloom }));
  const risers = movers.filter((m) => m.delta >= 3).sort((a, b) => b.delta - a.delta).slice(0, 8);
  const fallers = movers.filter((m) => m.delta <= -3).sort((a, b) => a.delta - b.delta).slice(0, 5);
  const lateBlooms = movers.filter((m) => m.late && m.delta >= 2 && m.age >= 26).sort((a, b) => b.delta - a.delta).slice(0, 4);
  const stalled = movers.filter((m) => m.bust && m.age <= 24 && m.delta <= 1 && (state.riders[m.lid]?.ceiling - m.overall) >= 8).slice(0, 4);
  return { report, leagueBreakouts, risers, fallers, lateBlooms, stalled };
}
export function osTransfers(state) {
  state._osRetire = []; state._osMoves = [];
  retireAndRegen(state);
  const tributes = (state._osRetire || []).slice().sort((a, b) => (b.wins - a.wins) || (b.peakOverall - a.peakOverall));
  const retired = state.news.filter((n) => n.season === state.season && n.kind === "retire").slice(-12).map((n) => n.text);
  expireContracts(state);
  aiTransfers(state);
  // user riders whose contracts expired without a renewal leave on a free at the end of the window
  { const ut = state.teams[state.userTeamId];
    for (const id of [...ut.riderIds]) {
      const r = state.riders[id];
      if (r && r._expiring) { r._expiring = false; releaseFrom(state, ut, r); r.salary = salaryOf(r);
        state.news.push({ season: state.season, date: 99, kind: "season", text: `${r.name} leaves on a free transfer — his contract was allowed to run out.` }); }
    } }
  renewSponsors(state);
  const moves = (state._osMoves || []).sort((a, b) => b.overall - a.overall).slice(0, 8);
  return { retired, tributes, moves };
}
export function osFinish(state) {
  prospectOffSeason(state);   // judge the manager's expectation promises + agitate over-ripe prospects, before rolling the season over
  state.season += 1; state.calIndex = 0; state.phase = "racing";
  for (const id in state.riders) { const r = state.riders[id]; r.fatigue = 0; r._gtSeason = 0; r._fatWeek = 0;   // winter rest — legs reset for the new season
    if (r.teamId != null) { r.career = r.career || { wins: 0, podiums: 0, top10: 0, points: 0, seasons: 0 }; r.career.points += Math.round(state.rankings.rider[id] || 0); r.career.seasons += 1; } }
  state.rankings = { rider: {}, team: {} };
  state.teams.forEach((t) => (t.prizeYTD = 0));
  state.results = {};
  rebuildCalendars(state);
  recountValues(state);
  planSeason(state);
  setSeasonObjective(state);
  const ut = state.teams[state.userTeamId];
  state.news.push({ season: state.season, date: 0, kind: "season", text: `${state.season} season begins — ${ut.tier}. Board brief: ${state.objective?.text || ""}` });
  return state;
}
// run the whole off-season in one go (non-interactive path: fast-sim / AI)
export function endSeason(state, trainingFocus = {}) {
  osReview(state); osYouthRaces(state); osYouthClose(state); osDevelop(state, trainingFocus);
  autoIntake(state, state.teams[state.userTeamId]);   // non-interactive: auto-sign the best of the crop
  osTransfers(state); osFinish(state);
  return state;
}

// convenience: current standings arrays for UI
export function riderStandings(state, n = 50) {
  return Object.entries(state.rankings.rider).map(([lid, pts]) => ({ lid: +lid, pts: Math.round(pts) }))
    .sort((a, b) => b.pts - a.pts).slice(0, n);
}
export function teamStandings(state) {
  return state.teams.map((t) => ({ id: t.id, pts: Math.round(state.rankings.team[t.id] || 0) }))
    .sort((a, b) => b.pts - a.pts);
}
export { TIERS };
export function tierStandings(state, tier) {
  return state.teams.filter((t) => t.tier === tier)
    .map((t) => ({ id: t.id, pts: Math.round(state.rankings.team[t.id] || 0) }))
    .sort((a, b) => b.pts - a.pts);
}
export { fmtTime };

// ============================================================================
//  YOUTH / DEVELOPMENT SQUAD API
// ============================================================================
export function devSquad(state, teamId) {
  return (state.teams[teamId].devIds || []).map((id) => state.riders[id]).filter(Boolean);
}
export function prospectPool(state, n = 30) {
  return Object.values(state.riders)
    .filter((r) => r.teamId == null && r.age <= 23)
    .sort((a, b) => b.potential - a.potential || b.overall - a.overall).slice(0, n);
}
export function promoteToPro(state, team, rider, years = 3) {
  const rd = promotionReadiness(rider);
  team.devIds = (team.devIds || []).filter((id) => id !== rider.id);
  rider.dev = false; rider.teamId = team.id; rider.jersey = team.jersey;
  rider.salary = salaryOf(rider); rider.contractYears = years; rider._expiring = false;
  if (team.id === state.userTeamId) rider.know = 100;
  if (!team.riderIds.includes(rider.id)) team.riderIds.push(rider.id);
  if (team.id === state.userTeamId) {   // timing matters: too soon rattles them, ready they thrive
    if (rd.score < 0.4) { rider.confidence = clamp((rider.confidence ?? 60) - 12, 0, 100); rider._devDrag = (rider._devDrag || 0) + 2.5;
      state.news.push({ season: state.season, date: 0, kind: "morale", text: `${rider.short} has been thrown into the pro ranks before they were ready — it may stall their progress.` }); }
    else if (rd.score >= 0.8) { rider.confidence = clamp((rider.confidence ?? 60) + 8, 0, 100);
      state.news.push({ season: state.season, date: 0, kind: "breakthrough", text: `${rider.short} steps up to the pros ready to make their mark.` }); }
  }
  recountValues(state);
  return rider;
}
export function demoteToDev(state, team, rider) {
  team.riderIds = team.riderIds.filter((id) => id !== rider.id);
  rider.dev = true; rider.salary = round2(0.08 + rider.overall / 900);
  if (!team.devIds.includes(rider.id)) team.devIds.push(rider.id);
  recountValues(state);
  return rider;
}
export function signToDev(state, team, rider, years = 3) {
  rider.dev = true; rider.teamId = team.id; rider.jersey = team.jersey;
  rider.salary = round2(0.06 + rider.overall / 1000); rider.contractYears = years; rider._expiring = false;
  if (team.id === state.userTeamId) rider.know = Math.max(rider.know || 0, 80);
  if (!team.devIds.includes(rider.id)) team.devIds.push(rider.id);
  return rider;
}

// ---- youth racing: U23 calendar that builds prominence + palmares ----
const YOUTH_RACES = [
  ["U23 World Championships", "hilly", 62], ["Avenir Tour", "summit", 56], ["U23 Roubaix", "flat", 46],
  ["Giro Next Gen", "summit", 52], ["Nations U23 Cup", "rolling", 42], ["U23 Flèche", "uphill_short", 44],
];
export function runYouthSeason(state) {
  const field = Object.values(state.riders).filter((r) => r.age <= 21);
  state.youthResults = [];
  if (field.length < 6) return state.youthResults;
  const userId = state.userTeamId;
  const userCal = new Set((state.teams[userId]?.youthCalendar) ?? YOUTH_RACES.map((r) => r[0]));   // your prospects only contest the races you enter them in
  for (const [name, ft, prestige] of YOUTH_RACES) {
    const runField = field.filter((r) => r.teamId !== userId || userCal.has(name));   // your kids skip un-entered races (they rest)
    const scored = runField.map((r) => ({ lid: r.id, s: fitFor(r, ft) + (r.form ?? 60) * 0.08 + gaussish(rngNext(state)) * 22 }))
      .sort((a, b) => b.s - a.s);
    const top = scored.slice(0, 12).map((x, i) => ({ lid: x.lid, place: i + 1 }));
    top.forEach((p) => { const r = state.riders[p.lid]; if (!r) return;
      const gain = (p.place === 1 ? 11 : p.place <= 3 ? 6 : p.place <= 6 ? 3 : 1) * (prestige / 52);
      r.prominence = clamp((r.prominence || 0) + gain, 0, 100);
      if (p.place <= 3) { r.palmares = r.palmares || []; r.palmares.push({ s: state.season, race: name, place: p.place, kind: "u23", prestige }); }
      if (p.place === 1) r._youthWin = (r._youthWin || 0) + 1;     // racing sharpens them (small dev boost)
      if (r.teamId === userId) {                                   // your prospects gain experience + can prime a breakout from a big U23 result
        r.form = clamp((r.form ?? 60) + (p.place <= 6 ? 3 : 1), 1, 99);
        if (p.place <= 3 && rngNext(state)() < 0.2) { r._leapPrimed = state.season; state.news.push({ season: state.season, date: 0, kind: "breakthrough", text: `${r.short} lit up the ${name} — the staff think a step up is coming.` }); }
      }
    });
    // racing load: your prospects who lined up risk the occasional knock — more races entered, more exposure
    if (userCal.has(name)) for (const r of runField) { if (r.teamId === userId && rngNext(state)() < 0.05) { const add = 1 + Math.floor(rngNext(state)() * 2); r.out = (r.out || 0) + add; r.confidence = clamp((r.confidence ?? 60) - 4, 0, 100); state.news.push({ season: state.season, date: 0, kind: "injury", text: `${r.short} picked up a knock racing the ${name} — out ${add}.` }); } }
    state.youthResults.push({ name, ft, prestige, top: top.slice(0, 6) });
  }
  return state.youthResults;
}

// rival academies grab the hot free-agent youth during the off-season
function aiHeadhunt(state) {
  const shortSet = new Set(state.shortlist || []);
  const freeYouth = Object.values(state.riders)
    .filter((r) => r.teamId == null && r.age <= 21)
    .sort((a, b) => ((b.prominence || 0) + b.potential) - ((a.prominence || 0) + a.potential));
  const teams = () => state.teams.filter((t) => t.id !== state.userTeamId && (t.devIds || []).length < DEVCAP);
  for (const r of freeYouth.slice(0, 16)) {
    const cands = teams().filter((t) => t.prestige > (r.prominence || 0) * 0.42).sort((a, b) => b.prestige - a.prestige);
    const onList = shortSet.has(r.id);
    for (const t of cands) {
      if (rngNext(state)() < (onList ? 0.6 : 0.42)) {   // rivals move faster on talent you've flagged
        signToDev(state, t, r);
        if (onList) state.news.push({ season: state.season, date: 0, kind: "scout", text: `Missed out: ${r.name}, on your shortlist, has signed for ${t.name}.` });
        break;
      }
    }
  }
}

// the user headhunts a prospect — popular youth resist smaller teams and may be sniped
export function recruitProspect(state, team, rider) {
  if (rider.teamId != null) return { ok: false, reason: "already signed" };
  if ((team.devIds || []).length >= DEVCAP) return { ok: false, reason: "academy full" };
  const know = rider.know || 0;
  let p = clamp(0.46 + (team.prestige - (rider.prominence || 0) * 0.7) / 70 + (know - 40) / 220, 0.05, 0.95);
  if (rngNext(state)() < p) { signToDev(state, team, rider); return { ok: true, p }; }
  // failed: a bigger rival may pounce
  if (rngNext(state)() < 0.5) {
    const rivals = state.teams.filter((t) => t.id !== team.id && (t.devIds || []).length < DEVCAP && t.prestige > (rider.prominence || 0) * 0.5).sort((a, b) => b.prestige - a.prestige);
    if (rivals.length) { signToDev(state, rivals[0], rider); return { ok: false, sniped: rivals[0].name, p }; }
  }
  return { ok: false, p };
}
export function releaseDev(state, team, rider) {
  team.devIds = (team.devIds || []).filter((id) => id !== rider.id);
  rider.teamId = null; rider.dev = false; rider.contractYears = 0; rider.salary = salaryOf(rider);
}
export function setProgram(state, rider, program) { rider.program = program; }
// displayed potential as an uncertainty band that narrows toward peak age
export function potentialBand(r) {
  const spread = Math.round(clamp((r.peak - r.age) * 1.0 + 2, 0, 11));
  return { low: clamp((r.potential || r.overall) - Math.round(spread * 0.7), r.overall, 99),
           high: clamp((r.potential || r.overall) + spread, r.overall, 99), spread };
}

// ============================================================================
//  SCOUTING — staff, assignments, and knowledge-gated estimates
// ============================================================================
export function userScouts(state) { return (state.teams[state.userTeamId] && state.teams[state.userTeamId].scouts) || []; }
export function scoutMarket(state) { return state.scoutMarket || []; }
export function hireScout(state, scoutId) {
  const i = (state.scoutMarket || []).findIndex((s) => s.id === scoutId); if (i < 0) return null;
  const sc = state.scoutMarket.splice(i, 1)[0];
  state.teams[state.userTeamId].scouts.push(sc);
  state.scoutMarket.push(makeScout(state)); // refresh the market
  return sc;
}
export function fireScout(state, scoutId) {
  const t = state.teams[state.userTeamId];
  t.scouts = (t.scouts || []).filter((s) => s.id !== scoutId);
}
export function assignScout(state, scoutId, assign) {
  const sc = userScouts(state).find((s) => s.id === scoutId); if (sc) sc.assign = assign || null;
}
export function shortlist(state) { return (state.shortlist || []).map((lid) => state.riders[lid]).filter(Boolean); }
export function toggleShortlist(state, lid) {
  state.shortlist = state.shortlist || [];
  const i = state.shortlist.indexOf(lid);
  if (i >= 0) state.shortlist.splice(i, 1); else state.shortlist.push(lid);
}

// --- scouting opportunity model: recommended regions + auto-assign ----------
// Scores every macro-region by  (100 - know%) x talentDensity x regionTalentPool.
// talentDensity is a function of what you can already see (identified prospects +
// known young riders) with a floor of 1; regionTalentPool is the knowledge-
// independent latent base (count of u23 riders mapping to the region) so a deep
// but unscouted patch still scores. Neither field exists on the data model, so
// both are derived here from the rider population.
function _oppReason(o) {
  const tier = o.know >= 65 ? "well-mapped" : o.know >= 45 ? "fairly known" : o.know >= 28 ? "patchy intel" : o.know >= 10 ? "barely scouted" : "uncharted";
  if (o.prospects > 0) return `${o.prospects} prospect${o.prospects > 1 ? "s" : ""} surfacing · ${tier} (${o.know}%)`;
  if (o.knownYoung > 0) return `${o.knownYoung} young rider${o.knownYoung > 1 ? "s" : ""} on file · ${tier} (${o.know}%)`;
  return `Deep talent base, still ${tier} (${o.know}%)`;
}
export function regionOpportunities(state) {
  const ut = state.userTeamId;
  const rk = state.regionKnow || {};
  const staffed = new Set(userScouts(state).filter((s) => s.assign && s.assign.type === "region").map((s) => s.assign.region));
  const byRegion = {};
  for (const r of Object.values(state.riders)) {
    if (r.teamId === ut) continue;
    const key = NATION_REGION[r.nation] || "world";
    (byRegion[key] = byRegion[key] || []).push(r);
  }
  const rows = REGIONS.map((rg) => {
    const ridersIn = byRegion[rg.key] || [];
    const young = ridersIn.filter((r) => r.age <= 23);
    const knownYoung = young.filter((r) => Math.max(r.know || 0, r._regionKnow || 0) >= 22);
    const prospects = knownYoung.filter((r) => { const kp = knownPotential(r); return !kp.unknown && starOf(kp.hi) >= 3; });
    const know = Math.round(rk[rg.key] || 0);
    const talentDensity = 1 + prospects.length * 2 + knownYoung.length * 0.6;   // what you can see (>=1 floor)
    const talentPool = 1 + young.length * 0.5;                                   // latent base, knowledge-independent
    const score = Math.round((100 - know) * talentDensity * talentPool);
    return { key: rg.key, name: rg.name, nats: rg.nats.slice(), know, pool: young.length,
      knownYoung: knownYoung.length, prospects: prospects.length,
      talentDensity: Math.round(talentDensity * 10) / 10, talentPool: Math.round(talentPool * 10) / 10,
      score, staffed: staffed.has(rg.key), recommended: false, reason: "" };
  });
  const ranked = rows.filter((r) => !r.staffed && r.score > 0).sort((a, b) => b.score - a.score);
  for (let i = 0; i < Math.min(3, ranked.length); i++) { ranked[i].recommended = true; ranked[i].reason = _oppReason(ranked[i]); }
  return rows.sort((a, b) => b.score - a.score);
}
// "best idle scout" = highest-JPP unassigned; fallback = least-utilised assigned
// (a region scout in the most-saturated patch, i.e. lowest marginal knowledge gain).
export function bestIdleScout(state) {
  const scouts = userScouts(state);
  const idle = scouts.filter((s) => !s.assign).sort((a, b) => b.jpp - a.jpp);
  if (idle.length) return idle[0];
  const rk = state.regionKnow || {};
  const assigned = scouts.filter((s) => s.assign);
  if (!assigned.length) return null;
  return assigned.slice().sort((a, b) => {
    const au = a.assign.type === "region" ? (rk[a.assign.region] || 0) : -1;   // rider-focus scouts are "busy"
    const bu = b.assign.type === "region" ? (rk[b.assign.region] || 0) : -1;
    return bu - au;
  })[0];
}
export function sendBestIdleScout(state, regionKey) {
  const sc = bestIdleScout(state);
  if (!sc) return null;
  assignScout(state, sc.id, { type: "region", region: regionKey });
  return sc;
}
// Distribute idle scouts: highest-JPP first, each to the highest-opportunity
// UNSTAFFED region; spread across distinct regions (covering recommended ones
// first) before any double-stacking; tie-break toward a region the scout already
// knows. Returns a report of what it did.
export function autoAssignScouts(state) {
  const idle = userScouts(state).filter((s) => !s.assign).sort((a, b) => b.jpp - a.jpp);
  const report = [];
  if (!idle.length) return report;
  const avail = regionOpportunities(state).filter((o) => !o.staffed && o.score > 0);
  if (!avail.length) return report;
  const used = new Set();
  for (const sc of idle) {
    let pool = avail.filter((o) => !used.has(o.key));
    if (!pool.length) pool = avail.slice();                                     // every region covered -> allow stacking
    pool.sort((a, b) => b.score - a.score);
    const top = pool[0].score;
    const contenders = pool.filter((o) => o.score >= top * 0.92);               // near-ties resolved by familiarity
    contenders.sort((a, b) => ((sc.regionFam || {})[b.key] || 0) - ((sc.regionFam || {})[a.key] || 0) || b.score - a.score);
    const best = contenders[0];
    assignScout(state, sc.id, { type: "region", region: best.key });
    used.add(best.key);
    const fam = Math.round((sc.regionFam || {})[best.key] || 0);
    report.push({ scoutId: sc.id, scoutName: sc.name, region: best.key, regionName: best.name,
      reason: fam >= 35 ? `knows ${best.name} well` : best.recommended ? "top opportunity" : "best open patch" });
  }
  return report;
}
// riders your scouts have gathered enough on to report (excludes your own squad)
export function scoutReports(state, n = 40) {
  const ut = state.userTeamId;
  return Object.values(state.riders)
    .filter((r) => r.teamId !== ut && Math.max(r.know ?? 0, r._regionKnow ?? 0) >= 18)
    .map((r) => ({ r, est: knownPotential(r) }))
    .sort((a, b) => (b.est.mid || 0) - (a.est.mid || 0) || (b.r.know - a.r.know))
    .slice(0, n);
}

// current-ability estimate; error shrinks toward 0 as knowledge -> 100
export function knownOverall(r) {
  const k = Math.max(r.know ?? 100, r._regionKnow ?? 0);
  if (k >= 92) return { lo: r.overall, hi: r.overall, mid: r.overall, exact: true };
  const err = Math.round((1 - k / 100) * 13 + 2);
  return { lo: clamp(r.overall - err, 1, 99), hi: clamp(r.overall + err, 1, 99), mid: r.overall, err, exact: false };
}
// potential estimate: converges to the (hidden) true ceiling as knowledge rises
export function knownPotential(r) {
  const k = Math.max(r.know ?? 100, r._regionKnow ?? 0);
  if (k < 12) return { unknown: true, conf: Math.round(k) };
  const ceil = r.ceiling ?? r.potential ?? r.overall;
  const est = Math.round(ceil * (k / 100) + (r.potential ?? r.overall) * (1 - k / 100));
  const err = Math.round((1 - k / 100) * 12 + clamp(r.peak - r.age, 0, 8) * 0.6 + 1);
  return { lo: clamp(est - err, r.overall, 99), hi: clamp(est + err, r.overall, 99), mid: clamp(est, r.overall, 99), err, conf: Math.round(k) };
}
// 0.5–5 star scale (40 -> 0.5★, 100 -> 5★)
export const starOf = (v) => clamp(Math.round((v - 40) / 60 * 10) / 2, 0.5, 5);

// ============================================================================
//  PHASE 2 — RACE PROFILES · FIT · FAVORITES · TEAM OUTLOOK
// ============================================================================
const SECTORS = {
  "Paris-Roubaix": [
    { kind: "cobble", name: "Trouée d'Arenberg", toFinish: 95, lengthKm: 2.4, diff: 5, crash: 5, affects: ["cobbles", "positioning", "bikehandling"] },
    { kind: "cobble", name: "Mons-en-Pévèle", toFinish: 48, lengthKm: 3.0, diff: 5, crash: 4, affects: ["cobbles", "stamina", "positioning"] },
    { kind: "cobble", name: "Carrefour de l'Arbre", toFinish: 17, lengthKm: 2.1, diff: 5, crash: 4, affects: ["cobbles", "positioning", "stamina"] },
  ],
  "Tour of Flanders": [
    { kind: "berg", name: "Koppenberg", toFinish: 45, lengthKm: 0.6, grad: 11.6, maxGrad: 22, diff: 5, crash: 3, affects: ["punch", "cobbles", "positioning"] },
    { kind: "berg", name: "Oude Kwaremont", toFinish: 17, lengthKm: 2.2, grad: 4.0, maxGrad: 11, diff: 4, crash: 3, affects: ["cobbles", "punch", "stamina"] },
    { kind: "berg", name: "Paterberg", toFinish: 13, lengthKm: 0.4, grad: 12.9, maxGrad: 20, diff: 5, crash: 3, affects: ["punch", "cobbles"] },
  ],
  "Milan-San Remo": [
    { kind: "climb", name: "Cipressa", toFinish: 22, lengthKm: 5.6, grad: 4.1, cat: "3", diff: 2, affects: ["positioning", "stamina"] },
    { kind: "climb", name: "Poggio di Sanremo", toFinish: 6, lengthKm: 3.7, grad: 3.7, maxGrad: 8, cat: "3", diff: 3, affects: ["punch", "positioning"] },
    { kind: "descent", name: "Poggio descent", toFinish: 3, lengthKm: 3.0, diff: 4, crash: 3, affects: ["descending", "bikehandling"] },
  ],
  "Liege-Bastogne-Liege": [
    { kind: "climb", name: "Côte de La Redoute", toFinish: 34, lengthKm: 1.6, grad: 9.4, maxGrad: 20, cat: "2", diff: 4, affects: ["punch", "climbing", "stamina"] },
    { kind: "climb", name: "La Roche-aux-Faucons", toFinish: 13, lengthKm: 1.3, grad: 11, maxGrad: 17, cat: "2", diff: 5, affects: ["punch", "climbing", "positioning"] },
    { kind: "climb", name: "Côte de Saint-Nicolas", toFinish: 6, lengthKm: 1.2, grad: 8.6, cat: "3", diff: 3, affects: ["punch", "climbing"] },
  ],
  "Strade Bianche": [
    { kind: "gravel", name: "Monte Sante Marie", toFinish: 50, lengthKm: 11.5, diff: 5, crash: 4, affects: ["gravel", "bikehandling", "stamina"] },
    { kind: "gravel", name: "Colle Pinzuto", toFinish: 18, lengthKm: 2.4, diff: 4, crash: 3, affects: ["gravel", "punch", "bikehandling"] },
    { kind: "climb", name: "Via Santa Caterina (Siena)", toFinish: 0.3, lengthKm: 0.5, grad: 11, maxGrad: 16, diff: 4, affects: ["punch", "positioning"] },
  ],
  "Il Lombardia": [
    { kind: "climb", name: "Madonna del Ghisallo", toFinish: 48, lengthKm: 8.6, grad: 6.2, cat: "1", diff: 3, affects: ["climbing", "stamina"] },
    { kind: "climb", name: "Civiglio", toFinish: 17, lengthKm: 4.2, grad: 9.7, maxGrad: 14, cat: "1", diff: 4, affects: ["climbing", "punch"] },
    { kind: "descent", name: "Civiglio descent", toFinish: 13, lengthKm: 5.0, diff: 4, crash: 3, affects: ["descending", "bikehandling"] },
  ],
  "La Fleche Wallonne": [
    { kind: "climb", name: "Mur de Huy", toFinish: 0.0, lengthKm: 1.3, grad: 9.6, maxGrad: 19, cat: "2", diff: 5, affects: ["punch", "positioning"] },
  ],
  "Amstel Gold Race": [
    { kind: "climb", name: "Cauberg", toFinish: 19, lengthKm: 1.2, grad: 6.5, maxGrad: 12, cat: "3", diff: 3, affects: ["punch", "positioning"] },
    { kind: "climb", name: "Bemelerberg", toFinish: 5, lengthKm: 0.9, grad: 5, cat: "4", diff: 2, affects: ["punch"] },
  ],
  "Gent-Wevelgem": [
    { kind: "berg", name: "Kemmelberg", toFinish: 34, lengthKm: 0.5, grad: 9, maxGrad: 23, diff: 4, crash: 3, affects: ["cobbles", "punch", "positioning"] },
  ],
  "E3 Saxo Classic": [
    { kind: "berg", name: "Oude Kwaremont", toFinish: 39, lengthKm: 2.2, grad: 4, maxGrad: 11, diff: 4, affects: ["cobbles", "punch"] },
    { kind: "berg", name: "Paterberg", toFinish: 35, lengthKm: 0.4, grad: 12.9, maxGrad: 20, diff: 5, affects: ["punch", "cobbles"] },
  ],
};
const RACE_IDENTITY = {
  "Paris-Roubaix": { text: "A brutal cobbled monument. The decisive pavé sectors come late, so positioning, cobbles, endurance and bike handling matter far more than pure sprint speed — riders with weak stamina or positioning lose contact before the finale.", tactics: ["Fight for position before each sector", "Stay upright — crash & mechanical risk is high", "Raw power over finesse on the stones"], keyAbil: ["cobbles", "positioning", "stamina", "bikehandling", "flat"] },
  "Tour of Flanders": { text: "Steep cobbled bergs in quick succession. Repeated punchy efforts on Koppenberg/Paterberg-type walls reward cobbles, punch, positioning and endurance — a war of attrition decided by who can still kick after five hours.", tactics: ["Save matches for the final bergs", "Position before the climbs, not on them", "Repeated punch beats one big effort"], keyAbil: ["cobbles", "punch", "positioning", "stamina", "bikehandling"] },
  "Milan-San Remo": { text: "The longest day on the calendar — nearly 300km of patience before the Poggio. Suits endurance sprinters, attackers, puncheurs and sharp descenders who survive the climb and time the run to the line.", tactics: ["Survive the Poggio, win the dash", "Descenders can steal it on the drop", "Conserve for 280km, gamble in the last 10"], keyAbil: ["sprint", "stamina", "punch", "descending", "positioning"] },
  "Liege-Bastogne-Liege": { text: "The oldest Monument — relentless Ardennes climbs and a steep finale. Favours punchy climbers with elite endurance; pure sprinters are long dropped, while punch, climbing, stamina and tactical reading decide it.", tactics: ["Punch on the late climbs", "Endurance is the filter", "Read the decisive move"], keyAbil: ["punch", "climbing", "stamina", "positioning", "attacking"] },
  "Il Lombardia": { text: "The race of the falling leaves — long, mountainous, with treacherous descents. Climbing, descending, endurance and late-race strength win it; the selection is made uphill and confirmed on the way down.", tactics: ["Climb to make the split", "Descend to hold or gain it", "Endurance into the finale"], keyAbil: ["climbing", "descending", "stamina", "positioning", "punch"] },
  "Strade Bianche": { text: "White-gravel Tuscan sectors and short brutal ramps. Rewards gravel skill, punch, climbing, bike handling, positioning and aggression — a dusty selection long before the steep climb into Siena.", tactics: ["Front of the bunch into every sector", "Aggression pays — attack the gravel", "Handle the bike, save energy"], keyAbil: ["gravel", "punch", "climbing", "bikehandling", "positioning"] },
  "Amstel Gold Race": { text: "A nervous Limburg puzzle of short walls. Punch, positioning and repeated accelerations matter; timing the final move is everything.", tactics: ["Position for every wall", "Punch again and again", "Time the last kick"], keyAbil: ["punch", "positioning", "climbing", "stamina"] },
  "La Fleche Wallonne": { text: "Decided in one explosive effort up the Mur de Huy. Almost pure punch and positioning — too early and you blow, too late and you lose.", tactics: ["Hold position to the Mur", "One perfect effort", "Patience, then explode"], keyAbil: ["punch", "positioning", "climbing"] },
  "Gent-Wevelgem": { text: "Exposed Flanders roads and crosswinds split the bunch into echelons. Flat power, positioning and cobbles survival matter; the front group contests a reduced sprint.", tactics: ["Make the front echelon", "Survive cobbles & crosswind", "Reduced bunch kick"], keyAbil: ["flat", "positioning", "cobbles", "sprint", "stamina"] },
  "E3 Saxo Classic": { text: "A Flanders dress rehearsal — bergs and cobbles in a compact, explosive day. Cobbles, punch and positioning decide the early-season pecking order.", tactics: ["Position into the bergs", "Punch on the cobbled climbs", "Small group to the line"], keyAbil: ["cobbles", "punch", "positioning", "stamina"] },
};
const ABIL_LABEL = { climbing: "climbing", timetrial: "time-trial", sprint: "sprint", punch: "punch", cobbles: "cobbles", gravel: "gravel", flat: "flat power", descending: "descending", positioning: "positioning", stamina: "endurance", bikehandling: "bike handling", recovery: "recovery", attacking: "aggression" };
function topTerrainAbil(T) {
  const map = { climb: "climbing", tt: "timetrial", sprint: "sprint", punch: "punch", cobbles: "cobbles", gravel: "gravel", flat: "flat", descent: "descending" };
  return Object.entries(T).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => map[k]).filter(Boolean);
}
function preferredArchetypes(T, id) {
  const s = { gc: T.climb * 0.6 + T.tt * 0.4, climber: T.climb, sprinter: T.sprint, puncheur: T.punch * 0.7 + T.climb * 0.3, rouleur: T.cobbles * 0.6 + T.flat * 0.3 + T.tt * 0.2, leadout: T.sprint * 0.5 + T.flat * 0.4 };
  if (T.gravel > 40) { s.puncheur += 20; s.rouleur += 18; }
  return Object.entries(s).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
}
function genericIdentity(race, T) {
  const lead = topTerrainAbil(T)[0];
  const byLead = { climbing: "a climber's race — the mountains make the selection", sprint: "one for the fast men — expect a bunch finish", timetrial: "a race against the clock where engines decide", punch: "a puncheur's day of short, sharp efforts", cobbles: "a cobbled test of positioning and power", gravel: "an off-road selection on loose surfaces", flat: "a hard, exposed day for the rouleurs", descending: "decided on the climbs and the descents" };
  return `${race.name} — ${byLead[lead] || "a balanced race"}.`;
}
function genericTactics(T) {
  const out = [];
  if (T.climb > 55) out.push("Selection on the climbs");
  if (T.sprint > 55) out.push("Protect the sprinter for the finale");
  if (T.cobbles > 40) out.push("Position before the cobbles");
  if (T.gravel > 40) out.push("Stay upright on the gravel");
  if (T.tt > 40) out.push("Time-trial strength is decisive");
  if (T.punch > 50) out.push("Repeated punchy accelerations");
  return out.length ? out : ["Race for the win, manage the bunch"];
}
// structured terrain + identity for any race
export function raceProfile(race) {
  const stages = race.stages || [];
  const n = Math.max(1, stages.length);
  let cobblesMax = 0, gravelMax = 0, windMax = 0, climbSum = 0, len = 0, ttN = 0, sprintN = 0, punchN = 0, summitN = 0;
  for (const s of stages) {
    climbSum += stageClimbWeight(s); len += s.lengthKm || 0;
    if (s.mode === "itt") ttN++;
    if (s.cobbles) cobblesMax = Math.max(cobblesMax, s.cobbles);
    if (s.gravel) gravelMax = Math.max(gravelMax, s.gravel);
    if (s.wind) windMax = Math.max(windMax, s.wind);
    if (s.finishType === "summit") summitN++;
    if (s.finishType === "flat" && !s.cobbles && s.mode !== "itt") sprintN++;
    if (s.finishType === "uphill_short") punchN += 1;
    else if (s.finishType === "hilly") punchN += 0.6;
  }
  const terrain = {
    climb: clamp(Math.round((climbSum / n) * 105), 0, 100),
    tt: clamp(Math.round((ttN / n) * 140), 0, 100),
    sprint: clamp(Math.round((sprintN / n) * 120), 0, 100),
    punch: clamp(Math.round((punchN / n) * 110), 0, 100),
    cobbles: clamp(Math.round(cobblesMax * 100), 0, 100),
    gravel: clamp(Math.round(gravelMax * 100), 0, 100),
    flat: clamp(Math.round(38 + windMax * 45 + (sprintN / n) * 28), 0, 100),
    descent: 0,
  };
  terrain.descent = clamp(Math.round(terrain.climb * 0.4), 0, 100);
  if (race.kind === "tour") {   // a stage race's headline is the GC — weight the overall (climb + TT), not stage-win sprints
    terrain.climb = clamp(Math.round(terrain.climb * 1.4 + 12), 0, 100);
    terrain.sprint = Math.round(terrain.sprint * 0.4);
    terrain.flat = Math.round(terrain.flat * 0.5);
    terrain.punch = Math.round(terrain.punch * 0.7);
    terrain.tt = clamp(Math.round(terrain.tt * 1.15 + 8), 0, 100);
  }
  const id = RACE_IDENTITY[race.name];
  const spring = race.week >= 8 && race.week <= 18;
  const weatherRisk = clamp(Math.round(windMax * 40 + terrain.cobbles * 0.3 + terrain.gravel * 0.25 + (spring ? 22 : 6) + (race.region === "Flanders" || race.region === "Ardennes" ? 12 : 0)), 0, 100);
  const attritionRisk = clamp(Math.round(terrain.cobbles * 0.4 + terrain.gravel * 0.4 + terrain.climb * 0.25 + (race.cat === "Monument" ? 16 : 0) + (race.cat === "GT" ? 10 : 0)), 0, 100);
  const randomness = clamp(Math.round(terrain.cobbles * 0.35 + terrain.gravel * 0.4 + windMax * 30 + (race.kind === "oneday" ? 22 : 6) - terrain.tt * 0.2), 5, 95);
  return { terrain, weatherRisk, attritionRisk, randomness, identity: id?.text || genericIdentity(race, terrain), tactics: id?.tactics || genericTactics(terrain), archetypes: preferredArchetypes(terrain, id), keyAbil: id?.keyAbil || topTerrainAbil(terrain), sectors: SECTORS[race.name] || [], distanceKm: Math.round(len), stages: stages.length, cat: race.cat, coef: race.coef, purse: race.purse, prestige: race.prestige, country: race.country, region: race.region, week: race.week };
}
// terrain-weighted rider fit (0-99) using the full ability set
export function raceFit(rider, profile) {
  const a = rider.abil; if (!a) return overallOf(rider);
  const wkg = rider.cp / rider.weight, climb = clamp((wkg - 4.3) / 2.6 * 100, 1, 99);
  const sc = { climb, tt: a.timetrial, sprint: a.sprint, punch: a.punch, cobbles: 0.6 * a.cobbles + 0.22 * a.positioning + 0.18 * a.bikehandling, gravel: 0.5 * a.gravel + 0.22 * a.bikehandling + 0.16 * climb + 0.12 * a.punch, flat: a.flat, descent: a.descending };
  const T = profile.terrain; let num = 0, den = 0;
  for (const k in T) { num += T[k] * (sc[k] ?? 50); den += T[k]; }
  let fit = den ? num / den : overallOf(rider);
  fit += (profile.attritionRisk / 100) * (0.18 * (a.stamina - 60) + 0.10 * (a.positioning - 60));
  return clamp(Math.round(fit), 1, 99);
}
function fitWhy(r, profile) {
  const a = r.abil; if (!a) return "all-round";
  const keys = (profile.keyAbil || []).map((k) => (k === "climb" ? "climbing" : k));
  const vals = keys.map((k) => [ABIL_LABEL[k] || k, k === "climbing" ? clamp(Math.round((r.cp / r.weight - 4.3) / 2.6 * 100), 1, 99) : (a[k] ?? 0)]).filter((x) => x[1]).sort((x, y) => y[1] - x[1]);
  const strong = vals.filter((v) => v[1] >= 80).slice(0, 3).map((v) => v[0]);
  if (strong.length) return "elite " + strong.join(", ");
  const ok = vals.slice(0, 2).map((v) => v[0]);
  return ok.length ? "strong " + ok.join(" & ") : "all-round";
}
function roleHint(r, profile) {
  const a = r.abil; if (!a) return "support";
  if (profile.terrain.sprint > 55 && a.sprint >= 80) return "sprint";
  if (profile.terrain.climb > 60 && (r.cp / r.weight) >= 6.0) return "mountain support";
  if (profile.terrain.cobbles > 45 && a.cobbles >= 78) return "cobbles support";
  return "domestique";
}
// fogged pre-race favorites with auto "why" text
export function raceFavorites(state, race, n = 8) {
  const profile = raceProfile(race);
  const rng = makeRng(((race.id ?? 0) * 2654435761 ^ (state.rng?.seed ?? 1) ^ state.season) >>> 0);   // view-only noise: deterministic per race, never advances the sim stream
  const cands = Object.values(state.riders).filter((r) => { const t = state.teams[r.teamId]; return r.teamId != null && (r.out | 0) <= 0 && t && (race.tier ? t.tier === race.tier : true); });
  const scored = cands.map((r) => { const fit = raceFit(r, profile); const pf = periodizedForm(state, r, race.week); const form = pf.form ?? r.form ?? 60; return { r, fit, form, peak: pf.phase, base: fit * (0.85 + 0.30 * (form / 100)) }; });
  const byTeam = {};
  for (const s of scored) (byTeam[s.r.teamId] ||= []).push(s.fit);
  for (const tid in byTeam) byTeam[tid].sort((a, b) => b - a);
  const noiseAmp = 1.5 + profile.randomness * 0.05;
  for (const s of scored) { const top = byTeam[s.r.teamId]; const sup = (top.slice(1, 4).reduce((x, y) => x + y, 0) / 3) || 50; s.score = s.base * (0.96 + 0.08 * ((sup - 55) / 45)) + gaussish(rng) * noiseAmp; }
  scored.sort((a, b) => b.score - a.score);
  const favorites = scored.slice(0, n).map((s) => { const fog = knownPower(s.r); const onUser = s.r.teamId === state.userTeamId; const t = state.teams[s.r.teamId]; return { lid: s.r.id, name: s.r.name, team: t.name, jersey: t.jersey, fit: s.fit, shownFit: (onUser || fog.exact) ? s.fit : null, fogged: !(onUser || fog.exact), form: Math.round(s.form), why: fitWhy(s.r, profile) }; });
  return { profile, favorites };
}
// the user's prospects: best fit, suggested lineup, chance band, risk flags
export function teamOutlook(state, race) {
  const profile = raceProfile(race);
  const team = state.teams[state.userTeamId];
  const roster = team.riderIds.map((id) => state.riders[id]).filter((r) => r && (r.out | 0) <= 0);
  const scored = roster.map((r) => ({ r, fit: raceFit(r, profile), form: periodizedForm(state, r, race.week).form ?? r.form ?? 60 })).sort((a, b) => (b.fit * 0.7 + b.form * 0.3) - (a.fit * 0.7 + a.form * 0.3));
  const leader = scored[0];
  const size = race.kind === "tour" ? 8 : 7;
  const lineup = scored.slice(0, size).map((s) => ({ lid: s.r.id, name: s.r.name, fit: s.fit, form: Math.round(s.form), role: s.r.id === leader?.r.id ? "leader" : roleHint(s.r, profile) }));
  const fav = raceFavorites(state, race, 5).favorites;
  const bestFav = fav.length ? fav[0].fit : 80;
  const gap = (leader?.fit || 0) - bestFav;
  const chance = gap >= -2 ? "Contender" : gap >= -8 ? "Outside shot" : gap >= -16 ? "Long shot" : "Making up numbers";
  const risks = [];
  if (!leader || leader.fit < 60) risks.push("No strong fit for this profile");
  if (leader && leader.form < 55) risks.push(`${leader.r.short} is off form`);
  if (profile.weatherRisk > 62) risks.push("High weather / crash risk");
  if (profile.terrain.cobbles > 60 && !roster.some((r) => r.abil?.cobbles >= 80)) risks.push("No cobbles specialist in the squad");
  if (profile.terrain.climb > 70 && !roster.some((r) => (r.cp / r.weight) >= 6.1)) risks.push("No pure climber for the mountains");
  return { profile, leader: leader ? { lid: leader.r.id, name: leader.r.name, fit: leader.fit, form: Math.round(leader.form) } : null, lineup, chance, gap: Math.round(gap), risks };
}

// ── PRE-RACE TACTICS: smart recommendation + setup warnings ────────────────
// Suggest a single stage's plan from the CURRENT squad/leader — used both by the
// full recommender and by the per-stage "Suggest" button (respects your picks).
export function recommendStagePlan(state, race, stageIdx, setup = {}) {
  const st = race.stages[stageIdx];
  if (!st) return null;
  const ids = (setup.riderIds && setup.riderIds.length) ? setup.riderIds : state.teams[state.userTeamId].riderIds;
  const riders = ids.map((id) => state.riders[id]).filter(Boolean);
  const leaderId = setup.leaderId != null ? setup.leaderId : (riders[0]?.id ?? null);
  const sprOf = (r) => r.abil?.sprint ?? r.sprint ?? 0;
  const ft = st.finishType, spr = ft === "flat" || ft === "hilly";
  const bySprint = riders.slice().sort((a, b) => sprOf(b) - sprOf(a));
  const sprinterId = spr && bySprint.length && sprOf(bySprint[0]) >= 72 ? bySprint[0].id : null;
  const trainIds = sprinterId != null ? bySprint.filter((r) => r.id !== sprinterId).slice(0, 3).map((r) => r.id) : [];
  let plan;
  if (ft === "summit" || ft === "uphill_short") plan = "gc";
  else if (ft === "flat") plan = sprinterId != null ? "control" : "auto";
  else if (race.kind === "tour") plan = "gc";
  else plan = "auto";
  return { plan, sprinterLid: sprinterId, train: sprinterId != null ? trainIds : [], hitFromEnd: 4, launchFromEnd: 0.3,
    protect: leaderId != null ? [leaderId] : [], sats: [], markers: [], tempos: [] };
}
// Suggests a full, editable pre-race setup — which riders to bring, their roles,
// and a sensible per-stage plan — derived from the race profile, fit and form.
export function recommendTactics(state, race) {
  const profile = raceProfile(race);
  const team = state.teams[state.userTeamId];
  const size = race.kind === "tour" ? 8 : 7;
  const roster = team.riderIds.map((id) => state.riders[id]).filter((r) => r && (r.out | 0) <= 0);
  const scored = roster.map((r) => ({ r, fit: raceFit(r, profile), form: periodizedForm(state, r, race.week).form ?? r.form ?? 60 }))
    .sort((a, b) => (b.fit * 0.7 + b.form * 0.3) - (a.fit * 0.7 + a.form * 0.3));
  const squad = scored.slice(0, size);
  const riderIds = squad.map((s) => s.r.id);
  const leaderId = squad.length ? squad[0].r.id : null;
  const sprOf = (r) => r.abil?.sprint ?? r.sprint ?? 0;
  const sprintStage = race.stages.some((st) => st.finishType === "flat" || st.finishType === "hilly");
  const bySprint = squad.slice().sort((a, b) => sprOf(b.r) - sprOf(a.r));
  const sprinterId = sprintStage && bySprint.length && sprOf(bySprint[0].r) >= 72 ? bySprint[0].r.id : null;

  const duties = {};
  for (const s of squad) duties[s.r.id] = "domestique";
  if (leaderId != null) duties[leaderId] = "leader";
  if (squad[1] && (squad[0].fit - squad[1].fit) <= 5 && squad[1].r.id !== sprinterId) duties[squad[1].r.id] = "coleader";
  if (sprinterId != null && sprinterId !== leaderId) {
    duties[sprinterId] = "sprinter";
    bySprint.filter((s) => s.r.id !== sprinterId && duties[s.r.id] === "domestique").slice(0, 2).forEach((s) => { duties[s.r.id] = "leadout"; });
  }
  const cap = squad.filter((s) => duties[s.r.id] === "domestique").sort((a, b) => (b.r.abil?.positioning ?? 0) - (a.r.abil?.positioning ?? 0))[0];
  if (cap) duties[cap.r.id] = "captain";

  const stagePlans = race.stages.map((_, i) => recommendStagePlan(state, race, i, { riderIds, leaderId }));
  return { riderIds, leaderId, sprinterId, duties, stagePlans };
}

// Pre-race sanity checks for the current setup. setup = { riderIds, leaderId, stagePlans }
export function tacticWarnings(state, race, setup) {
  const out = [];
  const profile = raceProfile(race);
  const size = race.kind === "tour" ? 8 : 7;
  const ids = setup.riderIds || [];
  const R = (id) => state.riders[id];
  if (ids.length !== size) out.push({ level: "warn", text: `Select ${size} riders — you have ${ids.length}.` });
  const leader = setup.leaderId != null ? R(setup.leaderId) : null;
  if (!leader) out.push({ level: "warn", text: "No leader assigned." });
  else {
    const lf = raceFit(leader, profile);
    const form = periodizedForm(state, leader, race.week).form ?? leader.form ?? 60;
    if (lf < 60) out.push({ level: "warn", text: `${leader.short} is a weak fit for this course (fit ${lf}).` });
    if (form < 55) out.push({ level: "warn", text: `${leader.short} is off form (${form}).` });
  }
  (setup.stagePlans || []).forEach((sp, i) => {
    const st = race.stages[i]; if (!st || !sp) return;
    const spr = st.finishType === "flat" || st.finishType === "hilly";
    const lbl = race.kind === "tour" ? `St.${i + 1}` : "Finish";
    if (spr && sp.plan === "control" && sp.sprinterLid == null) out.push({ level: "warn", text: `${lbl}: controlling for a sprint with no sprinter set.` });
    if ((st.finishType === "summit" || st.finishType === "uphill_short") && sp.plan !== "gc") out.push({ level: "info", text: `${lbl}: uphill finish — "Protect the leader" usually suits it.` });
  });
  if (profile.terrain.climb > 70 && !ids.some((id) => { const r = R(id); return r && (r.cp / r.weight) >= 6.1; })) out.push({ level: "info", text: "No pure climber for the high mountains." });
  if (profile.terrain.cobbles > 60 && !ids.some((id) => { const r = R(id); return r && (r.abil?.cobbles ?? 0) >= 80; })) out.push({ level: "info", text: "No cobbles specialist for the pavé." });
  return out;
}

// FM-style terrain abilities derived from the underlying performance model
// fog on power/abilities — sharpens as you watch a rider race (heavy early)
export function knownPower(rider) { const pk = rider.powerKnow ?? 10; return { pk, err: Math.round((1 - pk / 100) * 16), exact: pk >= 86 }; }
export function estAbil(rider, key) {
  const v = (rider.abil && rider.abil[key]) ?? 50, { err, exact } = knownPower(rider);
  return exact ? { mid: v, lo: v, hi: v, exact: true, err: 0 } : { mid: v, lo: clamp(v - err, 1, 99), hi: clamp(v + err, 1, 99), exact: false, err };
}

export function disciplines(r) {
  const a = r.abil;
  if (a) return { climbing: a.climbing, timetrial: a.timetrial, sprint: a.sprint, punch: a.punch, cobbles: a.cobbles,
    flat: a.flat, stamina: a.stamina, recovery: a.recovery, positioning: a.positioning, descending: a.descending,
    attacking: a.attacking, gravel: a.gravel, bikehandling: a.bikehandling, breakaway: a.attacking, endurance: a.stamina };
  const wkg = r.cp / r.weight;
  const aeroR = clamp(Math.round((0.42 - (r.cdA ?? 0.36)) / 0.13 * 99), 1, 99);
  const wPct = clamp(Math.round((wkg - 3.3) / 3.3 * 99), 1, 99);
  return {
    climbing: clamp(Math.round(wPct * 0.6 + r.threshold * 0.4), 1, 99),
    timetrial: clamp(Math.round(r.threshold * 0.62 + aeroR * 0.38), 1, 99),
    sprint: clamp(Math.round(r.sprint * 0.9 + r.punch * 0.1), 1, 99),
    punch: clamp(Math.round(r.punch * 0.85 + r.threshold * 0.15), 1, 99),
    cobbles: clamp(Math.round(({ rouleur: 90, puncheur: 80, leadout: 62, sprinter: 50, helper: 55, gc: 42, climber: 25 }[r.archetype] ?? 50) + clamp((r.cp - 380) / 200, -0.12, 0.12) * 100), 1, 99),
    breakaway: clamp(Math.round(r.threshold * 0.45 + (r.wPrime / 1000) * 1.6 + (r.aggr ?? 0.4) * 30 + 10), 1, 99),
    endurance: clamp(Math.round(r.threshold * 0.6 + (r.wPrime / 1000) * 2.2 + 18), 1, 99),
  };
}
export { NATIONS as SCOUT_REGIONS };

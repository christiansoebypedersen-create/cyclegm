// ============================================================================
//  CYCLESIM ENGINE  —  single-stage road race simulation
//  Pure functions. No DOM. Lift this whole file into your Vite project as-is.
//
//  Physics: Martin/Olds power model  P = aero(v^3) + rolling + climbing
//  Energy : Critical Power / W' model (the "matchbook") — deplete above CP,
//           recover below CP. Cracking = W' hits zero and you can't hold pace.
//  Tactics: a group's sustainable speed = blend of pulling (full wind) and
//           sheltered (draft) time. Big bunch on the flat ~ draft-cost = fast +
//           intact. Small break shares wind badly = slower = caught. On a climb
//           draft ~ vanishes so size stops helping and W/kg shreds the field.
// ============================================================================

// ---------- deterministic RNG (mulberry32) so tuning is reproducible ---------
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (rng) => {
  // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- physical constants ----------------------------------------------
const G = 9.81;
const RHO = 1.225;       // air density kg/m^3
const CRR = 0.004;       // rolling resistance coefficient (good tarmac)
const DRIVE = 0.975;     // drivetrain efficiency
const BIKE_KG = 8;       // bike + kit added to rider mass for climbing/rolling

// Power (watts) to ride at speed v (m/s) on a gradient `slope` (rise/run, e.g.
// 0.08 = 8%), with aero drag scaled by draft factor d in [0,1] (1 = full wind).
export function powerAt(v, slope, cdA, d, massKg) {
  const aero = 0.5 * RHO * cdA * d * v * v * v;
  const roll = CRR * massKg * G * v;
  const climb = massKg * G * slope * v;       // small-angle: sin~tan~slope
  return Math.max(0, (aero + roll + climb) / DRIVE);
}

// Invert: fastest v (m/s) whose power == targetW. Monotone in v -> bisection.
function speedForPower(targetW, slope, cdA, d, massKg) {
  if (targetW <= 0) return 0.5;
  let lo = 0.5, hi = 30; // 1.8 .. 108 km/h
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (powerAt(mid, slope, cdA, d, massKg) < targetW) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ============================================================================
//  DRAFT MODEL
//  Returns fraction of aero drag a SHELTERED rider still pays.
//  - bigger group -> deeper shelter -> smaller fraction (more saving)
//  - steeper slope -> drafting barely helps -> fraction climbs toward ~1
// ============================================================================
function draftFactor(groupSize, slope, tune) {
  // flat-ground saving grows with group size (one wheel ~38%, deep bunch ~60%+)
  const sizeT = clamp(Math.log(Math.max(groupSize, 1)) / Math.log(40), 0, 1);
  const flatSaving = lerp(0.34, tune.maxDraftSaving, sizeT); // saving fraction
  // attenuate saving as the road tilts up (≈no shelter benefit when steep)
  const up = clamp(slope / 0.06, 0, 1); // 0 at flat .. 1 at 6%+
  const saving = lerp(flatSaving, tune.uphillDraftSaving, up);
  return clamp(1 - saving, 0.05, 1);
}

// ============================================================================
//  TEAMS & RIDERS
//  Ratings 0..100 (BBGM-style). Physical values derived from them + weight.
//    threshold -> Critical Power (W). climbing prowess = high CP / low weight.
//    punch     -> W' (anaerobic battery, J).  sprint -> finale flat kick.
// ============================================================================
const FIRST = ["Tadej","Jonas","Remco","Mathieu","Wout","Primoz","Mads","Jasper","Biniam","Filippo","Egan","Geraint","Julian","Marc","Pello","Sepp","Adam","Tom","Kasper","Magnus","Soren","Anders","Lennard","Felix","Bauke","Dylan","Caleb","Arnaud","Pablo","Ben","Stefan","Michael","Ivan","Luca","Matteo","Joao","Carlos","Nairo","Rigoberto","Esteban","Romain","Thibaut","Warren","David","Simon","Hugh","Ethan","Oscar","Victor","Niklas"];
const LAST = ["Pogi","Vinge","Evenel","Poel","Aert","Roglic","Pedersen","Philik","Girmay","Ganna","Bernek","Thoms","Alaph","Hirsch","Bilbo","Kussel","Yatesy","Pidcoe","Asgren","Corts","Kragh","Foss","Kampen","Galland","Mollek","Groenen","Ewald","Demare","Tornay","Healk","Kungl","Storrt","Sosaa","Mozzo","Trentz","Almei","Verona","Quintar","Uraan","Chaves","Bardz","Pinault","Barguil","Goduu","Gerrans","Carthy","Hayter","Onlee","Lafay","Arndt"];

// Derive physical engine values from ratings + weight. Call after any rating
// change (e.g. training) so power tracks the new ratings.
export function derivePhysicals(r) {
  r.massKg = r.weight + BIKE_KG;
  // W/kg from threshold, PENALIZED by weight: light riders get more W/kg (climb
  // better), heavy riders still make strong absolute watts (fast on the flat,
  // shelled on the climb). This is what makes archetypes behave by terrain.
  const wkg = (3.3 + 0.032 * r.threshold) * Math.pow(66 / r.weight, 0.6);
  r.cp = Math.round(wkg * r.weight);
  r.wPrime = Math.round((9 + 0.27 * r.punch) * 1000);          // ~13–33 kJ
  r.cdA = clamp(0.295 + (r.weight - 68) * 0.0016 - (r.aeroAdj || 0), 0.255, 0.36); // bigger = more air; TT training trims it
  return r;
}

function buildRider(id, teamId, archetype, jersey, rng) {
  const n = (m, s) => clamp(Math.round(m + gauss(rng) * s), 1, 99);
  const weight = ({ gc: n(61, 2), climber: n(59, 2), sprinter: n(76, 3), leadout: n(74, 3), puncheur: n(66, 3), rouleur: n(72, 4) }[archetype]) ?? n(70, 4);
  const abil = abilFor(archetype, n);
  const role = ({ gc: "leader", sprinter: "leader", puncheur: "leader" }[archetype]) || "helper";
  const fi = id % FIRST.length, li = (id * 7 + 3) % LAST.length;
  const r = {
    id, teamId, jersey, archetype, role, weight, abil,
    aggr: clamp(abil.attacking / 99 * 0.85 + 0.08, 0, 1),
    weatherRes: n(60, 15), consistency: n(64, 13),   // hidden traits: bad-weather resilience & day-to-day reliability
    name: `${FIRST[fi]} ${LAST[li]}`,
    short: `${FIRST[fi][0]}. ${LAST[li]}`,
  };
  syncShadows(r);
  return derivePhysicals(r);
}

// the 11 abilities (stored truth). means per archetype; n() adds spread.
export const ABIL_KEYS = ["climbing", "punch", "flat", "timetrial", "sprint", "cobbles", "stamina", "recovery", "positioning", "descending", "attacking", "gravel", "bikehandling"];
export function abilFor(a, n) {
  const M = {
    gc:       { climbing: 88, punch: 60, flat: 74, timetrial: 80, sprint: 40, cobbles: 42, stamina: 86, recovery: 82, positioning: 80, descending: 70, attacking: 54, gravel: 55, bikehandling: 70 },
    climber:  { climbing: 90, punch: 58, flat: 60, timetrial: 62, sprint: 34, cobbles: 28, stamina: 82, recovery: 76, positioning: 66, descending: 64, attacking: 50, gravel: 46, bikehandling: 64 },
    sprinter: { climbing: 32, punch: 70, flat: 84, timetrial: 60, sprint: 94, cobbles: 50, stamina: 64, recovery: 70, positioning: 82, descending: 64, attacking: 30, gravel: 42, bikehandling: 66 },
    leadout:  { climbing: 50, punch: 72, flat: 82, timetrial: 68, sprint: 72, cobbles: 60, stamina: 70, recovery: 70, positioning: 86, descending: 66, attacking: 36, gravel: 52, bikehandling: 74 },
    puncheur: { climbing: 76, punch: 88, flat: 74, timetrial: 72, sprint: 72, cobbles: 66, stamina: 74, recovery: 74, positioning: 80, descending: 74, attacking: 78, gravel: 66, bikehandling: 78 },
    rouleur:  { climbing: 58, punch: 66, flat: 86, timetrial: 82, sprint: 56, cobbles: 84, stamina: 80, recovery: 76, positioning: 78, descending: 72, attacking: 64, gravel: 80, bikehandling: 82 },
    helper:   { climbing: 60, punch: 60, flat: 70, timetrial: 66, sprint: 52, cobbles: 58, stamina: 74, recovery: 72, positioning: 70, descending: 66, attacking: 50, gravel: 56, bikehandling: 68 },
  };
  const base = M[a] || M.helper, out = {};
  for (const k of ABIL_KEYS) out[k] = n(base[k], 6);
  return out;
}
// keep legacy engine stats in sync with abilities (so valuation/overall/fit keep working)
export function syncShadows(r) {
  const a = r.abil; if (!a) return r;
  r.threshold = clamp(Math.round(0.46 * a.climbing + 0.34 * a.flat + 0.20 * a.timetrial), 1, 99);
  r.punch = a.punch; r.sprint = a.sprint;
  return r;
}
// climb emphasis of a stage (0 flat .. 1 pure mountain), from its gradient profile
export function stageClimbWeight(stage) {
  if (!stage) return 0.4;
  if (stage.mode === "itt") return 0.15;
  const cs = stage._stage;                       // canonical Stage (from .cds library or generator)
  if (cs && cs.climbM != null && cs.distanceKm) {
    const gpk = cs.climbM / cs.distanceKm;       // metres climbed per km — continuous difficulty
    let cw = clamp(0.10 + gpk / 42, 0.06, 0.95);
    if (cs.finishKind === "summit") cw = Math.max(cw, 0.72);
    else if (cs.finishKind === "mountain") cw = Math.max(cw, 0.6);
    else if (cs.finishKind === "flat" || cs.finishKind === "sprint") cw = Math.min(cw, 0.2);
    else if (cs.finishKind === "uphill") cw = Math.max(cw, 0.45);
    else if (cs.finishKind === "cobbled") cw = Math.min(cw, 0.25);
    return cw;
  }
  const segs = stage.segments;
  let cw;
  if (segs && segs.length) {
    let up = 0, tot = 0;
    for (const [a, b, s] of segs) { const len = b - a; tot += len; if (s > 0.005) up += len * Math.min(s, 0.09) / 0.09; }
    cw = tot ? up / tot : 0.35;
  } else cw = ({ summit: 0.85, mountain: 0.8, uphill_short: 0.6, hilly: 0.5, rolling: 0.4, flat: 0.12, tt: 0.2 }[stage.finishType]) ?? 0.4;
  if (stage.finishType === "summit") cw = Math.max(cw, 0.72);
  if (stage.finishType === "flat") cw = Math.min(cw, 0.2);
  return clamp(cw, 0.05, 0.95);
}
// LIVE per-stage power expression from abilities × dynamics (condition/day/peak/fatigue).
// dyn = { sus, ana, spr } multipliers (default 1). Returns engine-ready numbers.
export function expressPower(r, stage, dyn = {}) {
  const a = r.abil, w = r.weight, cw = stageClimbWeight(stage);
  const sus = dyn.sus ?? 1, ana = dyn.ana ?? 1, spr = dyn.spr ?? 1;
  const wkgClimb = (3.45 + 0.0305 * a.climbing) * Math.pow(66 / w, 0.5);
  const climbCp = wkgClimb * w;
  const flatCp = 300 + 1.75 * a.flat + 0.45 * (w - 68);
  let cp = stage.mode === "itt" ? flatCp * (0.62 + 0.4 * a.timetrial / 99) : climbCp * cw + flatCp * (1 - cw);
  const wPrime = (8 + 0.275 * a.punch) * 1000;
  const cdA = clamp(0.298 + (w - 68) * 0.0016 - a.timetrial * 0.00045 - (r.aeroAdj || 0), 0.250, 0.36);
  return {
    cp: Math.round(cp * sus), wPrime: Math.round(wPrime * ana), cdA,
    sprint: clamp(Math.round(a.sprint * spr), 1, 110),
    cobbleSkill: clamp(0.2 + a.cobbles / 99 * 0.85, 0.15, 1.05),
    aggr: clamp(a.attacking / 99 * 0.85 + 0.08, 0, 1),
  };
}

// A balanced startlist: GC squads, sprint trains, puncheur/break-hunter teams.
export function buildField(rng, teamCount = 18, perTeam = 7) {
  const palette = ["#e4572e","#1b9aaa","#f4b400","#3d348b","#0a8754","#d72660","#2274a5","#e07a5f","#6a4c93","#118ab2","#ef476f","#06d6a0","#ff8c42","#5a189a","#168aad","#c1121f","#386641","#9d4edd"];
  const recipes = [
    ["gc","climber","climber","rouleur","rouleur","helper","helper"],     // GC squad
    ["sprinter","leadout","leadout","leadout","rouleur","helper","helper"],// sprint train
    ["puncheur","rouleur","rouleur","climber","helper","helper","helper"], // classics/punch
  ];
  const teams = [];
  const riders = [];
  let id = 0;
  for (let t = 0; t < teamCount; t++) {
    const jersey = palette[t % palette.length];
    const recipe = recipes[t % recipes.length];
    const team = { id: t, jersey, name: `Team ${String.fromCharCode(65 + (t % 26))}${t >= 26 ? "2" : ""}`, riders: [] };
    for (let r = 0; r < perTeam; r++) {
      const arche = recipe[r % recipe.length];
      const rider = buildRider(id++, t, arche, jersey, rng);
      riders.push(rider);
      team.riders.push(rider.id);
    }
    teams.push(team);
  }
  return { teams, riders };
}

// ============================================================================
//  STAGE PROFILES  — segments of constant gradient. finishType drives the kick.
// ============================================================================
export const STAGE_PRESETS = {
  flat: {
    name: "Flat sprint stage", lengthKm: 178, finishType: "flat",
    segments: [[0,150,0.0],[150,170,0.0],[170,178,0.0]],
  },
  hilly: {
    name: "Hilly / breakaway stage", lengthKm: 196, finishType: "hilly",
    segments: [[0,40,0.01],[40,70,0.035],[70,90,-0.03],[90,130,0.015],
               [130,150,0.05],[150,170,-0.04],[170,188,0.02],[188,196,0.0]],
  },
  punch: {
    name: "Puncheur finish", lengthKm: 165, finishType: "uphill_short",
    segments: [[0,110,0.005],[110,140,0.03],[140,150,-0.03],[150,158,0.02],[158,162,-0.01],[162,165,0.06]],
  },
  mountain: {
    name: "Mountain summit finish", lengthKm: 172, finishType: "summit",
    segments: [[0,60,0.005],[60,85,0.06],[85,110,-0.04],[110,140,0.01],
               [140,150,0.04],[150,172,0.082]],
  },
  itt: {
    name: "Individual time trial", lengthKm: 34, finishType: "tt", mode: "itt",
    segments: [[0,12,0.0],[12,18,0.01],[18,24,-0.005],[24,34,0.0]],
  },
  cobbles: {
    name: "Cobbled classic", lengthKm: 188, finishType: "flat", cobbles: 0.85, wind: 0.3,
    segments: [[0,90,0.0],[90,110,0.005],[110,150,0.0],[150,175,0.008],[175,188,0.0]],
  },
};

function slopeAtKm(stage, km) {
  for (const [a, b, s] of stage.segments) if (km >= a && km < b) return s;
  return stage.segments[stage.segments.length - 1][2];
}


// ============================================================================
//  SIMULATION — hybrid segment/group engine
// ----------------------------------------------------------------------------
//  A stage is converted into terrain SEGMENTS (climbs, descents, flats, pavé
//  sectors, crosswind zones, the finale). Riders live in GROUPS; each segment,
//  every group decides an intent (leash logic, tactics, commands), resolves a
//  physical pace, and each rider pays an energy/W' cost by role and shelter.
//  Gaps are literal time differences. Attacks, splits, bridges, catches and
//  cracks all happen at segment resolution; the seeded RNG adds execution
//  variance and incidents only — never the base result.
// ============================================================================

// ---- all balancing constants in one place ----------------------------------
export const DEFAULT_TUNE = {
  // physics/pace
  maxDraftSaving: 0.62,   // deep-bunch flat aero saving (worker pays 38%)
  uphillDraftSaving: 0.08,
  chaseAggression: 1.0,   // scales how many riders commit to the peloton chase
  breakCommitment: 1.0,   // break effort relative to CP
  climbSelectivity: 1.0,  // front pace on climbs (>1 burns the bunch)
  wPrimeScale: 1.0,       // global W' multiplier (smaller = more brittle racing)
  tauRef: 520,            // W' recovery time constant (s) at 100W below CP
  noise: 1.0,             // execution variance scale
  breakSize: 5,
  breakBias: 0,           // >0 loosens the chase leash (stage races / hard days)
  // segment engine
  segMinKm: 2.5,          // merge segments shorter than this
  segMaxKm: 8,            // split longer spans — each segment is one tactical beat
  frameDt: 22,            // seconds of race time per playback frame
  energyFloor: 0.86,      // cooked riders keep >= 86% of CP (then W' decides)
  energySpan: 0.14,
  drainClimb: 1.24,       // aerobic drain multipliers by terrain
  drainCobble: 1.40,
  drainFlat: 0.85,
  drainDescent: 0.30,
  crackSel: 0.25,         // min segment selectivity for crack checks
  attackBaseP: 0.16,      // per-selective-segment leader attack probability scale
  counterBoost: 2.2,      // attack odds multiplier right after a catch
  hesitation: 0.82,       // peloton intent multiplier when nobody owns the chase
  mechP: 0.030,           // per-rider mechanical odds per pavé/gravel sector
  echelonP: 0.34,         // echelon odds per windy segment (scaled by wind)
  descentCapBase: 15.5,   // m/s descent cap floor …
  descentCapSkill: 11.0,  // … + this × median handling
  soloDescentBonus: 1.4,  // brave lone descenders gain (m/s)
};

const TERRAIN = {
  climb:   { drainKey: "drainClimb",   draftMul: 0.25 },
  descent: { drainKey: "drainDescent", draftMul: 0.85 },
  rolling: { drainKey: "drainFlat",    draftMul: 0.9 },
  flat:    { drainKey: "drainFlat",    draftMul: 1.0 },
  cobbles: { drainKey: "drainCobble",  draftMul: 0.45 },
  gravel:  { drainKey: "drainCobble",  draftMul: 0.55 },
  wind:    { drainKey: "drainFlat",    draftMul: 0.6 },
};

// ---- stage → segments -------------------------------------------------------
// A segment: { i, fromKm, toKm, km, grad, type, sel (selectivity 0..1), cat,
//              finale, finishClimb, sector? }
export function segmentize(stage, tune = DEFAULT_TUNE) {
  const L = stage.lengthKm;
  const raw = [];
  for (const [a, b, s] of stage.segments) {
    if (b <= a) continue;
    raw.push({ fromKm: a, toKm: Math.min(b, L), grad: s });
  }
  if (!raw.length) raw.push({ fromKm: 0, toKm: L, grad: 0 });
  raw[raw.length - 1].toKm = L;
  // classify + merge tiny neighbours of the same class
  const cls = (g) => (g >= 0.035 ? "climb" : g <= -0.025 ? "descent" : g >= 0.015 ? "rolling" : "flat");
  const segs = [];
  for (const r of raw) {
    const type = cls(r.grad);
    const prev = segs[segs.length - 1];
    if (prev && prev.type === type && (r.toKm - r.fromKm < tune.segMinKm || prev.km < tune.segMinKm)) {
      const km = prev.km + (r.toKm - r.fromKm);
      prev.grad = (prev.grad * prev.km + r.grad * (r.toKm - r.fromKm)) / km;
      prev.toKm = r.toKm; prev.km = km;
    } else {
      segs.push({ fromKm: r.fromKm, toKm: r.toKm, km: r.toKm - r.fromKm, grad: r.grad, type });
    }
  }
  // split long spans: every segment is one tactical decision point
  for (let i = 0; i < segs.length; i++) {
    const sgm = segs[i];
    if (sgm.km > tune.segMaxKm) {
      const parts = Math.ceil(sgm.km / tune.segMaxKm);
      const kmEach = sgm.km / parts;
      const repl = Array.from({ length: parts }, (_, k) => ({
        fromKm: sgm.fromKm + k * kmEach, toKm: sgm.fromKm + (k + 1) * kmEach, km: kmEach, grad: sgm.grad, type: sgm.type }));
      segs.splice(i, 1, ...repl); i += parts - 1;
    }
  }
  // pavé / gravel sectors from the real course when present; otherwise synthesize
  const sectors = (stage._stage && stage._stage.sectors) || [];
  const surf = stage.cobbles ? "cobbles" : stage.gravel ? "gravel" : null;
  const marks = [];
  if (surf && sectors.length) {
    for (const sec of sectors) if (sec.startKm > 2 && sec.startKm < L - 1) marks.push({ at: sec.startKm, km: Math.max(0.8, (sec.lengthM || 1200) / 1000), name: sec.name });
  } else if (surf) {
    const n = 3 + Math.round((stage.cobbles || stage.gravel || 0) * 3);
    for (let i = 0; i < n; i++) marks.push({ at: L * (0.35 + 0.58 * (i + 0.5) / n), km: 1.6, name: null });
  }
  for (const mk of marks) {
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (mk.at >= s.fromKm && mk.at < s.toKm && s.type !== "climb") {
        const end = Math.min(mk.at + mk.km, s.toKm);
        const parts = [];
        if (mk.at - s.fromKm > 0.3) parts.push({ ...s, toKm: mk.at, km: mk.at - s.fromKm });
        parts.push({ fromKm: mk.at, toKm: end, km: end - mk.at, grad: s.grad, type: surf, sector: mk.name || "sector" });
        if (s.toKm - end > 0.3) parts.push({ ...s, fromKm: end, km: s.toKm - end });
        segs.splice(i, 1, ...parts);
        break;
      }
    }
  }
  // crosswind zone
  if (stage.wind) {
    const at = L * 0.55;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (at >= s.fromKm && at < s.toKm && (s.type === "flat" || s.type === "rolling")) { s.type = "wind"; break; }
    }
  }
  // finale flags + selectivity
  for (const s of segs) {
    s.finale = s.toKm > L - 3.5;
    s.sel = s.type === "climb" ? clamp(0.25 + s.grad * 9 + Math.min(s.km, 14) * 0.025, 0.2, 1)
          : s.type === "cobbles" ? 0.8 : s.type === "gravel" ? 0.7 : s.type === "wind" ? 0.55
          : s.type === "rolling" ? 0.12 : 0.04;
    s.cat = s.type === "climb" ? (s.grad * s.km * 100 >= 60 ? "HC" : s.grad * s.km * 100 >= 30 ? "1" : s.grad * s.km * 100 >= 14 ? "2" : "3") : null;
  }
  const last = segs[segs.length - 1];
  if (last) last.finishClimb = last.type === "climb";
  segs.forEach((s, i) => (s.i = i));
  return segs;
}

// ---- rider runtime state ----------------------------------------------------
function riderState(rider, tune) {
  return {
    id: rider.id, r: rider,
    wMax: rider.wPrime * tune.wPrimeScale, wBal: rider.wPrime * tune.wPrimeScale, // punch reserve
    E: clamp(0.55 + 0.45 * (rider.fresh ?? 100) / 100, 0.3, 1),                   // aerobic day-energy (freshness shrinks it)
    drain: 1.35 - (rider.threshold / 99) * 0.55,                                  // engine efficiency: big diesels drain slower
    coop: clamp(0.45 + (rider.abilCoop ?? 0.5) * 0.5, 0.2, 1),                    // pull willingness
    risk: clamp(0.35 + (rider.handling ?? 0.6) * 0.4 + (rider.aggr ?? 0.4) * 0.25, 0.2, 1),
    aggr: rider.aggr ?? 0.4,
    surges: 0, effortHist: [],
    pulling: false, dropped: false, cracked: false, protectFlag: false,
    finishTime: null, place: null, position: 0.5,
  };
}
const cpEff = (m, tune) => m.r.cp * (tune.energyFloor + tune.energySpan * Math.pow(clamp(m.E, 0, 1), 0.7));

function recover(wBal, wMax, deficit, dtSec, tune) {
  const tau = clamp(tune.tauRef * 100 / Math.max(deficit, 20), 120, 1400);
  return wBal + (wMax - wBal) * (1 - Math.exp(-dtSec / tau));
}

// ---- group pace: solve v so the working rotation averages the target power --
function paceSolve(group, seg, effort, tune) {
  const active = group.members.filter((m) => !m.dropped);
  if (!active.length) return 6;
  // protected riders (leaders, sprinters on the train) never price the pace they don't pay for
  let workers;
  if (group.type === "peloton") {
    const pool = active.filter((m) => !(m.r.role === "leader" || m.protectFlag));
    const k = clamp(Math.round((4 + 11 * group.intent) * tune.chaseAggression), 3, 22);
    workers = [...(pool.length ? pool : active)].sort((a, b) => b.r.cp - a.r.cp).slice(0, k);
    if (group._train) for (const m of active) if (group._train.has(m.id) && !workers.includes(m)) workers.push(m);
    if (group._tempoPull) for (const m of active) if (group._tempoPull.has(m.id) && !workers.includes(m)) workers.push(m);
  } else {
    workers = active.filter((m) => !(m.satFlag && m.satWork === "sit_on") && m.coop > 0.3);
    if (!workers.length) workers = active;
  }
  group._workers = new Set(workers.map((m) => m.id));
  const nP = Math.max(1, workers.length);
  const cpRep = workers.reduce((s, m) => s + cpEff(m, tune), 0) / nP;
  const cdaRep = workers.reduce((s, m) => s + m.r.cdA, 0) / nP;
  const massRep = workers.reduce((s, m) => s + m.r.massKg, 0) / nP;
  const dPull = draftFactor(nP, seg.grad, tune);
  const target = effort * cpRep;
  let lo = 0.5, hi = 32;
  for (let i = 0; i < 34; i++) {
    const v = (lo + hi) / 2;
    const avg = powerAt(v, seg.grad, cdaRep, 1.0, massRep) / nP + powerAt(v, seg.grad, cdaRep, dPull, massRep) * (1 - 1 / nP);
    if (avg < target) lo = v; else hi = v;
  }
  let v = (lo + hi) / 2;
  if (seg.type === "descent") {
    const hs = active.map((m) => m.r.handling ?? 0.6).sort((a, b) => a - b);
    const med = hs[Math.floor(hs.length / 2)] ?? 0.6;
    let cap = tune.descentCapBase + tune.descentCapSkill * med;
    if (group.members.length === 1 && group.members[0].risk > 0.6) cap += tune.soloDescentBonus; // a brave lone descender
    v = Math.min(v, cap);
  }
  return v;
}

// ---- the engine -------------------------------------------------------------
export function simulate(field, stage, tuneIn = {}, seed = 1, commands = [], opts = {}) {
  const tune = { ...DEFAULT_TUNE, ...tuneIn };
  if (stage.mode === "itt") return simulateITT(field, stage, seed, tune);
  const rng = makeRng(seed);
  const L = stage.lengthKm;
  const segs = segmentize(stage, tune);
  const states = new Map(field.riders.map((r) => [r.id, riderState(r, tune)]));
  const byLid = new Map();
  for (const s of states.values()) if (s.r.lid != null) byLid.set(s.r.lid, s);
  const resolveCmd = (c) => (c.lid != null ? byLid.get(c.lid) : (c.riderId != null ? states.get(c.riderId) : null));

  // -- commands (same shapes as before; per-rider triggers key off the RIDER'S OWN group) --
  const cmdAttacks = commands.filter((c) => c.type === "attack").map((c) => ({ ...c, fired: false }));
  const cmdChases = commands.filter((c) => c.type === "chase").sort((a, b) => (a.fromKm || 0) - (b.fromKm || 0));
  const cmdPace = commands.filter((c) => c.type === "pace").sort((a, b) => (a.fromKm || 0) - (b.fromKm || 0));
  const cmdDrops = commands.filter((c) => c.type === "dropback").map((c) => ({ ...c, fired: false }));
  const cmdEase = commands.filter((c) => c.type === "ease");
  const cmdMoveup = commands.filter((c) => c.type === "moveup").map((c) => ({ ...c, fired: false }));
  const cmdTempo = commands.filter((c) => c.type === "tempo").map((c) => ({ ...c, lidSet: new Set(c.lids || []) }));
  const leadoutCmd = commands.find((c) => c.type === "leadout") || null;
  commands.filter((c) => c.type === "protect").forEach((c) => { const s = resolveCmd(c); if (s) s.protectFlag = true; });
  const satStates = new Set();
  for (const c of commands.filter((c) => c.type === "satellite")) {
    const s = resolveCmd(c); if (!s) continue;
    s.satFlag = true; s.satWork = c.work || "build"; s.satDropKm = c.dropAtKm ?? null;
    s.satOnBridge = !!c.onBridge; s.satLeaderLid = c.leaderLid ?? null; s.satDone = false;
    satStates.add(s);
  }

  // -- the early break: aggressive non-GC riders + designated satellites --
  const candidates = field.riders
    .filter((r) => r.role !== "leader" || r.archetype === "puncheur")
    .map((r) => ({ r, k: 0.7 * r.aggr + 0.5 * gauss(rng) }))
    .sort((a, b) => b.k - a.k).slice(0, tune.breakSize)
    .map((x) => states.get(x.r.id));
  for (const s of satStates) if (!candidates.includes(s)) candidates.push(s);
  const breakIds = new Set(candidates.map((m) => m.id));

  let nextGid = 3;
  const allGroups = [];                       // every group ever born — replays need the caught ones too
  const groups = [
    { id: 1, type: "break", members: candidates, intent: 1, time: 25, kmDone: 0 },      // 25s head start out of the neutral zone
    { id: 2, type: "peloton", members: field.riders.filter((r) => !breakIds.has(r.id)).map((r) => states.get(r.id)), intent: 0.15, time: 0, kmDone: 0 },
  ];

  allGroups.push(...groups);
  const addGroup = (g) => { groups.push(g); allGroups.push(g); };
  const log = [], gapTrace = [], explain = [], hist = [];
  const finishers = [];
  let raceT = 0; // the peloton's clock, for event timestamps
  const event = (km, kind, text, why, tAt) => { log.push({ t: tAt ?? raceT, km: +km.toFixed(1), kind, text, ...(why ? { why } : {}) }); if (why) explain.push({ km: +km.toFixed(1), what: text, why }); };
  event(0, "break", `${candidates.length} riders attack from the gun: ${candidates.map((m) => m.r.short).join(", ")}.`,
    { intent: "breakaway", riders: candidates.map((m) => m.r.short) });

  // -- tracked riders (live W' display): user squad + the day's protagonists --
  const byMetric = (fn) => [...field.riders].sort((a, b) => fn(b) - fn(a))[0];
  const trackedSet = new Set(candidates.map((m) => m.id));
  trackedSet.add(byMetric((r) => r.sprint).id);
  trackedSet.add(byMetric((r) => r.cp / r.weight).id);
  trackedSet.add(byMetric((r) => r.punch * (r.archetype === "puncheur" ? 1.2 : 1)).id);
  const must = (opts.track && opts.track.length) ? opts.track.filter((id) => states.has(id)) : [];
  const trackedIds = must.length ? [...new Set([...must, ...trackedSet])].slice(0, Math.min(16, must.length + 6)) : [...trackedSet].slice(0, 9);
  const tracked = trackedIds.map((id) => { const r = states.get(id).r;
    return { id, lid: r.lid, name: r.name, short: r.short, team: field.teams[r.teamId].name, jersey: r.jersey, archetype: r.archetype, fresh: r.fresh ?? 100, duty: r.duty || (r.role === "leader" ? "leader" : "domestique") }; });

  const gapOf = (g) => { const pe = groups.find((x) => x.type === "peloton"); return pe ? g.time - pe.time : 0; }; // <0 = ahead of the bunch
  let counterWindow = 0, lastCatchKm = -99;

  // ============================ SEGMENT LOOP =================================
  for (const seg of segs) {
    const kmLeft = L - seg.fromKm;
    const fracDone = seg.fromKm / L;
    groups.sort((a, b) => a.time - b.time); // road order: lowest cumulative time is in front
    const pelo = groups.find((g) => g.type === "peloton");

    // ---- pre-segment tactics --------------------------------------------
    // peloton leash: chase harder the more the (time) gap overshoots what the finish demands
    if (pelo) {
      const front = groups[0];
      const gapSec = Math.max(0, pelo.time - front.time);
      const wantSprint = stage.finishType === "flat" ? 1.0 : stage.finishType === "hilly" ? 0.7 : stage.finishType === "uphill_short" ? 0.55 : 0.4;
      const squeeze = clamp((fracDone - 0.22) / 0.7, 0, 1);
      const bias = tune.breakBias || 0;
      const leash = Math.max(wantSprint - bias * 0.22, 0.22);
      const desired = lerp(195 / leash, bias * 150, squeeze);
      let intent = wantSprint * (0.35 + (gapSec - desired) / 110);
      if (gapSec <= 3) intent = 0.25;
      pelo.intent = clamp(lerp(pelo.intent, intent + 0.05 * gauss(rng) * tune.noise, 0.55), 0.05, 1.12);
      // chase ownership: if no sprint-hungry or GC-threatened workers, the bunch hesitates
      if (gapSec > desired && fracDone < 0.8) {
        const owners = pelo.members.filter((m) => !m.dropped && !m.protectFlag && (m.r.duty === "sprinter" || m.r.role !== "leader") && m.coop > 0.55);
        if (owners.length < 6 && !pelo._hesitated) {
          pelo.intent *= tune.hesitation; pelo._hesitated = true;
          event(seg.fromKm, "tactic", "The bunch looks at each other — nobody wants to own the chase.",
            { cause: "no committed chasers", willingWorkers: owners.length, gapSec: Math.round(gapSec) });
        }
      }
      // commands override (fromKm keys off the PELOTON'S own progress now)
      let force = 0, paceLevel = null;
      for (const c of cmdChases) if (pelo.kmDone >= (c.fromKm || 0)) force = c.level === "hard" ? 1 : -1;
      for (const c of cmdPace) if (pelo.kmDone >= (c.fromKm || 0)) paceLevel = c.level;
      if (force > 0) pelo.intent = Math.max(pelo.intent, 0.98);
      if (force < 0) pelo.intent = Math.min(pelo.intent, 0.36);
      if (paceLevel != null) {
        if (paceLevel <= 0) pelo.intent = Math.min(pelo.intent, 0.30);
        else if (paceLevel === 2) pelo.intent = Math.max(pelo.intent, 0.58);
        else if (paceLevel === 3) pelo.intent = Math.max(pelo.intent, 0.88);
        else if (paceLevel >= 4) pelo.intent = Math.max(pelo.intent, 1.06);
      }
      pelo._tempoPull = null;
      for (const tz of cmdTempo) if (pelo.kmDone >= tz.fromKm && pelo.kmDone < tz.toKm) {
        pelo._tempoPull = new Set(pelo.members.filter((m) => !m.dropped && tz.lidSet.has(m.r.lid)).map((m) => m.id));
        pelo.intent = Math.max(pelo.intent, tz.level === "hard" ? 0.95 : 0.62);
      }
    }
    // break cooperation decays when the game is up (small gap late) or sitters poison it
    for (const g of groups) {
      if (g.type !== "break" && g.type !== "chase") continue;
      const sitters = g.members.filter((m) => (m.satFlag && m.satWork === "sit_on") || m.coop < 0.35).length;
      const gap = -gapOf(g);
      g.coop = clamp(1 - sitters / Math.max(1, g.members.length) * 0.5 - (fracDone > 0.75 && gap < 40 ? 0.25 : 0), 0.35, 1);
      if (g.coop < 0.62 && !g._bickered && fracDone > 0.5) { g._bickered = true; event(seg.fromKm, "tactic", "The break starts bickering — the cooperation is gone.", { cause: "sit-ons refusing pulls", sitters, gapSec: Math.round(gap) }); }
    }

    // commanded drop-backs / ease / move-up (rider's own group decides the trigger)
    for (const c of cmdDrops) {
      if (c.fired) continue; const s = resolveCmd(c); if (!s || s.dropped) { c.fired = true; continue; }
      const g = groups.find((gr) => gr.members.includes(s)); if (!g || g.kmDone < (c.fromKm || 0) || g.members.length <= 1) continue;
      g.members = g.members.filter((m) => m !== s); s.easeFlag = true; s.protectFlag = false;
      addGroup({ id: nextGid++, type: "solo", members: [s], intent: 0.5, time: g.time + 2, kmDone: g.kmDone });
      event(seg.fromKm, "drop", `${s.r.short} eases off the back on team orders.`); c.fired = true;
    }
    for (const c of cmdEase) { const s = resolveCmd(c); if (!s || s.dropped) continue; const g = groups.find((gr) => gr.members.includes(s)); if (g && g.kmDone >= (c.fromKm || 0)) s.protectFlag = true; }
    for (const c of cmdMoveup) { if (c.fired) continue; const s = resolveCmd(c); if (!s) { c.fired = true; continue; } const g = groups.find((gr) => gr.members.includes(s)); if (g && g.kmDone >= (c.fromKm || 0)) { s.position = Math.min(1, s.position + 0.1); c.fired = true; } }

    // satellites drop back to escort the leader
    for (const s of satStates) {
      if (s.satDone || s.dropped || s.finishTime != null) continue;
      const g = groups.find((gr) => gr.members.includes(s));
      if (!g || g.type === "peloton" || g.members.length <= 1) continue;
      let trigger = s.satDropKm != null && g.kmDone >= s.satDropKm;
      if (!trigger && s.satOnBridge && s.satLeaderLid != null) {
        const ls = byLid.get(s.satLeaderLid);
        const lg = ls && !ls.dropped ? groups.find((gr) => gr.members.includes(ls)) : null;
        if (lg && lg !== g && lg.time - g.time < 25 && lg.time - g.time >= 0) trigger = true;
      }
      if (!trigger) continue;
      g.members = g.members.filter((m) => m !== s);
      s.easeFlag = true; s.protectFlag = false; s.satFlag = false; s.satDone = true;
      addGroup({ id: nextGid++, type: "solo", members: [s], intent: 0.6, time: g.time + 2, kmDone: g.kmDone });
      event(seg.fromKm, "tactic", `${s.r.short} sits up to wait for the leader.`, { intent: "escort", leaderLid: s.satLeaderLid });
    }

    // commanded attacks (planned marks + live shouts) — trigger on the rider's own group's progress
    for (const c of cmdAttacks) {
      if (c.fired) continue;
      let m = null, src = null;
      if (c.lid != null) {
        const s = resolveCmd(c); if (!s || s.dropped) { c.fired = true; continue; }
        src = groups.find((g) => g.members.includes(s));
        if (!src || src.kmDone < (c.fromKm || 0)) continue;
        if (src.type === "solo" || s.wBal < 0.12 * s.wMax) { c.fired = true; continue; }
        m = s;
      } else {
        src = pelo; if (!src || src.kmDone < (c.fromKm || 0)) continue;
        const pool = src.members.filter((x) => !x.dropped && x.r.teamId === c.teamId && x.wBal > 0.2 * x.wMax);
        if (!pool.length) { c.fired = true; continue; }
        m = pool.sort((a, b) => (b.r.role === "leader") - (a.r.role === "leader") || b.wBal - a.wBal)[0];
      }
      src.members = src.members.filter((x) => x !== m);
      m.easeFlag = false; m.protectFlag = false; m.surges++;
      m.wBal = Math.max(0, m.wBal - 0.18 * m.wMax);                                  // the jump itself costs a match
      addGroup({ id: nextGid++, type: "solo", members: [m], intent: 1, time: src.time - 10, kmDone: src.kmDone, _dig: c.effort || 1.12 });
      const digWord = (c.effort || 1) >= 1.12 ? `${m.r.name} goes all-in!` : (c.effort || 1) <= 0.9 ? `${m.r.short} probes off the front.` : `${m.r.name} attacks!`;
      event(seg.fromKm, c._bridge ? "tactic" : "attack", c._bridge ? `${m.r.short} bridges across.` : digWord, { source: "team order", wLeft: +(m.wBal / m.wMax).toFixed(2) }, src.time);
      c.fired = true;
    }

    // AI attacks on selective terrain / late flat — personality, W', support, GC caution
    if (pelo && (seg.sel >= 0.3 || (kmLeft < 30 && seg.type !== "descent")) && fracDone > 0.5) {
      const cands = pelo.members.filter((m) => !m.dropped && !m.protectFlag
        && m.wBal > 0.45 * m.wMax && m.E > 0.35
        && (seg.type === "climb" ? ["gc", "climber", "puncheur"].includes(m.r.archetype)
                                 : ["puncheur", "sprinter", "rouleur"].includes(m.r.archetype)));
      for (const m of cands) {
        const support = pelo.members.filter((x) => x.r.teamId === m.r.teamId && x !== m && !x.dropped).length;
        const gcCaution = m.r.role === "leader" && stage.finishType !== "summit" && kmLeft > 35 ? 0.25 : 1; // leaders wait for the money moment
        let p = tune.attackBaseP * seg.sel * m.aggr * gcCaution * (0.8 + support * 0.05) * tune.noise;
        if (counterWindow > 0) p *= tune.counterBoost;
        if (seg.finale) p *= 1.5;
        if (rng() < p) {
          pelo.members = pelo.members.filter((x) => x !== m);
          m.surges++; m.wBal = Math.max(0, m.wBal - 0.18 * m.wMax);
          addGroup({ id: nextGid++, type: "solo", members: [m], intent: 1, time: pelo.time - 10, kmDone: pelo.kmDone, _dig: 1.14 });
          event(seg.fromKm, "attack", counterWindow > 0 ? `${m.r.name} counter-attacks immediately!` : `${m.r.name} attacks${seg.type === "climb" ? " on the " + (seg.cat ? "cat " + seg.cat + " " : "") + "climb" : ""}!`,
            { archetype: m.r.archetype, wLeft: +(m.wBal / m.wMax).toFixed(2), selectivity: +seg.sel.toFixed(2), counter: counterWindow > 0 }, pelo.time);
          counterWindow = 0;
          break;
        }
      }
    }
    if (counterWindow > 0) counterWindow--;

    // lead-out train forms on the peloton's own run-in
    if (leadoutCmd && pelo) {
      const sp = byLid.get(leadoutCmd.sprinterLid);
      pelo._train = null;
      if (sp && !sp.dropped && pelo.members.includes(sp) && pelo.kmDone + seg.km >= (leadoutCmd.hitFromKm || 0)) {
        const train = (leadoutCmd.train || []).map((l) => byLid.get(l)).filter((s) => s && pelo.members.includes(s) && !s.dropped);
        pelo._train = new Set(train.map((s) => s.id));
        sp.protectFlag = true; sp.position = Math.min(1, sp.position + 0.08);
        for (const ts of train) ts.position = Math.min(1, ts.position + 0.05);
        pelo.intent = Math.max(pelo.intent, 0.72);
        if (!pelo._trainOn) { pelo._trainOn = true; event(seg.fromKm, "tactic", `The train hits the front for ${sp.r.short}.`, { train: train.map((t) => t.r.short) }); }
        if (pelo.kmDone + seg.km >= (leadoutCmd.launchKm || 0) && !sp.launched) {
          const finalLO = train[train.length - 1]; if (finalLO) finalLO.protectFlag = false;
          sp.launched = true; sp.protectFlag = false; sp.launchDist = Math.max(0.1, L - (leadoutCmd.launchKm || L - 0.3));
          event(Math.min(leadoutCmd.launchKm || L, L), "tactic", `${sp.r.short} launches the sprint!`, { launchKmOut: +(L - (leadoutCmd.launchKm || 0)).toFixed(1) });
        }
      }
    }

    // ---- resolve the segment for every group ------------------------------
    groups.sort((a, b) => a.time - b.time);
    for (const g of groups) g._tPrev = g.time;      // order before the segment — crossings must merge, not ghost through
    const born = [];
    for (const g of [...groups]) {
      // effort
      let effort;
      if (g.type === "break" || g.type === "solo" || g.type === "chase") {
        const act = g.members.filter((m) => !m.dropped);
        const wpct = act.length ? act.reduce((s, m) => s + m.wBal / m.wMax, 0) / act.length : 1;
        effort = tune.breakCommitment * (g.type === "chase" ? 1.03 : 1.0) * (0.88 + 0.12 * wpct) * (g.coop ?? 1);
        if (g._dig) { effort *= g._dig; g._dig = Math.max(1, g._dig - 0.04); }        // the initial dig fades to a rhythm
        if (g.members.some((m) => m.easeFlag)) effort = Math.min(effort, 0.8);
      } else if (g.type === "grupetto") effort = 0.88;                       // the autobus rides real tempo — it has a time cut to beat
      else {
        effort = seg.type === "climb" ? lerp(0.97, 1.05, g.intent) * (1 + (tune.climbSelectivity - 1) * 0.45) : lerp(0.80, 1.07, g.intent);   // selectivity compressed: sustained 30%-over-CP was draining every W′ tank to zero
        const act2 = g.members.filter((m) => !m.dropped).length;
        if (seg.type === "climb" && act2 <= 12) effort = Math.min(effort, 1.06);   // once the selection is made, the favorites ride tempo + attacks — not 25% over CP
      }

      const v = paceSolve(g, seg, effort, tune);
      const segTime = seg.km * 1000 / Math.max(v, 2);
      g.speed = v;

      // per-rider cost: workers pay the rotation, the sheltered pay the draft
      const active = g.members.filter((m) => !m.dropped);
      const workers = g._workers || new Set(active.map((m) => m.id));
      const nP = Math.max(1, [...workers].length);
      const dShelter = draftFactor(active.length, seg.grad, tune) / (TERRAIN[seg.type]?.draftMul >= 1 ? 1 : 1) * 1; // base shelter
      const surfMul = TERRAIN[seg.type]?.draftMul ?? 1;                                // pavé/wind: shelter is worth less
      const dPull = draftFactor(nP, seg.grad, tune);
      const drainMulSeg = tune[TERRAIN[seg.type]?.drainKey ?? "drainFlat"];
      for (const m of active) {
        const isWork = workers.has(m.id) && !((m.r.role === "leader" || m.protectFlag) && g.type === "peloton");
        m.pulling = isWork;
        const dEff = isWork ? dPull : lerp(1, dShelter, surfMul);
        let P = isWork
          ? powerAt(v, seg.grad, m.r.cdA, 1.0, m.r.massKg) / nP + powerAt(v, seg.grad, m.r.cdA, dPull, m.r.massKg) * (1 - 1 / nP)
          : powerAt(v, seg.grad, m.r.cdA, dEff, m.r.massKg);
        if (seg.type === "cobbles" || seg.type === "gravel") P *= 1.1 - (m.r.cobbleSkill ?? cobbleSkill(m.r)) * 0.18; // skill saves watts on the stones
        const ce = cpEff(m, tune);
        const over = P - ce;
        if (over > 0) m.wBal = Math.max(0, m.wBal - over * segTime);
        else m.wBal = Math.min(recover(m.wBal, m.wMax, -over, segTime, tune),
                               m.wMax * clamp(0.5 + 0.5 * m.E, 0.5, 1));   // deep energy debt caps the recharge — cooked riders run out of matches
        const intensity = P / Math.max(ce, 1);
        m.E = Math.max(0, m.E - (seg.km / L) * Math.pow(Math.max(intensity, 0.55), 2.2) * drainMulSeg * m.drain);
        m.effortHist.push(+intensity.toFixed(2)); if (m.effortHist.length > 6) m.effortHist.shift();
        m._P = P; m._over = over;
      }

      // cracks: on selective terrain, riders who can't hold the sheltered wheel lose contact
      if (seg.sel >= tune.crackSel && g.type !== "grupetto" && g.type !== "solo" && active.length > 1) {
        const cracked = active.filter((m) => {
          if (m.r.role === "leader" && g.type !== "peloton") return false;
          const need = powerAt(v, seg.grad, m.r.cdA, dShelter, m.r.massKg);
          return (m.wBal <= 1 && need > cpEff(m, tune) * 1.005) || m.E <= 0.06;
        });
        if (cracked.length && cracked.length < active.length) {
          for (const m of cracked) { m.cracked = true; }
          g.members = g.members.filter((m) => !cracked.includes(m));
          const worst = cracked.reduce((s, m) => s + clamp((powerAt(v, seg.grad, m.r.cdA, dShelter, m.r.massKg) / cpEff(m, tune) - 1) * 2.2, 0.02, 0.1), 0) / cracked.length;
          born.push({ id: nextGid++, type: g.type === "peloton" ? "grupetto" : "chase",
                      members: cracked, intent: 0.5, time: g.time + segTime * (1 + worst) + 3, kmDone: seg.toKm, _bornSeg: seg });
          const star = cracked.filter((m) => m.r.role === "leader" || (m.r.cp / m.r.weight) > 5.9).sort((a, b) => b.r.cp - a.r.cp)[0];
          if (star) event(seg.fromKm + seg.km / 2, "drop", `${star.r.name} cracks${seg.type === "climb" ? " on the climb" : ""}!`,
            { energy: +star.E.toFixed(2), wLeft: +(star.wBal / star.wMax).toFixed(2), selectivity: +seg.sel.toFixed(2) }, g.time + segTime * 0.5);
          else if (seg.type === "climb" && (stage.finishType === "summit" || stage.finishType === "uphill_short"))
            event(seg.fromKm + seg.km / 2, "drop", "Riders are being shelled on the climb.", { dropped: cracked.length }, g.time + segTime * 0.5);
        }
      }

      // pavé / gravel sector chaos: time losses + mechanicals (incidents only — seeded)
      if ((seg.type === "cobbles" || seg.type === "gravel") && active.length) {
        for (const m of g.members) {
          if (m.dropped) continue;
          const sk = seg.type === "gravel" ? (m.r.gravelSkill ?? 0.5) : (m.r.cobbleSkill ?? cobbleSkill(m.r));
          m._secLoss = (1 - sk) * seg.km * (2.2 + rng() * 3.2) * tune.noise;         // seconds vs the group over this sector
          if (rng() < tune.mechP * (1.3 - (m.r.handling ?? 0.6))) {
            m._secLoss += 25 + rng() * 45;
            if (trackedIds.includes(m.id) || m.r.role === "leader") event(seg.fromKm, "weather", `${m.r.short} punctures on the ${seg.sector || "sector"}!`, { sector: seg.sector, kmLeft: Math.round(kmLeft) });
          }
        }
        // riders losing real time split off the back of the group
        const losers = g.members.filter((m) => !m.dropped && (m._secLoss || 0) > 9 && g.members.length > 2 && !((m.r.role === "leader" || m.protectFlag) && (m._secLoss || 0) < 14));
        if (losers.length && losers.length < g.members.length) {
          g.members = g.members.filter((m) => !losers.includes(m));
          const avgLoss = losers.reduce((s, m) => s + m._secLoss, 0) / losers.length;
          born.push({ id: nextGid++, type: g.type === "peloton" ? "grupetto" : "chase", members: losers, intent: 0.7, time: g.time + segTime + avgLoss, kmDone: seg.toKm, _bornSeg: seg });
          if (g.type === "peloton") event(seg.fromKm, "drop", `The ${seg.type === "gravel" ? "gravel" : "pavé"} splits the bunch — ${losers.length} distanced.`, { sector: seg.sector, avgLossSec: Math.round(avgLoss) });
        }
        for (const m of g.members) m._secLoss = 0;
      }

      // echelons in the crosswind zone
      if (seg.type === "wind" && g.type === "peloton" && g.members.length > 10 && rng() < tune.echelonP * (0.6 + (stage.wind || 0))) {
        const scored = g.members.filter((m) => !m.dropped).map((m) => ({ m, s: (m.r.cobbleSkill ?? cobbleSkill(m.r)) * 0.42 + (m.r.handling ?? 0.6) * 0.16 + (m.position - 0.5) * 0.3 + clamp((m.r.cp - 380) / 200, 0, 0.25) + rng() * 0.5 }));
        scored.sort((a, b) => b.s - a.s);
        const frontN = Math.max(6, Math.round(scored.length * (0.2 + rng() * 0.22)));
        const shelled = scored.slice(frontN).map((x) => x.m);
        if (shelled.length >= 4) {
          g.members = g.members.filter((m) => !shelled.includes(m));
          const gapAdd = (30 + rng() * 80) * (0.6 + (stage.wind || 0));
          born.push({ id: nextGid++, type: "grupetto", members: shelled, intent: 0.75, time: g.time + segTime + gapAdd, kmDone: seg.toKm, _bornSeg: seg });
          event(seg.fromKm, "weather", `Echelons! The bunch splits in the crosswind — ${shelled.length} riders caught out.`, { wind: stage.wind, frontGroup: frontN, gapSec: Math.round(gapAdd) });
        }
      }

      // advance the clock
      g.time += segTime;
      g.kmDone = seg.toKm;
      g.hist = g.hist || [];
      g.hist.push({ i: seg.i, fromKm: seg.fromKm, toKm: seg.toKm, tIn: g.time - segTime, tOut: g.time, v, n: g.members.length, type: g.type,
        jersey: g.members[0]?.r.jersey ?? "#888", lead: (g.members.slice().sort((a, b) => b.r.cp - a.r.cp)[0]?.r.short) ?? "",
        w: trackedIds.map((id) => { const s = states.get(id); return g.members.includes(s) ? +(s.wBal / s.wMax).toFixed(3) : null; }),
        e: trackedIds.map((id) => { const s = states.get(id); return g.members.includes(s) ? +clamp(s.E, 0, 1).toFixed(3) : null; }) });
    }

    for (const ng of born) {
      ng.hist = [{ i: seg.i, fromKm: seg.fromKm, toKm: seg.toKm, tIn: ng.time - (seg.km * 1000 / 9), tOut: ng.time, v: 9, n: ng.members.length,
        type: ng.type, jersey: ng.members[0]?.r.jersey ?? "#888", lead: (ng.members.slice().sort((a, b) => b.r.cp - a.r.cp)[0]?.r.short) ?? "",
        w: trackedIds.map((id) => { const st2 = states.get(id); return ng.members.includes(st2) ? +(st2.wBal / st2.wMax).toFixed(3) : null; }),
        e: trackedIds.map((id) => { const st2 = states.get(id); return ng.members.includes(st2) ? +clamp(st2.E, 0, 1).toFixed(3) : null; }) }];
      delete ng._bornSeg;
      ng._tPrev = null;                       // born mid-segment — crossing math starts next segment
      addGroup(ng);
    }

    // ---- catches & merges (time-based) ------------------------------------
    const mergePair = (gA, gB) => {
      const ahead = gA.time <= gB.time ? gA : gB, behind = ahead === gA ? gB : gA;
      const keep = behind.type === "peloton" || (ahead.type !== "peloton" && behind.members.length >= ahead.members.length) ? behind : ahead;
      const gone = keep === behind ? ahead : behind;
      const goneMembers = gone.members, goneType = gone.type;
      keep.time = Math.min(ahead.time, behind.time);
      keep.members = keep.members.concat(goneMembers);
      gone.members = []; gone._endT = keep.time;
      if ((goneType === "break" || goneType === "solo") && keep.type === "peloton") {
        event(seg.toKm, "catch", `The peloton swallows the ${goneType === "solo" ? "lone leader" : "break"} with ${(L - seg.toKm).toFixed(0)} km to go.`, { kmToGo: +(L - seg.toKm).toFixed(0) }, keep.time);
        counterWindow = 2; lastCatchKm = seg.toKm;
      } else if (goneType === "solo") event(seg.toKm, "catch", `${goneMembers[0]?.r?.short ?? "The attacker"} is brought back.`, null, keep.time);
      else if (goneType === "chase" && (keep.type === "break" || keep.type === "solo")) event(seg.toKm, "tactic", "The chasers make the junction — a bigger group forms at the front.", { size: keep.members.length }, keep.time);
    };
    groups.sort((a, b) => a.time - b.time);
    for (let i = 1; i < groups.length; i++) {
      const ahead = groups[i - 1], behind = groups[i];
      if (!ahead.members.length || !behind.members.length) continue;
      if (behind.time - ahead.time <= 1.5) mergePair(ahead, behind);
    }
    // pass-throughs: if two groups swapped road order this segment they physically met — merge them
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const A = groups[i], B = groups[j];
      if (!A.members.length || !B.members.length || A._tPrev == null || B._tPrev == null) continue;
      if ((A._tPrev - B._tPrev) * (A.time - B.time) < 0) mergePair(A, B);
    }
    for (let i = groups.length - 1; i >= 0; i--) if (!groups[i].members.length) groups.splice(i, 1);

    // gap trace (front group vs peloton)
    const pe2 = groups.find((g) => g.type === "peloton");
    const front2 = groups[0];
    if (pe2 && front2 && front2 !== pe2) gapTrace.push({ km: +seg.toKm.toFixed(1), gapSec: Math.round(Math.max(0, pe2.time - front2.time)) });
    raceT = pe2 ? pe2.time : groups[0]?.time ?? raceT;
    if (opts.trace) hist.push({ seg: seg.i, km: seg.toKm, groups: groups.map((g) => ({ type: g.type, n: g.members.length, t: +g.time.toFixed(1), intent: +(g.intent ?? 0).toFixed(2) })) });
  }

  // ============================ FINISH =======================================
  groups.sort((a, b) => a.time - b.time);
  for (const g of groups) {
    const order = sprintOrder(g, stage, rng, tune);
    order.forEach((m) => { m.finishTime = g.time; m.place = finishers.length + 1; finishers.push(m); });
  }
  const results = finishers.map((m, i) => ({
    place: i + 1, id: m.id, name: m.r.name, short: m.r.short,
    team: field.teams[m.r.teamId].name, jersey: m.r.jersey, archetype: m.r.archetype,
    timeSec: m.finishTime, wPctLeft: Math.round(100 * m.wBal / m.wMax), energyLeft: Math.round(100 * clamp(m.E, 0, 1)),
  }));
  const winT = results.length ? results[0].timeSec : 0;
  results.forEach((r) => (r.gapSec = Math.max(0, Math.round(r.timeSec - winT))));
  if (results.length) {
    const w = finishers[0];
    const wg = groups.find((g) => g.members.includes(w)) || groups[0];
    event(L, "win", `${w.r.name} (${field.teams[w.r.teamId].name}) wins the stage ${describeFinish(wg, stage)}.`,
      { fromGroup: wg.type, groupSize: wg.members.length, wLeft: +(w.wBal / w.wMax).toFixed(2) }, w.finishTime);
  }

  // ============================ PLAYBACK FRAMES ==============================
  const frames = [];
  if (opts.frames !== false) {
    const withHist = allGroups.filter((g) => g.hist && g.hist.length);
    const allHists = withHist.map((g) => g.hist);
    const tEnd = Math.max(...groups.map((g) => g.time), 1);
    const posAt = (h, t) => {
      for (const rec of h) if (t <= rec.tOut) { if (t < rec.tIn) return { km: rec.fromKm, rec }; const f = (t - rec.tIn) / Math.max(rec.tOut - rec.tIn, 1); return { km: rec.fromKm + f * (rec.toKm - rec.fromKm), rec }; }
      const last = h[h.length - 1]; return { km: last.toKm, rec: last };
    };
    let prevLead = 0;
    for (let t = 0; t <= tEnd; ) {
      const gsnap = [];
      let leadKm = 0, leadV = 12;
      for (const g of withHist) {
        if (g._endT != null && t > g._endT) continue;                 // caught — the dot disappears at the catch
        if (t < g.hist[0].tIn - 0.01) continue;                       // not born yet — a late attacker has no dot before it launches
        const { km, rec } = posAt(g.hist, t);
        const tin = rec.w.map((w2, ti) => (w2 != null ? ti : -1)).filter((ti) => ti >= 0);
        gsnap.push({ gid: g.id, posKm: +Math.min(km, L).toFixed(2), n: rec.n, type: rec.type, jersey: rec.jersey, lead: rec.lead, spd: +(rec.v * 3.6).toFixed(1), tin });
        if (km > leadKm) { leadKm = km; leadV = rec.v; }
      }
      for (const g2 of gsnap) g2.gapSec = Math.round(Math.max(0, (leadKm - g2.posKm) * 1000 / Math.max(leadV, 7)));
      const br = gsnap.filter((g) => g.type !== "peloton" && g.type !== "grupetto").sort((a, b) => b.posKm - a.posKm)[0];
      const pe = gsnap.find((g) => g.type === "peloton");
      const gapSec = br && pe ? Math.max(0, (br.posKm - pe.posKm) * 1000 / Math.max(leadV, 7)) : 0;
      prevLead = Math.max(prevLead, Math.min(leadKm, L));   // the race's furthest point never rolls back (a caught front group vanishes)
      frames.push({
        t, leadKm: +prevLead.toFixed(2), gapSec: Math.round(gapSec),
        groups: gsnap,
        w: trackedIds.map((id) => { const s = states.get(id); return +(s.wBal / s.wMax).toFixed(3); }),
        track: trackedIds.map((id) => {
          const s = states.get(id);
          const h = allHists.find((hh) => hh.some((rec) => rec.w[trackedIds.indexOf(id)] != null && rec.tIn <= t && t <= rec.tOut));
          let km = leadKm, gType = s.finishTime != null && t >= s.finishTime ? "fin" : "peloton", pulling = false, wNow = s.wBal / s.wMax;
          let eNow = clamp(s.E, 0, 1);
          if (h) { const { km: k2, rec } = posAt(h, t); km = k2; gType = rec.type; const wi = rec.w[trackedIds.indexOf(id)]; if (wi != null) wNow = wi; const ei = rec.e?.[trackedIds.indexOf(id)]; if (ei != null) eNow = ei; }
          const gap = Math.max(0, (leadKm - km) * 1000 / Math.max(leadV, 7));
          return { w: +wNow.toFixed(3), e: +eNow.toFixed(3), gType, gapSec: Math.round(gap), dropped: !!s.cracked, posKm: +Math.min(km, L).toFixed(2), pulling: !!s.pulling, effort: s._P ? +(s._P / s.r.cp).toFixed(2) : 0 };
        }),
      });
      t += leadKm > L - 25 ? tune.frameDt / 3 : tune.frameDt;         // the finale deserves smooth motion
    }
  }

  const durationSec = groups.length ? Math.max(...groups.map((g) => g.time)) : 0;
  const out = { results, log, gapTrace, frames, tracked, durationSec, stage, explain,
    riderSummary: results.slice(0, 40).map((r) => ({ id: r.id, short: r.short, wPctLeft: r.wPctLeft, energyLeft: r.energyLeft })) };
  if (opts.trace) out.trace = hist;
  return out;
}


// classics/cobbles aptitude: powerful hard men excel on pavé and in echelons; light climbers struggle
export function cobbleSkill(r) {
  const base = ({ rouleur: 0.9, puncheur: 0.8, leadout: 0.62, sprinter: 0.5, helper: 0.55, gc: 0.42, climber: 0.25 })[r.archetype] ?? 0.5;
  return clamp(base + clamp((r.cp - 380) / 200, -0.12, 0.12), 0.1, 0.98);
}

// individual time trial: no drafting, against the clock. sustained power vs aero + gradient.
export function simulateITT(field, stage, seed, tune = DEFAULT_TUNE) {
  const rng = makeRng((seed ^ 0x7777) >>> 0);
  const segs = stage.segments, distM = stage.lengthKm * 1000;
  const aeroMult = { gc: 0.93, rouleur: 0.92, puncheur: 0.99, leadout: 0.98, sprinter: 1.04, helper: 1.0, climber: 1.05 }; // TT position: specialists tuck low; only bites on flat, not on the climbs
  const rows = field.riders.map((r) => {
    const cp = r.cp, wp = r.wPrime * (tune.wPrimeScale || 1), cdA = r.cdA * (aeroMult[r.archetype] ?? 1.0), mass = r.massKg;
    let T = distM / 13;                                    // ~47 km/h first guess
    for (let it = 0; it < 4; it++) {
      const ttP = cp + (wp / Math.max(240, T)) * 0.85;     // pace just over threshold, spend a slice of W' across the effort
      let t = 0;
      for (const [a, b, s] of segs) { const v = speedForPower(ttP, s, cdA, 1.0, mass); t += ((b - a) * 1000) / Math.max(2, v); }
      T = t;
    }
    const craft = 1 - ((r.threshold - 70) / 100) * 0.02;   // steadier engines pace marginally better
    const time = T * craft * (1 + (rng() * 2 - 1) * 0.012);
    return { r, time };
  });
  rows.sort((a, b) => a.time - b.time);
  const win = rows[0].time;
  const results = rows.map((row, i) => { const r = row.r; return {
    place: i + 1, id: r.id, name: r.name, short: r.short, team: field.teams[r.teamId].name,
    jersey: r.jersey || field.teams[r.teamId]?.jersey, archetype: r.archetype,
    timeSec: row.time, wPctLeft: clamp(Math.round(16 + rng() * 22), 5, 45),
    gapSec: Math.max(0, Math.round(row.time - win)),
  }; });
  return { results, log: [], gapTrace: [], frames: [], tracked: [], durationSec: Math.round(win), stage, mode: "itt" };
}

// finishing order within a group reaching the line
function sprintOrder(group, stage, rng, tune) {
  const ft = stage.finishType;
  const sprintW = ft === "flat" ? 1.0 : ft === "hilly" ? 0.85 : ft === "uphill_short" ? 0.45 : 0.1;
  const climbW  = ft === "summit" ? 1.0 : ft === "uphill_short" ? 0.8 : 0.15;
  const posW    = ft === "flat" ? 0.7 : ft === "hilly" ? 0.45 : ft === "uphill_short" ? 0.25 : 0.12; // delivery matters most in bunch sprints
  return [...group.members].filter((m) => m.finishTime == null).map((m) => {
    const wkg = m.r.cp / m.r.weight;                 // climbing strength right now
    const fresh = m.wBal / m.wMax;
    const launchFade = m.launched ? 0.9 * clamp((m.launchDist - 0.35) / 1.6, 0, 1) : 0; // jumped too early → faded
    const score =
      sprintW * (m.r.sprint / 100) +
      climbW  * ((wkg - 4.4) / 2.4) +                // normalize ~4.4..6.8 W/kg
      0.6 * fresh +                                  // tired riders fade
      posW * ((m.position ?? 0.5) - 0.5) +           // a good lead-out delivers position; neutral at 0.5
      0.18 * (m.r.punch / 100) - launchFade +
      0.12 * gauss(rng) * tune.noise;
    return { m, score };
  }).sort((a, b) => b.score - a.score).map((x) => x.m);
}

function describeFinish(group, stage) {
  const n = group.members.length;
  if (n === 1) return "solo";
  if (n <= 6) return `from a group of ${n}`;
  return stage.finishType === "summit" ? "from a select group" : "in a bunch sprint";
}

export function fmtGap(sec) {
  if (sec <= 0) return "—";
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `+${m}:${String(s).padStart(2, "0")}` : `+${s}s`;
}
export function fmtTime(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

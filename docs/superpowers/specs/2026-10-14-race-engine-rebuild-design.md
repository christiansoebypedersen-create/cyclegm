# Race Engine Rebuild — Design

**Date:** 2026-10-14
**Status:** Approved in brainstorming (approach B), pending spec review

## 1. Goal

Replace CycleGM's race simulation with a realistic, phase-based engine where:

- Terrain specialists win their terrain: sprinters on flat stages, puncheurs on punchy finishes, climbers/GC riders on summits, cobble riders on cobbles, TT specialists in flat TTs.
- Breakaways happen and succeed at real-world rates per terrain.
- The player's **pre-race strategy** decides races "to an extreme degree": a weaker team with the right plan beats a stronger team with the wrong plan.
- **Race-day condition** (form, fatigue, morale, plus an unpredictable daily swing) is integral to performance.
- There is **no live race viewer**. A race is simulated instantly and explained with an FM-style race report.

### Non-goals
- Gravel, crosswinds/echelons, descent finishes and team time trials (deferred).
- Any real-time/mid-race player input.

## 2. Why — measured failures of the current engine

30 seeds per preset on the real 2026 peloton (`runStage`):

| Terrain | Current behaviour | Problem |
|---|---|---|
| Flat | Sprinters win; break 0/30 | Break never survives |
| Hilly | J. Milan (pure sprinter) wins 11/20; 10th on winner's time | No selection on climbs |
| Summit | 10th on winner's time; Matthews wins summits; Pogačar 0 wins | No selection; wrong winners |
| Cobbles | Sprinters win 18/20; full bunch finish | Cobbles don't split the race |
| ITT | Ganna 17/20 | Too deterministic, ignores course |

Root cause: selection never happens. Climbs and cobbles don't split the field, so the fastest finisher of a large group wins nearly everything. This is structural, not a tuning issue.

## 3. Architecture

A phase-based "race director". Instead of physically integrating every segment, the engine evaluates the moments that decide pro races. At each one, riders' terrain strengths, energy and the teams' strategies decide what happens. W/kg physics converts strength differences into credible time gaps.

### Module layout (new `src/race/`)
The old `engine.mjs` grew to ~1,000 lines with tangled responsibilities. The rebuild splits it into focused units:

| Module | Responsibility |
|---|---|
| `race/condition.mjs` | Race-day condition per rider (form, fatigue, morale, daily swing) |
| `race/strengths.mjs` | Terrain strengths from stats × condition |
| `race/classify.mjs` | Stage → terrain type (`flat`, `hilly`, `punch`, `medium`, `summit`, `cobbles`, `itt`) + key features (categorised climbs, cobble sectors, finale). Works for both the real stage records and the procedural profiles |
| `race/strategy.mjs` | Strategy model: objectives, roles, triggers; AI team plans |
| `race/breakaway.mjs` | Break formation + chase/control game |
| `race/selection.mjs` | Climbs / cobble sectors / punchy hills: who's dropped, attacks, splits, punctures |
| `race/finish.mjs` | Bunch sprint, uphill kick, summit, small-group/solo finales |
| `race/itt.mjs` | Course-aware individual time trial |
| `race/gaps.mjs` | W/kg physics → seconds; 3 km / same-time rules |
| `race/report.mjs` | Structured events → race story, key moments, player-rider outcomes |
| `race/index.mjs` | `simulateRace()` orchestration |

`engine.mjs` remains as the compatibility façade: it keeps the physics helpers (`powerAt`, `derivePhysicals`, `makeRng`, `fmtGap`, `fmtTime`, `buildField`, `syncShadows`, `ABIL_KEYS`, …) and its `simulate()` / `simulateITT()` delegate to `race/index.mjs`.

### Determinism
All randomness comes from the seeded RNG (`makeRng`). The same seed, field and strategies always give the same result.

## 4. Race-day condition

Computed per rider per race (per stage in tours) as a multiplier on power-based strengths:

| Input | Effect (initial calibration) |
|---|---|
| Form (periodized, existing `periodizedForm`) | Main driver, about ±4% |
| Fatigue (persistent 0–100) | Nonlinear: under 2% below 50, rising to −8–10% at 100 |
| Morale + confidence | About ±1.5% |
| Daily swing | Usually σ ≈ 1%, with fat tails: **jour sans** about 4% chance (−5 to −10%) and **super day** about 2% (+2–4%). Bad-day odds rise late in a tour and with high fatigue |
| In-stage durability | Performance drops with work done in the stage: about −2–3% after moderate work and −6–10% after heavy work. A durability trait (stamina/recovery) cuts the loss |

**Visibility.** Form, fatigue and morale are shown before the race. The daily swing is hidden until the report reveals it ("X had a jour sans on the final climb and lost 2:40").

Condition multiplies the power-based strengths, so it matters most on summits and TTs and least in bunch sprints, where position and lead-out dominate.

## 5. Terrain strengths

Derived per race from abilities, physicals (CP/W′/weight) and condition:

- **climb**: sustainable W/kg for 20–40 min climbs (anchors: GC elite 6.4–7.0, good climbers ≈5.9, sprinters ≈5.0)
- **punch**: 2–5 min W/kg (anchor: winning a Mur de Huy-type finish ≈8.5–9 W/kg)
- **sprint**: peak power/speed plus positioning
- **cobble**: cobbles ability + handling + **absolute** power (weight is an asset, not a cost)
- **tt**: TT ability + aero + CP (W/kg on climbing TTs)
- **flat**: absolute power for pulling and chasing
- **positioning**: being at the front at key moments
- **durability**: resistance to in-stage fatigue

## 6. The phases

Each rider also has a **stage energy budget**. Pulling, chasing, being in the break, attacking and fighting for position all spend it; a drained rider loses strength in later phases.

### 6.1 Break formation
- Candidates: riders with the **Breakaway** role, plus AI opportunists from teams with nothing to race for.
- Size depends on terrain: about 4 on flat days, up to 15–20 on high-mountain days. Harder terrain gives bigger, stronger breaks that take longer to form.

### 6.2 Control / chase
- Each team decides, from its plan, whether to **chase hard / control / share / ignore**.
- Chase capacity = Σ(committed domestiques' flat power × energy). It closes about 6–9 s/km on flat terrain, less with a cohesive break, and slows sharply on climbs (the chase is only as fast as its slowest committed rider).
- Teams aim to hold the gap at 3–4 min and catch inside the last 5–10 km. Catching too early triggers counter-attacks.
- **If nobody with an interest chases, the break wins.** A teammate in the break makes the team stop chasing and raises success odds.
- Late in a tour, success odds rise (fatigue, riders out of GC contention, depleted sprint teams).

### 6.3 Selections
At every climb, cobble sector and punchy hill:
- The pace is set by tempo-riding teams or by attacks. Riders whose relevant strength (× energy) is below the required level are dropped. Time lost per km comes from W/kg physics (`gaps.mjs`).
- **Cobbles:** riders without positioning or nearby teammates risk being caught behind a split; punctures happen (frequent among contenders) and teammates or the team car limit the loss.
- **Attacks:** triggered attacks fire at their chosen feature. Success depends on the attacker's strength and energy versus the chasers' strength and cooperation. Attacking too early drains energy and leads to cracking.
- Sprinters fall into the grupetto on mountain stages; the time limit applies.

### 6.4 Finish
The arriving group decides the finish type:
- **Large group on flat → bunch sprint.** Sprint strength × positioning × lead-out teammates still present (more teammates near the sprinter in the last minute strongly raises win odds). Uphill drags above ~4–5% shift weight to punch.
- **Uphill kick:** punch W/kg over the last 1–3 km; gaps of seconds.
- **Summit:** climb W/kg over the final climb; gaps of minutes.
- **Small group / solo:** finale attacks; a sprinter in a small group can still win.
- **Same-time rules:** bunch finishes give the same time; the 3 km rule neutralises late incidents on flat stages.

### 6.5 Individual time trial
Course-aware: on flat courses, aero/absolute power and TT skill dominate (specialist to GC rider ≈0.5–1.5 s/km; sprinters 10–15 s/km slower). Climbs in the course shift the order toward W/kg. Condition matters a lot here.

## 7. Strategy model

### Team objective (per race/stage)
`sprint` · `breakaway` · `gc` (protect leader / gain time) · `selection` (stage win from the selection: attack on a climb, sector or the finale) · `rest` (save energy)

### Rider roles
`leader` · `coleader` (protected) · `leadout` · `breakaway` · `domestique` · `free`

### Triggers
- **Attack point:** none / a specific climb or cobble sector (chosen from classified features) / final km. Applies to leader, co-leader, free and breakaway riders.
- **Chase policy (team):** chase hard / control / share the work / ignore.
- **Fight for position before key sectors:** lowers split and puncture losses, costs energy.

### AI teams
Every AI team gets a plan from the same model, based on its riders versus the stage (sprint teams chase on flat days, GC teams control on mountain days, opportunists go in breaks). Rival interests are what make outcomes fair and brutal: whether anyone else will chase is a real, readable part of the game.

### What a wrong plan costs

| Wrong call | Consequence |
|---|---|
| Sprint team doesn't chase, and nobody else does | Break stays away |
| Too few domestiques committed | Chase dies late |
| Leader unprotected / out of position on cobbles | Caught behind a split, loses minutes |
| Attacking too far out | Energy drained, caught and dropped |
| Sprinter with no lead-out | Poor position, much weaker sprint |
| Sprinter as leader on a summit | Dropped early; team rode for nothing |

## 8. Output & compatibility

`simulate()` still returns:
- `results[]`: `{ place, id, lid, name, short, team, jersey, archetype, timeSec, gapSec, ... }`
- `log[]`: `{ t, km, kind, text, why }` (existing kinds kept: `break`, `catch`, `drop`, `attack`, `win`)

New:
- `report`: `{ story: string[], moments: [{ km, kind, text, riders[] }], condition: { [lid]: { value, daySwing, label } }, teamPlans: {...}, playerOutcomes: [{ lid, role, instruction, outcome, why }] }`
- `climbCrests`: `[{ km, order: [lid…] }]`: the real order over each classified climb (break riders crest first). gm's KOM scoring uses it when present and falls back to its current `climbCresterScore` heuristic otherwise, so KOM points go to the riders actually at the front.

Dropped: animation `frames`.

**Consumers to keep working (verified):** jersey, points, KOM, youth and team classifications in `commitRaceResult` read only `results` (rider order + `timeSec`) plus gm-side heuristics, so they keep working unchanged. Also: `runStage` / `fastResolve` (AI season sims), standings, GC, prizes, inbox race reports, and `recommendTactics` / `compileTactic` (re-pointed to the new strategy model).

## 9. UI

Race weekend becomes: **Pick riders → Strategy screen → Simulate → Race report.**

- **Strategy screen:** objective, per-rider roles and triggers, with the stage profile showing key features (climbs, sectors, finale) that attack triggers can target. Shows form, fatigue and morale per rider, and a short preview of rival intentions (e.g. "3 sprint teams will chase").
- **Race report:** written story, key-moments timeline with km markers, the player's riders' outcomes against their instructions, plus results, GC and jerseys. Stage races repeat this per stage.
- **Removed:** `RaceView` (live viewer), `TimeTrialView` animation and the in-race command UI. The static `RaceProfile` is kept for the strategy screen.

## 10. Calibration targets

Real-world anchors (sources in the research notes, §13). Bands are for the game's sim and are the test thresholds.

### Breakaway success (no strategy distortion, AI plans only)
| Terrain | Real-world | Target band |
|---|---|---|
| Flat | ≈2% (TdF) | 1–8% |
| Hilly | between flat and medium mountain | 25–50% |
| Medium mountain | "almost half" | 35–55% |
| Summit finish | "over half" of mountain stages overall; fewer on summit finishes with GC interest | 20–45% |
| Punchy uphill finish | rare (Flèche: last break win 2003) | 0–15% |
| Tours | +≈2% per stage number | rises with stage index |

### Winner profile (when the break doesn't win)
| Terrain | Target |
|---|---|
| Flat | sprinter/lead-out ≥ 80% |
| Hilly | puncheur / fast all-rounder majority; pure sprinter ≤ 15% |
| Punchy finish | puncheur/GC ≥ 85%; sprinter ≤ 5% |
| Medium mountain | climber/GC/puncheur ≥ 85% |
| Summit | climber/GC ≥ 90%; strongest climbers (top climb W/kg) win most |
| Cobbles | high-cobbles specialists ≥ 70%; pure sprinters ≤ 15% |
| Flat ITT | TT specialists/GC ≥ 90%; no single rider > 70% of wins |
| Hilly ITT | GC/climbers favoured over pure TT specialists |

### Gaps
| Terrain | Target |
|---|---|
| Flat | 10th on winner's time (bunch) |
| Punchy finish | 10th within ~3–25 s |
| Hilly | 10th 0–3 min |
| Summit | 10th 1–6 min; 20th 3–13 min; grupetto 25–50 min |
| Cobbles | winner margin 0.5–3 min, often solo; 10th 1–4 min |
| Flat ITT | specialist vs GC 0.5–1.5 s/km; sprinters 8–15 s/km |

### Strategy impact (A/B, same field and seeds)
| Scenario | Required effect |
|---|---|
| Flat: sprint teams chase vs. nobody chases | Break success 1–8% → ≥ 50% |
| Sprinter with full lead-out vs. none | Sprinter win rate drops ≥ 40% (relative) |
| Cobbles leader: positioning + support vs. none | Mean time lost ≥ 60 s higher without; win rate halves |
| Attack at 80 km vs. on the final climb | Early attacker's win rate < 25% of the well-timed attack's |
| Sprinter named leader on a summit | 0 wins; team's best climber finishes worse than with the correct leader |

## 11. Testing

- **`test/realism.test.js`:** N seeds per terrain on the real peloton, asserting §10 bands (break rates, winner profiles, gaps, ITT spread).
- **`test/strategy.test.js`:** the A/B scenarios in §10.
- **Condition tests:** jour sans/super day frequencies within bands; a fatigued leader underperforms; a peaked leader overperforms.
- **Determinism:** same seed + plans gives an identical result.
- **Existing suites:** `engine.test.js` is rewritten against the new API; the smoke test is updated for the new race-weekend screens; all other suites must stay green.

## 12. Build order

1. **Engine core + calibration suite:** condition, strengths, classification, phases, finish, ITT, gaps; realism tests green.
2. **Strategy model + AI team plans:** strategy tests green; `compileTactic` / `recommendTactics` re-pointed.
3. **UI:** strategy screen, race report, removal of the live viewer; smoke tests green; browser verification.

## 13. Research sources (calibration)

- Breakaway rates & dynamics: Frontier Economics "Breaking down the breakaway"; CyclingTips (via zenocycleparts) "Will the breakaway survive", "How breakaways keep holding off the sprinters", Chapatte's law; Emerald (TPM-03-2017-0012); cyclinguphill.com; IDL Pro Cycling (2024–25 Tours).
- Gaps: bikeraceinfo.com TdF 2024 stages 7, 11, 14, 15; 2023 stage 16; Wikipedia TdF 2022–2024 GC.
- Physiology: BikeRadar (Pogačar VO2 study); Lanterne Rouge (Plateau de Beille 2024); IAT LIDA records 4059867, 4046591, 4043017; wattkg.com (Valenzuela 2022); welovecycling power-number analyses.
- Sprints: Menaspà (ECU ecuworks2012/498); The Conversation (sprint timing, lead-outs); INSCYD.
- Punchy finishes: watts2win (Mur de Huy); Wikipedia Flèche Wallonne 2023/2025.
- Cobbles: Wikipedia Paris–Roubaix 2022/2024/2025, Tour of Flanders 2025; Velo (Roubaix punctures); Lanterne Rouge (Flanders power); cyclistshub / Beyond the Peloton (winner build).
- Fatigue: um.es durability study; 8020endurance; Rouleur (sprinters' load).

Climbing W/kg values are mostly analyst estimates from climb times; breakaway rates are TdF-only. Bands are set accordingly wide.

## 14. Risks

- **Calibration coupling:** strategy, condition and terrain interact; tuning one band can move another. Mitigation: the realism and strategy suites run together and gate every change.
- **Downstream consumers:** AI season sims and classifications depend on engine output. The data contract is verified (§8: `results` order + `timeSec`); keep `simulate()` return fields and cover them in tests.
- **Performance:** the AI sims every race of every season. The phase model must stay faster than or equal to the current engine (≈250 ms for a 22-race block).
- **Removing the live viewer** removes a large UI chunk (`RaceView`, ~400 lines plus CSS). Mitigation: done last, after the new flow works.

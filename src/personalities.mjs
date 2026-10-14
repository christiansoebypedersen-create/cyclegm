// ============================================================================
//  PERSONALITIES — traits, morale, form, and manager interaction events.
//  Pure functions over rider/state objects. No external deps (helpers inlined
//  with unique names so this concatenates cleanly into the single-file build).
// ============================================================================
const cl = (x, a, b) => Math.max(a, Math.min(b, x));
const gz = (rng) => (rng() + rng() + rng() - 1.5) * 1.4; // ~N(0,1)

// traits: amb(ition) temp(erament/volatility) loyal(ty) prof(essionalism)
// state : morale, form  (both 1..99)
export function initPersonality(rng, r) {
  const n = (m, s) => cl(Math.round(m + gz(rng) * s), 1, 99);
  r.amb = n(50, 22); r.temp = n(48, 22); r.loyal = n(56, 20); r.prof = n(60, 18);
  r.morale = cl(Math.round(66 + gz(rng) * 8), 35, 92);
  r.form = cl(Math.round(60 + gz(rng) * 10), 35, 85);
  r.timesLed = 0;
  return r;
}

// small power swing applied to cp & W' when building a race (±~3.5%)
export function formMultiplier(r) {
  const f = (0.6 * (r.form ?? 60) + 0.4 * (r.morale ?? 65)) / 100;
  return 0.965 + 0.07 * f;
}

export const moodWord = (m) => m >= 80 ? "delighted" : m >= 65 ? "content" : m >= 50 ? "settled" : m >= 38 ? "unhappy" : "miserable";
export const moodColor = (m) => m >= 72 ? "#0a8f7a" : m >= 52 ? "#2b59c3" : m >= 38 ? "#e08a1e" : "#d6311f";

function resultDelta(place, n) {
  if (place === 1) return { form: 9, morale: 7 };
  if (place <= 3) return { form: 6, morale: 4 };
  if (place <= 10) return { form: 3, morale: 1.5 };
  if (place <= 30) return { form: 0.6, morale: 0 };
  if (place <= n * 0.6) return { form: -1, morale: -0.6 };
  return { form: -2.4, morale: -1.4 };
}

function mkEvent(state, r, kind, text, options) {
  return { id: state.nextEventId++, season: state.season, riderLid: r ? r.id : null, riderShort: r ? r.short : "Club", kind, text, options };
}
const evWin = (state, r) => mkEvent(state, r, "praise", `${r.short} took a brilliant win. A word from the boss?`, [
  { label: "Praise them publicly", fx: { morale: 6, loyal: 2 }, reply: `You praise ${r.short} to the press — they're buzzing.` },
  { label: "Keep them grounded", fx: { morale: 1, form: 2 }, reply: `You tell ${r.short} to stay hungry. They nod, focused.` },
  { label: "Say nothing", fx: {}, reply: `You let the result speak for itself.` },
]);
const evRole = (state, r) => mkEvent(state, r, "role", `${r.short} feels ready to lead a race, not just fetch bottles.`, [
  { label: "Promise a leadership role soon", fx: { morale: 10, loyal: 4, promise: "leadership" }, reply: `You promise ${r.short} a chance to lead. Don't forget it.` },
  { label: "Reassure their role matters", fx: { morale: 3 }, reply: `You explain how vital their work is. They half-accept.` },
  { label: "Tell them to earn it", fx: { morale: -4, form: 5 }, reply: `You challenge ${r.short} to prove it on the road.` },
  { label: "Dismiss it", fx: { morale: -9, loyal: -5 }, reply: `You brush ${r.short} off. That won't be forgotten.` },
]);
const evFrustrated = (state, r) => mkEvent(state, r, "morale", `${r.short} is frustrated after a rough race.`, [
  { label: "Put an arm around them", fx: { morale: 6 }, reply: `You back ${r.short}. Morale lifts.` },
  { label: "Demand a response", fx: { morale: -3, form: 5 }, reply: `You light a fire under ${r.short}.` },
  { label: "Leave it for now", fx: { morale: -4 }, reply: `You let ${r.short} stew.` },
]);
const evTransfer = (state, r, suitor) => mkEvent(state, r, "transfer", `${suitor} are sniffing around ${r.short}, who's tempted by a bigger stage.`, [
  { label: "Promise a bigger role & a raise", fx: { morale: 8, loyal: 6, promise: "raise" }, reply: `You promise ${r.short} more. They commit — for now.` },
  { label: "Refuse to discuss it", fx: { morale: -6, loyal: -6 }, reply: `You shut it down. ${r.short} isn't thrilled.` },
  { label: "Agree to listen to offers", fx: {}, mark: "transferListed", reply: `You agree to hear out offers for ${r.short}.` },
]);

// apply form/morale for everyone who raced; queue up to 2 events for the user
export function applyRaceOutcome(state, race, perStage, rng) {
  const best = {};
  perStage.forEach((st) => {
    const n = st.results.length, sc = race.kind === "tour" ? 0.5 : 1;
    st.results.forEach((res, i) => {
      const r = state.riders[res.lid]; if (!r) return;
      const d = resultDelta(i + 1, n);
      r.form = cl((r.form ?? 60) + d.form * sc, 1, 99);
      r.morale = cl((r.morale ?? 65) + d.morale * sc, 1, 99);
      if (best[res.lid] == null || i + 1 < best[res.lid]) best[res.lid] = i + 1;
    });
  });
  const ut = state.teams[state.userTeamId];
  let made = 0;
  for (const id of ut.riderIds) {
    if (made >= 2) break;
    const r = state.riders[id]; const p = best[id]; if (!r || p == null) continue;
    if (p === 1 && rng() < 0.85) { state.inbox.push(evWin(state, r)); made++; }
    else if (r.amb >= 68 && p > 10 && (r.form ?? 60) >= 58 && rng() < 0.32) { state.inbox.push(evRole(state, r)); made++; }
    else if (r.temp >= 56 && p > Math.max(25, ut.riderIds.length) && rng() < 0.22) { state.inbox.push(evFrustrated(state, r)); made++; }
  }
}

// resolve a manager interaction (called from UI)
export function resolveEvent(state, id, optIdx) {
  const i = state.inbox.findIndex((e) => e.id === id); if (i < 0) return;
  const e = state.inbox[i], opt = e.options[optIdx]; const r = state.riders[e.riderLid];
  const ut = state.teams[state.userTeamId];
  const money2 = (x) => Math.round(x * 100) / 100;
  if (opt) {
    const fx = opt.fx || {};
    if (fx.shortlist && e.riderLid != null) { state.shortlist = state.shortlist || []; if (!state.shortlist.includes(e.riderLid)) state.shortlist.push(e.riderLid); }
    if (r) {
      if (fx.morale) r.morale = cl((r.morale ?? 65) + fx.morale, 1, 99);
      if (fx.form) r.form = cl((r.form ?? 60) + fx.form, 1, 99);
      if (fx.loyal) r.loyal = cl((r.loyal ?? 55) + fx.loyal, 1, 99);
      if (fx.promise) { if (fx.promise === "raise") r._salaryAtPromise = r.salary; state.promises.push({ type: fx.promise, riderLid: r.id, season: state.season, short: r.short }); }
      if (opt.mark === "transferListed" || fx.list) r.transferListed = true;
      if (fx.injure) { r.out = (r.out || 0) + (fx.injure.races || 0); if (fx.injure.form) r.form = cl((r.form ?? 60) + fx.injure.form, 1, 99);
        state.news.push({ season: state.season, date: 0, kind: "injury", text: `${r.short} is out for ${fx.injure.races} race${fx.injure.races === 1 ? "" : "s"}.` }); }
      if (fx.suspend) { r.out = (r.out || 0) + fx.suspend; r.suspended = true; }
      // --- development effects: rider self-belief + accumulators the off-season growth tick consumes ---
      if (fx.conf) r.confidence = cl((r.confidence ?? 60) + fx.conf, 0, 100);
      if (fx.leapPrime) r._leapPrimed = state.season;   // a telegraphed breakout the manager backed → lifts leap odds this off-season
      if (fx.devPool) r._devPool = (r._devPool || 0) + fx.devPool;   // banked extra growth credit (good calls / racing)
      if (fx.devDrag) r._devDrag = (r._devDrag || 0) + fx.devDrag;   // banked setback that bites into growth
    }
    if (fx.budget && ut) ut.budget = money2((ut.budget || 0) + fx.budget);
    if (fx.confidence != null) state.boardConfidence = cl((state.boardConfidence ?? 62) + fx.confidence, 0, 100);
    if (fx.prestige && ut) ut.prestige = cl((ut.prestige || 50) + fx.prestige, 10, 99);
    if (fx.then) { state.pending = state.pending || []; state.pending.push({ ...fx.then, riderLid: e.riderLid, suspRaces: fx.suspend || 0 }); }
    if (opt.reply) state.news.push({ season: state.season, date: 0, kind: e.kind || "morale", text: opt.reply });
  }
  state.inbox.splice(i, 1);
}

// season transition: judge promises, decay morale, raise transfer interest.
// `suitorName(rider)` returns a tempting rival team name (passed by gm).
export function seasonPersonalityTick(state, rng, suitorName) {
  // promises
  for (const pr of state.promises) {
    const r = state.riders[pr.riderLid]; if (!r) continue;
    if (pr.type === "leadership") {
      if ((r.timesLed || 0) > 0) { r.morale = cl(r.morale + 8, 1, 99); r.loyal = cl(r.loyal + 5, 1, 99); }
      else { r.morale = cl(r.morale - 16, 1, 99); r.loyal = cl(r.loyal - 12, 1, 99);
        state.news.push({ season: state.season, date: 99, kind: "morale", text: `${r.short} is bitter — a promised leadership chance never came.` }); }
    } else if (pr.type === "raise") {
      // fulfilled only if the salary actually rose since the promise
      const kept = r._salaryAtPromise == null || r.salary > r._salaryAtPromise;
      if (kept) r.morale = cl(r.morale + 3, 1, 99);
      else { r.morale = cl(r.morale - 8, 1, 99); r.loyal = cl(r.loyal - 6, 1, 99);
        state.news.push({ season: state.season, date: 99, kind: "morale", text: `${r.short} is unhappy — the promised raise never came.` }); }
      delete r._salaryAtPromise;
    }
  }
  state.promises = [];
  // morale decay toward 60, reset season counters
  for (const id in state.riders) {
    const r = state.riders[id];
    r.morale = cl(Math.round((r.morale ?? 65) + (60 - (r.morale ?? 65)) * 0.34), 1, 99);
    r.form = cl(Math.round((r.form ?? 60) + (60 - (r.form ?? 60)) * 0.5), 1, 99);
    r.timesLed = 0; r.transferListed = false;
  }
  // off-season transfer interest for the user's best/ambitious/unsettled riders
  const ut = state.teams[state.userTeamId];
  const cands = ut.riderIds.map((id) => state.riders[id]).filter(Boolean)
    .filter((r) => (r.overall >= 74 || r.amb >= 72) && rng() < 0.5)
    .sort((a, b) => b.overall - a.overall).slice(0, 2);
  for (const r of cands) state.inbox.push(evTransfer(state, r, suitorName(r)));
}

// morale-aware contract demand when re-signing your own rider
// ============================================================================
//  RANDOM EVENTS — sparse, full-spectrum, with real consequences. Fired once
//  per user race from weeklyTick(); delayed outcomes resolve later.
// ============================================================================
function note(state, r, kind, text) { return { id: state.nextEventId++, season: state.season, riderLid: r ? r.id : null, riderShort: r ? r.short : "Club", kind, text, options: [{ label: "Acknowledge", fx: {} }] }; }
function richRival(state, rng) { const rivals = state.teams.filter((t) => t.id !== state.userTeamId).sort((a, b) => b.prestige - a.prestige).slice(0, 8); return rivals.length ? rivals[Math.floor(rng() * rivals.length)].name : "a rival outfit"; }

// — injuries & illness —
const evCrash = (state, r) => mkEvent(state, r, "injury", `${r.short} has gone down hard in training and damaged a wrist. The doctor wants a scan.`, [
  { label: "Rush them back for the big races", fx: { injure: { races: 2, form: -8 }, then: { type: "reinjure", dueRaces: 3 } }, reply: `${r.short} will be back inside a fortnight — against medical advice.` },
  { label: "Let the physios manage it", fx: { injure: { races: 4, form: -4 } }, reply: `${r.short} starts a careful rehab. Out about a month.` },
  { label: "Full rest, no risks", fx: { injure: { races: 6, form: 4 }, morale: 3 }, reply: `${r.short} takes a proper break and will return fresh.` },
]);
const evIllness = (state, r) => mkEvent(state, r, "injury", `${r.short} has come down with a chest infection days before a key race.`, [
  { label: "Pull them out to recover", fx: { injure: { races: 1, form: 2 } }, reply: `${r.short} sits it out and avoids making it worse.` },
  { label: "Let them start and see", fx: { form: -10, morale: -2 }, reply: `${r.short} starts but is clearly below par.` },
]);
// — scandal / doping (full spectrum) —
const evDoping = (state, r) => mkEvent(state, r, "scandal", `An out-of-competition sample from ${r.short} has returned an atypical value. The UCI has opened a review. The press are already calling.`, [
  { label: "Suspend them pending the result", fx: { suspend: 3, confidence: 2, prestige: 1, then: { type: "doping", dueRaces: 3, clearedProb: 0.62 } }, reply: `You provisionally suspend ${r.short}. The board approves of the caution.` },
  { label: "Stand by them publicly", fx: { morale: 10, loyal: 8, prestige: -1, then: { type: "doping", dueRaces: 3, clearedProb: 0.62, stoodBy: true } }, reply: `You back ${r.short} to the hilt. If it backfires, it's on you.` },
  { label: "Say nothing, await the B-sample", fx: { then: { type: "doping", dueRaces: 3, clearedProb: 0.62 } }, reply: `You keep your counsel and wait for the science.` },
]);
const evSocial = (state, r) => mkEvent(state, r, "scandal", `${r.short} has posted something stupid online and it's blown up. A sponsor has been in touch.`, [
  { label: "Fine them and apologise", fx: { morale: -6, budget: 0.4, prestige: 1 }, reply: `You fine ${r.short} and issue a statement. The sponsor is mollified.` },
  { label: "Defend them, free speech", fx: { morale: 6, loyal: 5, prestige: -2, confidence: -3 }, reply: `You back ${r.short}. The sponsor is not impressed.` },
  { label: "Quiet media training", fx: { morale: 1, budget: -0.2 }, reply: `You handle it discreetly. It blows over.` },
]);
// — money / sponsors —
const evSponsor = (state, r) => mkEvent(state, null, "sponsor", `Your title sponsor wants more visibility — bluntly, more wins — or they'll review the budget at season's end.`, [
  { label: "Promise results", fx: { confidence: -2, then: { type: "sponsorReview", dueRaces: 6, bar: 60, amount: 3 } }, reply: `You promise a strong run-in. They'll be watching.` },
  { label: "Negotiate a smaller deal now", fx: { budget: -1.5 }, reply: `You lock in a reduced but certain budget.` },
  { label: "Call their bluff", fx: { confidence: 1, then: { type: "sponsorReview", dueRaces: 6, bar: 52, amount: 4 } }, reply: `You hold firm. High risk, high reward.` },
]);
const evCrit = (state, r) => mkEvent(state, r, "money", `A lucrative exhibition criterium wants ${r.short} as the headline act — good money, but it's mid-season.`, [
  { label: "Send them — take the cash", fx: { budget: 1.2, form: -6, morale: 3 }, reply: `${r.short} cashes in but arrives back a touch flat.` },
  { label: "Decline — focus on racing", fx: { morale: -2 }, reply: `You keep ${r.short} on programme.` },
]);
const evFine = (state, r) => mkEvent(state, null, "money", `The UCI has fined the team for a feed-zone infringement during the last race.`, [
  { label: "Pay it and move on", fx: { budget: -0.5 }, reply: `You pay the fine quietly.` },
  { label: "Appeal it", fx: { then: { type: "appeal", dueRaces: 2 } }, reply: `You lodge an appeal.` },
]);
// — board / job security —
const evBoard = (state, r) => mkEvent(state, null, "board", `The board has called you in. They're unhappy with recent results and want reassurance.`, [
  { label: "Promise a turnaround", fx: { confidence: 4, then: { type: "sponsorReview", dueRaces: 5, bar: 64, amount: 2 } }, reply: `You stake your reputation on a turnaround.` },
  { label: "Point to the long-term plan", fx: { confidence: 1 }, reply: `You make the case for patience.` },
  { label: "Push back hard", fx: { confidence: -5, prestige: 1 }, reply: `You tell them to back you or sack you.` },
]);
const evJobOffer = (state, r, rival) => mkEvent(state, null, "board", `${rival} have made an informal approach about you taking over their team.`, [
  { label: "Use it as leverage with the board", fx: { confidence: 6, budget: 1 }, reply: `You parlay the interest into backing and a little more budget.` },
  { label: "Politely decline — you're committed", fx: { confidence: 2, prestige: 1 }, reply: `You commit publicly to the project.` },
]);
// — contracts / transfers —
const evContract = (state, r) => mkEvent(state, r, "contract", `${r.short} feels underpaid and wants a new deal — soon.`, [
  { label: "Give them the raise", fx: { budget: -1, morale: 10, loyal: 8 }, reply: `You reward ${r.short}. They're committed.` },
  { label: "Promise to revisit it", fx: { morale: 3, promise: "raise" }, reply: `You promise to sort it. Don't forget.` },
  { label: "Refuse — they're paid plenty", fx: { morale: -10, loyal: -8, list: true }, reply: `${r.short} is unhappy and starts eyeing the exit.` },
]);
const evBid = (state, r, rival) => mkEvent(state, r, "transfer", `${rival} have tabled a concrete, big-money bid for ${r.short}.`, [
  { label: "Reject it outright", fx: { morale: 4, confidence: -2 }, reply: `You slam the door. ${r.short} stays — for now.` },
  { label: "Listen to offers", fx: { list: true }, reply: `You open the door to a sale of ${r.short}.` },
  { label: "Reassure & build around them", fx: { morale: 8, loyal: 6, promise: "leadership" }, reply: `You promise ${r.short} the team will be built around them.` },
]);
// — human / morale —
const evHomesick = (state, r) => mkEvent(state, r, "morale", `${r.short}, far from home, is struggling to settle into life as a pro.`, [
  { label: "Arrange a trip home", fx: { morale: 8, loyal: 5, budget: -0.2 }, reply: `${r.short} comes back refreshed.` },
  { label: "Pair them with a mentor", fx: { morale: 5, form: 2 }, reply: `A senior rider takes ${r.short} under their wing.` },
  { label: "Tell them to toughen up", fx: { morale: -5, form: 3 }, reply: `You're blunt. ${r.short} knuckles down — resentfully.` },
]);
const evClash = (state, r) => mkEvent(state, r, "morale", `Two of your leaders are at each other's throats over who gets backing for the big races.`, [
  { label: "Back the in-form one", fx: { morale: 4 }, reply: `You name a clear leader. One's happy, one isn't.` },
  { label: "Split the programme", fx: { morale: 2, form: 1 }, reply: `You give them separate goals. Peace holds.` },
  { label: "Bang heads together", fx: { morale: -3, form: 4 }, reply: `You demand professionalism. The tension lingers but they ride.` },
]);

// the roller — sparse; one contextual event at most per user race
export function rollSeasonEvent(state, rng, race) {
  if (rng() > 0.16) return;                                   // a few a season; each matters
  const ut = state.teams[state.userTeamId];
  const roster = (ut.riderIds || []).map((id) => state.riders[id]).filter((r) => r && !(r.out > 0));
  if (roster.length < 2) return;
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const star = roster.filter((r) => r.overall >= 72).sort((a, b) => b.overall - a.overall)[0];
  const young = roster.filter((r) => r.age <= 21), vets = roster.filter((r) => r.age >= 32);
  const rival = richRival(state, rng);
  const pool = [
    { w: 3.0, ev: () => evCrash(state, pick(roster)) },
    { w: 2.0, ev: () => evIllness(state, pick(roster)) },
    { w: 1.0, ev: () => evDoping(state, pick(roster)) },
    { w: 1.4, ev: () => evSocial(state, pick(roster)) },
    { w: 1.6, ev: () => evSponsor(state, null) },
    { w: 1.4, ev: () => evCrit(state, star || pick(roster)) },
    { w: 1.0, ev: () => evFine(state, null) },
    { w: 1.3, ev: () => evBoard(state, null) },
    { w: 0.8, ev: () => evJobOffer(state, null, rival) },
    { w: 1.6, ev: () => evContract(state, star || pick(roster)) },
    { w: 1.0, ev: () => evClash(state, pick(roster.slice().sort((a, b) => b.overall - a.overall).slice(0, 6))) },
  ];
  if (star) pool.push({ w: 1.8, ev: () => evBid(state, star, rival) });
  if (young.length) pool.push({ w: 1.6, ev: () => evHomesick(state, pick(young)) });
  const tot = pool.reduce((s, p) => s + p.w, 0); let x = rng() * tot;
  for (const p of pool) { x -= p.w; if (x <= 0) { const e = p.ev(); if (e) state.inbox.push(e); return; } }
}

// resolve delayed outcomes (called per user race)
function resolvePending(state, rng, race) {
  if (!state.pending || !state.pending.length) return;
  const ut = state.teams[state.userTeamId]; const money2 = (x) => Math.round(x * 100) / 100; const keep = [];
  for (const p of state.pending) {
    if (--p.dueRaces > 0) { keep.push(p); continue; }
    const r = p.riderLid != null ? state.riders[p.riderLid] : null;
    if (p.type === "doping") {
      if (rng() < (p.clearedProb ?? 0.6)) {
        if (r) { r.morale = cl((r.morale ?? 65) + 12, 1, 99); r.loyal = cl((r.loyal ?? 55) + 10, 1, 99); r.suspended = false; if (r.out > 0 && !p.stoodBy) r.out = Math.max(0, r.out - (p.suspRaces ?? r.out)); }
        if (ut) ut.prestige = cl((ut.prestige || 50) + 2, 10, 99); state.boardConfidence = cl((state.boardConfidence ?? 62) + 5, 0, 100);
        state.inbox.push(note(state, r, "scandal", `CLEARED — ${r ? r.short : "the rider"}'s sample was a false alarm. ${p.stoodBy ? "Standing by them looks like fine judgement." : "Vindication all round."}`));
      } else {
        if (r) { r.out = (r.out || 0) + (8 + Math.floor(rng() * 10)); r.suspended = true; r.morale = cl((r.morale ?? 65) - 25, 1, 99); }
        if (ut) { ut.prestige = cl((ut.prestige || 50) - 6, 10, 99); ut.budget = money2((ut.budget || 0) - 2); }
        state.boardConfidence = cl((state.boardConfidence ?? 62) - (p.stoodBy ? 16 : 10), 0, 100);
        state.inbox.push(note(state, r, "scandal", `BANNED — ${r ? r.short : "the rider"} tested positive and is suspended. Sponsors are furious${p.stoodBy ? ", and backing them publicly has cost you dearly with the board" : ""}.`));
      }
    } else if (p.type === "reinjure") {
      if (r && rng() < 0.34) { r.out = (r.out || 0) + 2; r.morale = cl((r.morale ?? 65) - 6, 1, 99); state.inbox.push(note(state, r, "injury", `${r.short} aggravated the injury coming back too soon — out longer.`)); }
      else if (r) state.news.push({ season: state.season, date: race.week, kind: "injury", text: `${r.short} came through the comeback fine.` });
    } else if (p.type === "sponsorReview") {
      const good = (state.boardConfidence ?? 62) >= (p.bar ?? 58);
      if (ut) ut.budget = money2((ut.budget || 0) + (good ? (p.amount ?? 3) : -(p.amount ?? 3)));
      state.boardConfidence = cl((state.boardConfidence ?? 62) + (good ? 3 : -6), 0, 100);
      state.inbox.push(note(state, null, "sponsor", good
        ? `Your title sponsor is delighted with the campaign and adds €${p.amount ?? 3}m to the budget.`
        : `Your title sponsor is unhappy with the season and trims the budget by €${p.amount ?? 3}m.`));
    } else if (p.type === "appeal") {
      if (rng() < 0.5) state.news.push({ season: state.season, date: race.week, kind: "money", text: `The team's fine was overturned on appeal.` });
      else if (ut) { ut.budget = money2((ut.budget || 0) - 0.6); state.news.push({ season: state.season, date: race.week, kind: "money", text: `The appeal failed — the fine stands, with costs.` }); }
    } else if (p.type === "devPush") {                        // the fast-track breakout pays off, or burns them out
      if (!r) { /* rider gone */ }
      else if (rng() < 0.62) { r.confidence = cl((r.confidence ?? 60) + 8, 0, 100); r._devPool = (r._devPool || 0) + 3; r._leapPrimed = state.season;
        state.inbox.push(note(state, r, "breakthrough", `It's working — ${r.short} has thrived on the extra racing and looks a level up. This could be the season.`)); }
      else { r.form = cl((r.form ?? 60) - 8, 1, 99); r.confidence = cl((r.confidence ?? 60) - 7, 0, 100); r._devDrag = (r._devDrag || 0) + 2; r.out = (r.out || 0) + (rng() < 0.4 ? 2 : 0); r._leapPrimed = 0;
        state.inbox.push(note(state, r, "morale", `The load was too much too soon — ${r.short} is cooked and flat. The breakout will have to wait.`)); }
    } else if (p.type === "devGamble") {                      // backed a rattled rider for a result — snap out, or spiral
      if (!r) { /* rider gone */ }
      else if (rng() < 0.5) { r.confidence = cl((r.confidence ?? 60) + 14, 0, 100); r.form = cl((r.form ?? 60) + 6, 1, 99); r._devPool = (r._devPool || 0) + 2;
        state.inbox.push(note(state, r, "breakthrough", `${r.short} delivered when it mattered — the confidence is flooding back.`)); }
      else { r.confidence = cl((r.confidence ?? 60) - 10, 0, 100); r.morale = cl((r.morale ?? 65) - 5, 1, 99); r._devDrag = (r._devDrag || 0) + 1.5;
        state.inbox.push(note(state, r, "morale", `The gamble didn't come off — ${r.short} is deeper in the hole now.`)); }
    }
  }
  state.pending = keep;
}

// called once per user race from gm: recover injuries, resolve pending, maybe fire an event
// ============================================================================
//  MID-SEASON DEVELOPMENT — story beats that make young riders feel alive.
//  Choice events land in the inbox; ambient beats go to the news feed. Both
//  swing CONFIDENCE (fast self-belief) and bank _devPool / _devDrag / _leapPrimed
//  that the off-season growth tick (developAll) actually cashes in. So the
//  manager's in-season calls shape the annual jump without a second growth model.
// ============================================================================
const devBeat = (state, r, kind, text) => state.news.push({ season: state.season, date: 0, kind, riderLid: r ? r.id : null, text });
// CHOICE: a breakout is brewing — push it (faster, riskier) or protect the arc (safer, steadier)
const evDevBreakthrough = (state, r) => mkEvent(state, r, "breakthrough",
  `The coaches are buzzing about ${r.short}. The training numbers have jumped and there's talk of a real step up this season.`, [
  { label: "Fast-track them — more racing, real responsibility", fx: { leapPrime: 1, conf: 7, form: -3, then: { type: "devPush", dueRaces: 3, riderLid: r.id } }, reply: `You throw ${r.short} in at the deep end. If the legs are there, everyone will see it.` },
  { label: "Protect the progression — bring them through slowly", fx: { conf: 3, devPool: 2.5 }, reply: `You shield ${r.short} from the spotlight and let it build. No shortcuts.` },
], ["A push could ignite a breakout — or burn them out.", "Patience is safer, but the leap may come a year later."]);
// CHOICE: confidence has cratered after a rough run
const evDevCrisis = (state, r) => mkEvent(state, r, "morale",
  `${r.short} has lost the thread after a rough run of results. The head has dropped and it's showing on the bike.`, [
  { label: "Sit them down, rebuild the confidence", fx: { conf: 9, form: 3, out: 0 }, reply: `You take the pressure off ${r.short}. Small races, small goals, rebuild.` },
  { label: "Back them for a big result — sink or swim", fx: { then: { type: "devGamble", dueRaces: 2, riderLid: r.id } }, reply: `You tell ${r.short} you believe in them and hand them a target. Now they have to deliver.` },
], ["Rebuilding is reliable but slow.", "The gamble could snap them out of it — or deepen the spiral."]);
// CHOICE: a training knock — rush back or manage it (dev-flavoured injury)
const evDevKnock = (state, r) => mkEvent(state, r, "injury",
  `${r.short} has picked up a niggle in training. Nothing structural, but the medical team want it watched.`, [
  { label: "Push through — the kid wants to race", fx: { injure: { races: 1, form: -4 }, devDrag: 1.5, then: { type: "reinjure", dueRaces: 3 } }, reply: `${r.short} races on. Fingers crossed.` },
  { label: "Rest it properly", fx: { injure: { races: 3, form: 2 }, conf: 2 }, reply: `${r.short} sits out a few weeks and comes back sound.` },
]);
function tickDevEvents(state, rng, race) {
  const ut = state.teams[state.userTeamId]; if (!ut) return;
  const ids = (ut.riderIds || []).concat(ut.devIds || []);
  const pool = ids.map((id) => state.riders[id]).filter((r) => r && r.age <= 25 && !(r.out > 0));
  if (!pool.length) return;
  for (const r of pool) {                                       // confidence gently chases form — results shape self-belief
    if (r._devEvtCd > 0) r._devEvtCd--;
    r.confidence = cl(Math.round((r.confidence ?? 60) + Math.max(-4, Math.min(4, ((r.form ?? 60) - (r.confidence ?? 60)) * 0.12))), 0, 100);
  }
  if (rng() > 0.32) return;                                     // a dev beat every few races, not every race
  const ready = pool.filter((r) => !(r._devEvtCd > 0));
  if (!ready.length) return;
  const cands = [];
  for (const r of ready) {
    const room = (r.ceiling ?? r.potential ?? r.overall) - r.overall, gr = r.growthRate ?? 1, form = r.form ?? 60;
    if (room >= 7 && gr >= 0.92 && form >= 60 && r.age <= 23) cands.push({ w: 2.4, r, kind: "choice", ev: () => evDevBreakthrough(state, r) });
    if (form < 52) cands.push({ w: 2.0, r, kind: "choice", ev: () => evDevCrisis(state, r) });
    if (room >= 6 && form >= 66 && r.age <= 24) cands.push({ w: 1.6, r, kind: "beat", ev: () => { r.confidence = cl((r.confidence ?? 60) + 5, 0, 100); r._devPool = (r._devPool || 0) + 2; devBeat(state, r, "breakthrough", `${r.short} has taken a visible step up in training — the staff are excited.`); } });
    if ((r._bust || room <= 2) && r.age >= 21) cands.push({ w: 1.1, r, kind: "beat", ev: () => { r.confidence = cl((r.confidence ?? 60) - 4, 0, 100); r._devDrag = (r._devDrag || 0) + 1.5; devBeat(state, r, "morale", `${r.short}'s progress has stalled — the numbers just aren't moving.`); } });
    cands.push({ w: 0.7, r, kind: "choice", ev: () => evDevKnock(state, r) });
  }
  if (!cands.length) return;
  const tot = cands.reduce((s, c) => s + c.w, 0); let x = rng() * tot;
  for (const c of cands) { x -= c.w; if (x <= 0) { const e = c.ev(); if (c.kind === "choice" && e) state.inbox.push(e);
    c.r._devEvtCd = 3 + Math.floor(rng() * 3);   // cool this rider down so beats don't spam one kid
    return; } }
}
export function weeklyTick(state, rng, race) {
  resolvePending(state, rng, race);            // verdicts land BEFORE the heal tick (no "available again" followed by "BANNED")
  const ut = state.teams[state.userTeamId];
  const mine = new Set((ut.riderIds || []).concat(ut.devIds || []));
  for (const id in state.riders) {             // heal EVERY rider — a rider sold while injured used to stay out forever
    const r = state.riders[id]; if (!r || !(r.out > 0)) continue;
    const wasSusp = r.suspended;
    if (--r.out <= 0) { r.out = 0; r.suspended = false;
      if (mine.has(r.id)) state.news.push({ season: state.season, date: race.week, kind: "injury", riderLid: r.id, text: `${r.short} is available again after ${wasSusp ? "suspension" : "injury"}.` }); }
  }
  tickDevEvents(state, rng, race);
  rollSeasonEvent(state, rng, race);
}

export function reSignOffer(rider) {
  const v = rider.value || rider.salary || 0.4;
  const unhappy = (rider.morale ?? 65) < 48, greedy = rider.amb >= 65;
  let mult = 1 + (greedy ? 0.12 : 0) + (unhappy ? 0.16 : 0) - (rider.loyal >= 70 ? 0.06 : 0);
  const ask = Math.round(v * mult * 0.55 * 100) / 100;   // annual salary ≈ 55% of market value
  const willing = !(unhappy && greedy && (rider.morale ?? 65) < 38);
  const years = rider.age >= 32 ? 1 : rider.age <= 24 ? 4 : 3;
  return { willing, salary: ask, years,
    note: !willing ? "Wants to test the market" : unhappy ? "Unsettled — asking for more" : greedy ? "Ambitious — pushing the deal up" : rider.loyal >= 70 ? "Loyal — happy to stay" : "Open to staying" };
}

// dev/retirement modifiers from morale (called by gm)
export const devMoraleFactor = (r) => 0.85 + 0.0033 * (r.morale ?? 65);
export const retireMoraleFactor = (r) => 1 + (60 - (r.morale ?? 65)) / 140;

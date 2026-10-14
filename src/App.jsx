import React from "react";
import { fmtGap, fmtTime, derivePhysicals, syncShadows, ABIL_KEYS } from "./engine.mjs";
import { newLeague, resolveRace, endSeason, fastSimSeason, seasonChampions, riderStandings, teamStandings, tierStandings, TIERS,
  freeAgents, signTo, releaseFrom, valueOf, overallOf, dominantType, fitFor,
  buildEntries, commitRaceResult, runStage, compileTactic,
  devSquad, prospectPool, promoteToPro, demoteToDev, signToDev, releaseDev, setProgram, potentialBand,
  powerProfile, toggleAltitude, altitudeRoster, altitudeSlots, altitudeCost, TRAINING_FOCI,
  teamFinances, sponsorMarket, signSponsor, renegotiateSponsor, buyoutSponsor, labelAsk, openSponsorSlots, setSponsorDB,
  recruitProspect, runYouthSeason, osReview, seasonStory, osYouthRaces, osYouthClose, osDevelop, osTransfers, osFinish,
  osIntake, signIntake, closeIntake, investYouth, youthUpgradeCost,
  academyTier, userCoaches, coachMarket, hireCoach, fireCoach, COACH_CAP, youthRaces, toggleYouthRace, migrateState,
  DEV_PATHS, setDevPath, pathFitOf, promotionReadiness, EXPECTATION_TYPES, setExpectation, clearExpectation,
  periodizedForm, setRiderTarget, planSeason, autoPlanUser, PEAK_THEMES, knownPower, estAbil,
  fatigueLabel, gtCapFor, riderRaceBlock,
  setSeasonObjective, objectiveProgress, evaluateObjective, breakoutWatch, scoutRegions, regionOfNation, knowLabel,
  userScouts, scoutMarket, hireScout, fireScout, assignScout, shortlist, toggleShortlist, scoutReports,
  regionOpportunities, autoAssignScouts, bestIdleScout, sendBestIdleScout,
  knownOverall, knownPotential, starOf, SCOUT_REGIONS, disciplines,
  askingPrice, evaluateBid, completeTransfer, contractDemand, offerAcceptance,
  solicitOffers, acceptSale, setTransferListed, STATUS_LABEL, applyRiderTeamDatabase, raceProfile, raceFavorites, teamOutlook, recommendTactics, recommendStagePlan, tacticWarnings, skipToRace, skipWarnings } from "./gm.mjs";
import { resolveEvent, reSignOffer, moodColor, moodWord } from "./personalities.mjs";
// Animated nav icons vendored from lucide-animated.com (Motion-powered, MIT).
import { HomeIcon } from "./icons/home";
import { ArchiveIcon } from "./icons/archive";
import { UsersIcon } from "./icons/users";
import { ClipboardCheckIcon } from "./icons/clipboard-check";
import { TrendingUpIcon } from "./icons/trending-up";
import { SearchIcon } from "./icons/search";
import { DollarSignIcon } from "./icons/dollar-sign";
import { GitCompareArrowsIcon } from "./icons/git-compare-arrows";
import { CalendarDaysIcon } from "./icons/calendar-days";
import { LayersIcon } from "./icons/layers";
import { FileTextIcon } from "./icons/file-text";

// ============================================================================
//  CYCLE GM — management UI on top of the race + GM engines above.
//  Patterns reimplemented from Basketball GM (Play menu, ovr/pot, free agency,
//  standings/history, multi-league IndexedDB saves + export/import, God Mode).
//  Faces via facesjs (Apache-2.0) when available, initials fallback otherwise.
// ============================================================================

// ---------- persistence: IndexedDB with in-memory fallback ------------------
const DBN = "cyclegm", STORE = "leagues";
const _mem = new Map();
let _dbPromise = null;   // one connection for the whole session — a fresh open per operation leaked connections
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((res) => {
    try {
      const rq = indexedDB.open(DBN, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE, { keyPath: "id" });
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => { _dbPromise = null; res(null); };
    } catch (e) { _dbPromise = null; res(null); }
  });
  return _dbPromise;
}
async function dbPut(rec) {
  _mem.set(rec.id, rec);                      // memory mirror first — survives quota errors and aborted transactions
  const db = await openDB(); if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.onabort = tx.onerror = () => console.warn("save failed (kept in memory):", tx.error?.message);
    tx.objectStore(STORE).put(rec);
  } catch (e) { /* memory copy already taken */ }
}
async function dbList() {
  const db = await openDB(); if (!db) return [..._mem.values()];
  return new Promise((res) => {
    const out = []; const tx = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
    tx.onsuccess = (e) => { const c = e.target.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
    tx.onerror = () => res([..._mem.values()]);
  });
}
async function dbGet(id) {
  const db = await openDB(); if (!db) return _mem.get(id);
  return new Promise((res) => { const g = db.transaction(STORE, "readonly").objectStore(STORE).get(id); g.onsuccess = () => res(g.result); g.onerror = () => res(_mem.get(id)); });
}
async function dbDel(id) {
  const db = await openDB(); if (!db) { _mem.delete(id); return; }
  try { db.transaction(STORE, "readwrite").objectStore(STORE).delete(id); } catch (e) { _mem.delete(id); }
}

// ---------- facesjs (optional) ----------------------------------------------
let _faces = null, _facesTried = false;
const _faceCache = new Map();
async function getFaces() { if (_facesTried) return _faces; _facesTried = true; try { _faces = await import("facesjs"); } catch (e) { _faces = null; } return _faces; }

const ARCHG = {
  gc: { tag: "GC", col: "#2b59c3" }, climber: { tag: "CLIMB", col: "var(--green)" },
  sprinter: { tag: "SPRINT", col: "#d6311f" }, leadout: { tag: "LEAD", col: "#e08a1e" },
  puncheur: { tag: "PUNCH", col: "#7a3fb0" }, rouleur: { tag: "ROUL", col: "#3f7d3f" },
  helper: { tag: "DOM", col: "#6b6760" },
};
const money = (m) => (m >= 0 ? "€" : "−€") + Math.abs(m).toFixed(1) + "M";
const ovrCol = (o) => o >= 85 ? "var(--green)" : o >= 75 ? "#2b59c3" : o >= 65 ? "#e8ebf0" : o >= 55 ? "#8a93a0" : "#6a7280";

const GCSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Mono:wght@400;600;700&family=Inter:wght@400;600;700;800&display=swap');
.gm{--bg:#0a0b0d;--card:#0d1117;--card2:#151b23;--ink:#f0f2f5;--mut:#7a8396;--line:#252b3a;--blue:#1e6fff;--rouge:#1e6fff;--gold:#ffd700;--green:#00e676;--red:#ff3b3b;--amber:#ff9800;--purple:#9b59ff;--cyan:#00e5ff;--hot:#ff7043;--star:#ffd700;--starDim:#cdb16a;--starOff:#1f242d;--know0:#5b6470;--grid:#1b212b;--pos:#00e676;--paper:#0a0b0d;--fTitle:'Barlow Condensed','Inter',system-ui,sans-serif;--fMono:'IBM Plex Mono',ui-monospace,monospace;
  min-height:100vh;background:var(--bg);color:var(--ink);font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;}
.gm *{box-sizing:border-box;}
.mono{font-family:var(--fMono);font-variant-numeric:tabular-nums;letter-spacing:-0.02em;}
.shell{display:flex;min-height:100vh;}
.side{width:214px;flex:none;background:var(--card);border-right:1px solid var(--line);position:sticky;top:0;height:100vh;overflow-y:auto;display:flex;flex-direction:column;z-index:25;}
.side .logo{font-family:var(--fTitle);font-weight:700;font-size:20px;letter-spacing:0;text-transform:uppercase;padding:16px 16px 12px;display:flex;align-items:center;gap:9px;}.side .logo span{color:var(--rouge);}.logomark{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--blue),var(--cyan));flex:none;}
.navv{display:flex;flex-direction:column;padding:6px 8px;gap:1px;}
.navv button{display:flex;align-items:center;gap:11px;border:0;background:transparent;padding:9px 11px;font-size:13px;font-weight:600;color:var(--mut);cursor:pointer;border-radius:8px;text-align:left;width:100%;position:relative;}
.navv button .ico{width:17px;text-align:center;opacity:.85;font-size:13px;flex:none;}
.navv button:hover{background:var(--card);color:var(--ink);}
.navv button.on{background:var(--blue);color:#fff;}
.navv button.on .ico{opacity:1;}
.navv button.on:after{content:"";position:absolute;right:10px;top:50%;transform:translateY(-50%);width:6px;height:6px;border-radius:3px;background:var(--cyan);}
.navv .badge{margin-left:auto;background:var(--red);color:#fff;font-size:10px;font-weight:800;border-radius:20px;padding:1px 7px;}
.aicon{display:inline-flex;line-height:0;color:inherit;}
.main{flex:1;min-width:0;display:flex;flex-direction:column;}
.gm-wrap{max-width:1180px;margin:0 auto;width:100%;padding:0 18px 64px;}
.topbar{display:flex;align-items:center;gap:13px;padding:11px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(14,17,22,.85);backdrop-filter:blur(9px);z-index:20;flex-wrap:wrap;}
.topbar .tdot{width:11px;height:11px;border-radius:3px;flex:none;}
.topbar .tt{font-family:var(--fTitle);font-weight:700;font-size:17px;letter-spacing:0;text-transform:uppercase;}
.topbar .tmeta{font-size:11.5px;color:var(--mut);}
.tierpill{font-size:9.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:2px 8px;border-radius:999px;color:#fff;}
.spacer{flex:1;}
.play{position:relative;}
.playbtn{background:var(--rouge);color:#fff;border:0;border-radius:8px;padding:9px 18px;font-weight:700;font-size:13px;cursor:pointer;box-shadow:0 3px 12px rgba(30,111,255,.32);}
.playmenu{position:absolute;right:0;top:46px;background:var(--card);border:1px solid var(--line);border-radius:11px;box-shadow:0 14px 44px rgba(0,0,0,.55);min-width:226px;overflow:hidden;z-index:30;}
.playmenu button{display:block;width:100%;text-align:left;border:0;background:transparent;padding:11px 14px;font-size:13px;cursor:pointer;border-bottom:1px solid var(--line);color:var(--ink);}
.playmenu button:hover{background:var(--card2);} .playmenu button:last-child{border-bottom:0;}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.35);}
.ph{font-size:11px;text-transform:uppercase;letter-spacing:0.13em;color:var(--mut);font-weight:700;padding:12px 15px 9px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;}
.row{display:grid;gap:14px;}
.cols-2{grid-template-columns:1.3fr 1fr;}.cols-3{grid-template-columns:repeat(3,1fr);}
@media(max-width:980px){.cols-2,.cols-3{grid-template-columns:1fr;}}
.btn{border:1px solid var(--line);background:var(--card2);border-radius:8px;padding:7px 13px;font-size:12.5px;font-weight:600;cursor:pointer;color:var(--ink);}
.btn:hover{background:#272d38;border-color:#333b48;} .btn.pri{background:#eef1f5;color:#11151b;border-color:#eef1f5;}
.btn.red{background:var(--rouge);color:#fff;border-color:var(--rouge);} .btn:disabled{opacity:.4;cursor:default;}
.btn.sm{padding:4px 9px;font-size:11.5px;}
.sel{background:var(--card2);color:var(--ink);border:1px solid var(--line);border-radius:7px;padding:5px 8px;font-size:11.5px;font-family:inherit;cursor:pointer;}
.chip{width:12px;height:12px;border-radius:3px;display:inline-block;vertical-align:middle;}
.tag{font-size:8.5px;font-weight:800;letter-spacing:.04em;padding:1px 5px;border-radius:3px;color:#fff;display:inline-block;}
table.tbl{width:100%;border-collapse:collapse;font-size:12.5px;}
table.tbl th{font-size:9.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);text-align:left;padding:8px 9px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card);z-index:1;}
table.tbl td{padding:7px 9px;border-bottom:1px solid var(--line);white-space:nowrap;color:var(--ink);}
table.tbl tbody tr:nth-child(even) td{background:rgba(255,255,255,.018);}
table.tbl tbody tr:hover td{background:rgba(255,255,255,.045);}
table.tbl tr.me td{background:rgba(30,111,255,.14);}
table.tbl tr.win td{background:rgba(255,215,0,.16);font-weight:700;}
.num{text-align:right;}
.face{position:relative;border-radius:9px;overflow:hidden;background:var(--card2);flex:none;display:flex;align-items:center;justify-content:center;}
.face .fi{font-weight:800;color:#fff;}
.face .fsvg{position:absolute;inset:0;}
.hero{display:flex;gap:16px;align-items:center;padding:16px;flex-wrap:wrap;}
.jstripe{width:8px;align-self:stretch;border-radius:5px;min-height:54px;}
.stat{padding:11px 15px;}.stat .v{font-family:var(--fMono);font-size:22px;font-weight:700;letter-spacing:-.02em;}.stat .l{font-size:9.5px;text-transform:uppercase;letter-spacing:.13em;color:var(--mut);margin-top:1px;}
.statsrow{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border-radius:0 0 12px 12px;overflow:hidden;}
.statsrow>div{background:var(--card);}
.news{max-height:300px;overflow-y:auto;}
.nrow{display:flex;gap:9px;padding:8px 15px;font-size:12.5px;border-left:3px solid var(--line);align-items:baseline;}
.nrow.result{border-color:#3b9fd6;}.nrow.season{border-color:var(--rouge);}.nrow.retire{border-color:#e0a93a;}.nrow.scout{border-color:#3bb0c9;}
.nrow .wk{color:var(--mut);font-size:11px;min-width:54px;flex:none;}
.menu{max-width:560px;margin:60px auto;padding:0 16px;}
.menu h1{font-family:var(--fTitle);font-size:48px;font-weight:700;letter-spacing:0;text-transform:uppercase;margin:0 0 4px;}.menu h1 span{color:var(--rouge);}
.menu .sub{color:var(--mut);font-size:13px;margin-bottom:22px;letter-spacing:.04em;}
.lg{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line);}
.lg:last-child{border-bottom:0;}
.field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px;}
.field label{font-size:11px;text-transform:uppercase;letter-spacing:.13em;color:var(--mut);font-weight:700;}
.field input,.field select{border:1px solid var(--line);background:var(--card2);border-radius:8px;padding:9px 11px;font-size:14px;color:var(--ink);}
.teamgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;max-height:260px;overflow-y:auto;padding:2px;}
.teamopt{border:1px solid var(--line);border-radius:9px;padding:9px;cursor:pointer;display:flex;gap:8px;align-items:center;font-size:12.5px;background:var(--card2);}
.teamopt.on{border-color:var(--rouge);box-shadow:0 0 0 1.5px var(--rouge);}
.profwrap{padding:8px;} .bars{display:flex;flex-direction:column;gap:6px;padding:10px 14px;}
.brow{display:flex;align-items:center;gap:8px;font-size:12px;}
.bname{width:96px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.track{flex:1;height:9px;background:var(--line);border-radius:5px;overflow:hidden;}.fill{height:100%;border-radius:5px;}
.ctrlbar{display:flex;gap:8px;padding:10px 14px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--line);}
.scrub{flex:1;min-width:130px;accent-color:var(--rouge);}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;z-index:50;padding:16px;backdrop-filter:blur(3px);}
.sheet{background:var(--card);border-radius:14px;max-width:580px;width:100%;max-height:88vh;overflow-y:auto;border:1px solid var(--line);box-shadow:0 22px 72px rgba(0,0,0,.6);}
.pill{font-size:11px;padding:2px 8px;border-radius:20px;background:var(--card2);border:1px solid var(--line);color:var(--mut);}
.ordchip{font-size:10.5px;padding:2px 8px;border-radius:6px;background:#2f6f9b22;border:1px solid #2f6f9b55;color:#9fc4dd;cursor:pointer;white-space:nowrap;user-select:none;}
.ordchip:hover{background:#d6311f22;border-color:#d6311f66;color:#f3a397;}
.warn{color:var(--red);font-weight:700;}.ok{color:var(--pos);font-weight:700;}
.barmini{display:inline-block;height:6px;border-radius:3px;background:var(--ink);vertical-align:middle;}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--card2);}
.seg button{border:0;background:transparent;padding:5px 10px;font-size:11px;font-weight:600;color:var(--mut);cursor:pointer;border-right:1px solid var(--line);}
.seg button:last-child{border-right:0;}.seg button.on{background:var(--rouge);color:#fff;}
@media(max-width:780px){.shell{flex-direction:column;}.side{width:100%;height:auto;position:sticky;top:0;flex-direction:column;}.side .logo{padding:10px 16px 8px;}.navv{flex-direction:row;overflow-x:auto;padding:4px 8px 8px;}.navv button.on:before{display:none;}.navv button{white-space:nowrap;}}

/* ---- live race cockpit ---- */
.lr{display:flex;flex-direction:column;gap:14px;}
.lr-stagehdr{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;font-family:var(--fMono);font-size:11.5px;color:var(--mut);letter-spacing:.02em;padding:0 2px;}
.lr-stagehdr .fin{font-family:var(--fTitle);font-size:16px;color:var(--ink);text-transform:uppercase;letter-spacing:.02em;text-align:right;line-height:1.1;}
.lr-stagehdr .finsub{font-family:var(--fMono);font-size:10px;color:var(--cyan);}
.lr-cols{display:grid;grid-template-columns:300px minmax(0,1fr) 296px;gap:14px;align-items:start;}
.lr-cols>div{min-width:0;}
@media(max-width:1120px){.lr-cols{grid-template-columns:1fr;}}
.lr-coltitle{font-family:var(--fMono);font-size:11px;color:var(--blue);text-transform:uppercase;letter-spacing:.09em;margin:2px 0 2px;}
.rcard{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 12px;display:flex;flex-direction:column;gap:8px;cursor:pointer;}
.rcard.sel{border-color:var(--blue);box-shadow:0 0 0 1px var(--blue);}
.rcard.drp{border-color:var(--red);}
.rcard .rtop{display:flex;align-items:center;gap:9px;}
.rcard .rav{width:30px;height:30px;border-radius:8px;background:var(--card2);overflow:hidden;flex:none;position:relative;}
.rcard .nm{font-family:var(--fTitle);font-weight:700;font-size:15px;line-height:1;}
.rcard .role{font-family:var(--fMono);font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em;margin-top:2px;}
.rcard .spill{margin-left:auto;font-family:var(--fMono);font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:3px 7px;border-radius:4px;align-self:flex-start;}
.rcard .erow{display:flex;justify-content:space-between;font-family:var(--fMono);font-size:9.5px;color:var(--mut);letter-spacing:.04em;}
.rcard .grp{font-family:var(--fMono);font-size:9.5px;font-weight:700;letter-spacing:.05em;color:var(--mut);text-transform:uppercase;}
.lr-metric{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);border-radius:12px;overflow:hidden;border:1px solid var(--line);}
.lr-metric>div{background:var(--card);padding:17px 18px 15px;display:flex;flex-direction:column;gap:7px;}
.lr-metric .ml{font-family:var(--fMono);font-size:10.5px;color:var(--mut);text-transform:uppercase;letter-spacing:.07em;}
.lr-metric .mv{font-family:var(--fMono);font-weight:700;font-size:42px;line-height:1;letter-spacing:.01em;}
.lr-metric .ms{font-family:var(--fMono);font-size:10.5px;color:var(--mut);}
.feedrow{display:flex;gap:13px;align-items:center;padding:9px 14px;border-bottom:1px solid var(--line);font-size:13px;}
.feedrow:last-child{border-bottom:0;}
.feedrow .fk{font-family:var(--fMono);font-size:12px;color:var(--cyan);width:52px;flex:none;}
.feedrow .ft{font-family:var(--fMono);font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 6px;border-radius:4px;flex:none;min-width:58px;text-align:center;}
.feedrow .fm{flex:1;min-width:0;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.feedrow .fd{width:8px;height:8px;border-radius:4px;flex:none;}
.cmdgrid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;}
.cmdbtn{display:flex;align-items:center;justify-content:center;height:38px;border-radius:7px;background:var(--card2);border:1px solid var(--line);font-family:'Inter',system-ui,sans-serif;font-weight:800;font-size:9.5px;text-transform:uppercase;letter-spacing:.03em;cursor:pointer;transition:all .14s;text-align:center;padding:0 4px;}
.recact{border:2px solid var(--gold);background:rgba(255,215,0,.06);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:5px;}
.recact .rl{font-family:var(--fMono);font-size:10px;font-weight:700;color:var(--gold);text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:6px;}
.recact .rt{font-family:var(--fTitle);font-weight:700;font-size:16px;text-transform:uppercase;line-height:1;}
.recact .rs{font-size:11px;color:var(--mut);}
.alertbar{border-radius:8px;padding:10px 12px;font-weight:600;font-size:11.5px;line-height:1.35;}
.alertbar .al{font-weight:800;text-transform:uppercase;letter-spacing:.04em;font-size:10.5px;}
.rivalrow{display:flex;align-items:center;justify-content:space-between;padding:8px 11px;border:1px solid var(--line);border-radius:7px;margin-bottom:6px;font-size:12.5px;}
.rivalrow .rt2{font-family:var(--fMono);font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:4px;}
.zoomchip{position:absolute;top:8px;right:10px;z-index:4;font-family:var(--fMono);font-size:9.5px;font-weight:800;letter-spacing:.08em;padding:3px 8px;border:1px solid;border-radius:6px;background:color-mix(in srgb, var(--bg) 82%, transparent);}
.lr-banner{position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:5;display:flex;align-items:center;gap:9px;padding:9px 16px;background:color-mix(in srgb, var(--bg) 88%, transparent);border:1px solid;border-radius:10px;backdrop-filter:blur(4px);animation:bpop .28s cubic-bezier(.2,1.4,.4,1);max-width:86%;}
.lr-banner .bk{font-family:var(--fMono);font-size:9.5px;font-weight:800;letter-spacing:.1em;padding:2px 7px;border-radius:5px;flex:none;}
.lr-banner .bt{font-family:var(--fTitle);font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.lr-banner .bw{font-family:var(--fMono);font-size:10px;color:var(--mut);white-space:nowrap;}
@keyframes bpop{0%{transform:translateX(-50%) scale(.7);opacity:0}100%{transform:translateX(-50%) scale(1);opacity:1}}
.profwrap{transition:box-shadow .45s ease;}
.leaderhud{display:flex;align-items:center;gap:10px;margin-top:8px;padding:7px 12px;border-radius:8px;background:color-mix(in srgb, var(--bg) 60%, transparent);border:1px solid var(--line);font-family:var(--fMono);font-size:12px;}
.leaderhud .lh-tag{font-size:8.5px;font-weight:900;letter-spacing:.11em;color:var(--gold);background:color-mix(in srgb, var(--gold) 16%, transparent);padding:2px 6px;border-radius:4px;flex:none;}
.leaderhud .lh-name{font-weight:800;color:var(--ink);flex:none;}
.leaderhud .lh-loc{color:var(--mut);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.leaderhud .lh-gap{font-weight:800;flex:none;letter-spacing:.02em;}
.leaderhud .lh-e{display:flex;align-items:center;gap:6px;color:var(--mut);font-size:9.5px;font-weight:800;letter-spacing:.06em;flex:none;}
.leaderhud .lh-e b{font-size:12px;}
.leaderhud .lh-bar{width:46px;height:5px;border-radius:3px;background:var(--card2);overflow:hidden;display:inline-block;}
.leaderhud .lh-bar span{display:block;height:100%;border-radius:3px;transition:width .3s ease;}
.dev-dash{display:flex;flex-direction:column;gap:14px;}
.dev-hdr{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:2px 2px 0;}
.dev-title{font-family:var(--fTitle);font-weight:700;font-size:34px;letter-spacing:.01em;line-height:.95;margin:0;text-transform:uppercase;color:var(--ink);}
.dev-sub{font-family:var(--fMono);font-size:11px;letter-spacing:.14em;color:var(--mut);margin-top:7px;}
.nextrace-pill{font-family:var(--fMono);font-size:10px;font-weight:800;letter-spacing:.07em;color:var(--bg);background:var(--amber);border-radius:6px;padding:6px 10px;white-space:nowrap;flex:none;}
.dev-grid{display:grid;grid-template-columns:minmax(0,1fr) 344px;gap:14px;align-items:start;}
@media(max-width:1160px){.dev-grid{grid-template-columns:minmax(0,1fr);}}
.dev-col{display:flex;flex-direction:column;gap:14px;min-width:0;}
.recrow{display:flex;gap:9px;align-items:flex-start;padding:8px 0;font-size:12.5px;line-height:1.35;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);}
.recrow:last-child{border-bottom:none;}
.recrow .ri{flex:none;font-size:13px;line-height:1.3;}
.u23row{display:flex;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);}
.u23row:last-child{border-bottom:none;}
.u23row .u-name{font-weight:700;font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.u23row .u-ovr{font-family:var(--fMono);font-size:11px;color:var(--mut);flex:none;}
.u23row .u-grow{font-family:var(--fMono);font-size:13px;font-weight:800;flex:none;min-width:30px;text-align:right;}
.ibx-msg{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);}
.ibx-msg:last-child{border-bottom:none;}
.ibx-ic{flex:none;width:26px;text-align:center;font-size:14px;line-height:1.3;}
.ibx-wk{flex:none;font-size:10px;color:var(--mut);align-self:center;}
.ibx-unread{background:color-mix(in srgb,var(--blue) 7%,transparent);}
.ibx-unread .ibx-ic{position:relative;}
.ibx-unread .ibx-ic::after{content:"";position:absolute;top:-1px;right:-1px;width:6px;height:6px;border-radius:3px;background:var(--blue);}
.ibx-clik{cursor:pointer;}
.ibx-clik:hover{background:color-mix(in srgb,var(--blue) 12%,transparent);}
.ibx-decision{border:1px solid color-mix(in srgb,var(--amber) 45%,transparent);border-radius:9px;margin:8px;padding:11px;background:color-mix(in srgb,var(--amber) 6%,transparent);}
.ibx-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}
.ibx-flag{font-family:var(--fMono);font-size:8.5px;font-weight:800;letter-spacing:.08em;color:var(--bg);background:var(--amber);border-radius:4px;padding:1px 5px;}
.chip-btn{font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--mut);cursor:pointer;}
.chip-btn.on{background:var(--blue);border-color:var(--blue);color:#fff;}
.splitbtn{display:inline-flex;align-items:stretch;border-radius:8px;overflow:hidden;}
.splitbtn .sb-main{border-radius:0;border-top-left-radius:8px;border-bottom-left-radius:8px;}
.splitbtn .sb-caret{border-radius:0;border-top-right-radius:8px;border-bottom-right-radius:8px;padding:0 8px;border-left:1px solid color-mix(in srgb,#000 25%,transparent);}
.dcard.clik{cursor:pointer;transition:border-color .15s ease,transform .15s ease;}
.dcard.clik:hover{border-color:var(--blue);transform:translateY(-1px);}
.prospect{border:1px solid var(--line);border-radius:10px;padding:10px;cursor:pointer;background:color-mix(in srgb,var(--bg) 45%,transparent);transition:border-color .15s ease,transform .15s ease;}
.prospect:hover{border-color:var(--blue);transform:translateY(-1px);}
.confpip{display:inline-flex;align-items:center;gap:5px;}
.confpip .cbar{width:40px;height:5px;border-radius:3px;background:var(--card2);overflow:hidden;display:inline-block;}
.confpip .cbar span{display:block;height:100%;border-radius:3px;}
.gapbar{display:flex;align-items:stretch;gap:0;margin:0 0 8px;border-radius:8px;overflow:hidden;border:1px solid var(--line);background:color-mix(in srgb, var(--bg) 70%, transparent);font-family:var(--fMono);}
.gapseg{display:flex;flex-direction:column;justify-content:center;gap:2px;padding:6px 11px 6px 12px;border-left:1px solid color-mix(in srgb, var(--line) 70%, transparent);flex:none;position:relative;}
.gapseg:first-child{border-left:none;}
.gapseg.lead{background:color-mix(in srgb, var(--segc) 16%, transparent);}
.gapseg .gs-top{display:flex;align-items:center;gap:6px;font-size:9px;font-weight:800;letter-spacing:.08em;color:var(--mut);}
.gapseg .gs-num{width:15px;height:15px;border-radius:3px;display:flex;align-items:center;justify-content:center;color:var(--bg);font-weight:900;font-size:9.5px;flex:none;}
.gapseg .gs-gap{font-size:15px;font-weight:800;line-height:1;letter-spacing:.01em;}
.gapseg .gs-jersey{width:9px;height:13px;border-radius:2px 2px 3px 3px;flex:none;box-shadow:0 0 0 1px rgba(0,0,0,.4);}
.roadrow{display:flex;align-items:center;gap:8px;padding:5px 2px;border-bottom:1px solid color-mix(in srgb, var(--line) 55%, transparent);font-size:12px;}
.roadrow:last-of-type{border-bottom:none;}
.rr-dot{width:9px;height:9px;border-radius:5px;flex:none;}
.rr-label{font-family:var(--fMono);font-size:10px;font-weight:800;letter-spacing:.07em;flex:none;}
.rr-n{color:var(--mut);font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rr-mine{font-size:10px;font-weight:800;color:var(--bg);background:var(--blue);border-radius:4px;padding:1px 5px;flex:none;}
.rr-gap{font-size:11.5px;font-weight:700;flex:none;}
.lr-radio{font-family:var(--fMono);font-size:11px;color:var(--cyan);line-height:1.95;letter-spacing:.02em;}
.lr-radio .rk{opacity:.85;}
.lr-bottom{display:flex;gap:22px;flex-wrap:wrap;align-items:center;padding:12px 16px;border-top:1px solid var(--line);background:var(--card);border-radius:12px;font-family:var(--fMono);font-size:11px;color:var(--mut);letter-spacing:.02em;}
.gcrow{display:flex;gap:11px;align-items:center;padding:9px 14px;border-bottom:1px solid var(--line);font-size:12.5px;}
.gcrow:last-child{border-bottom:0;}
.gcrow.me2{background:rgba(30,111,255,.10);}
.gcrow .gp{font-family:var(--fMono);width:16px;color:var(--mut);text-align:right;}
.gcrow .gn{flex:1;font-weight:600;}
.gcrow .gnat{color:var(--mut);font-size:10.5px;margin-left:4px;}
.gcrow .gg{font-family:var(--fMono);color:var(--mut);}
.sech{font-family:var(--fMono);font-size:11px;color:var(--blue);text-transform:uppercase;letter-spacing:.09em;margin:4px 0;}

/* ---- command dashboard ---- */
.dash{display:flex;flex-direction:column;gap:16px;}
.dhero{position:relative;border:1px solid var(--blue);border-radius:14px;background:var(--card);padding:22px 24px;overflow:hidden;box-shadow:0 0 24px rgba(30,111,255,.10);}
.dhero .tags{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;}
.dtag{font-family:var(--fMono);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:3px 8px;border-radius:4px;}
.dhero h2{font-family:var(--fTitle);font-weight:700;font-size:38px;line-height:1;margin:0;text-transform:uppercase;letter-spacing:.01em;}
.dhero .hsub{color:var(--mut);font-size:13.5px;margin-top:8px;}
.dhero .hobj{position:absolute;top:22px;right:24px;text-align:right;max-width:320px;}
.dhero .hobjt{font-family:var(--fMono);font-size:12px;font-weight:700;color:var(--gold);letter-spacing:.03em;text-transform:uppercase;line-height:1.4;}
.dhero .hsil{position:relative;margin-top:10px;height:120px;}
.dgrid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;}
.dgrid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;}
@media(max-width:900px){.dgrid3,.dgrid2{grid-template-columns:1fr;}}
.dcard{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;}
.dcard.warn-b{border-color:var(--amber);}
.dcard h3{font-family:var(--fTitle);font-weight:700;font-size:18px;text-transform:uppercase;letter-spacing:.02em;margin:0 0 14px;}
.fatrow{margin-bottom:11px;}
.fatrow .ftl{display:flex;justify-content:space-between;font-family:var(--fMono);font-size:11px;margin-bottom:4px;color:var(--mut);}
.formbars{display:flex;align-items:flex-end;gap:12px;height:118px;justify-content:center;padding:6px 0;}
.formbars>div{width:36px;border-radius:3px 3px 0 0;}
.donut{display:flex;align-items:center;gap:20px;}
.donut .dn{font-family:var(--fMono);font-weight:700;font-size:32px;line-height:1;}
.objr{margin-bottom:16px;}
.objr .objh{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
.objr .objt{font-family:var(--fTitle);font-weight:700;font-size:15px;text-transform:uppercase;}
.riskpill{font-family:var(--fMono);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:3px 9px;border-radius:4px;}
.dticker{display:flex;gap:20px;flex-wrap:wrap;padding:13px 18px;border-top:1px solid var(--line);background:var(--card);border-radius:12px;font-family:var(--fMono);font-size:11px;color:var(--cyan);letter-spacing:.02em;}
.dlink{font-family:var(--fMono);font-size:11px;color:var(--blue);cursor:pointer;text-transform:uppercase;letter-spacing:.04em;}

/* ---- rider profile ---- */
.sheet.rpro{max-width:1080px;width:96vw;padding:0;}
.rp-grid{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:18px;padding:18px;}
@media(max-width:920px){.rp-grid{grid-template-columns:1fr;}}
.rp-hero{display:flex;gap:20px;align-items:center;border:1px solid var(--line);border-radius:14px;padding:18px;background:var(--card);}
.rp-face{width:150px;height:132px;border-radius:12px;overflow:hidden;background:linear-gradient(160deg,#1b2430,#0d1117);flex:none;display:flex;align-items:flex-end;justify-content:center;}
.rp-name{font-family:var(--fTitle);font-weight:700;font-size:38px;line-height:.95;text-transform:uppercase;margin:10px 0 14px;}
.rp-tagrow{display:flex;gap:8px;}
.rp-tag{font-family:var(--fMono);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:3px 9px;border-radius:4px;}
.rp-vitals{display:flex;gap:34px;flex-wrap:wrap;}
.rp-vitals .lab{font-family:var(--fMono);font-size:9.5px;color:var(--mut);letter-spacing:.08em;text-transform:uppercase;}
.rp-vitals .val{font-family:var(--fTitle);font-weight:700;font-size:24px;line-height:1.15;}
.rp-tabs{display:flex;gap:24px;border-bottom:1px solid var(--line);margin:18px 0;flex-wrap:wrap;}
.rp-tabs button{background:0;border:0;color:var(--mut);font-family:var(--fMono);font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:0 0 12px;cursor:pointer;position:relative;}
.rp-tabs button.on{color:var(--ink);}
.rp-tabs button.on:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--blue);}
.rp-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:22px;}
@media(max-width:680px){.rp-metrics{grid-template-columns:1fr 1fr;}}
.rp-metric{border:2px solid var(--line);border-radius:12px;padding:14px;min-height:92px;display:flex;flex-direction:column;gap:7px;}
.rp-metric .ml{font-family:var(--fMono);font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;}
.rp-metric .mv{font-family:var(--fMono);font-weight:700;font-size:28px;line-height:1;}
.rp-sect{font-family:var(--fMono);font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.1em;margin:0 0 12px;}
.rp-attrs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:24px;}
@media(max-width:680px){.rp-attrs{grid-template-columns:1fr 1fr;}}
.rp-attr{border:1px solid var(--line);border-radius:10px;padding:12px 13px;position:relative;background:var(--card2);}
.rp-attr .av{font-family:var(--fMono);font-weight:700;font-size:21px;line-height:1;}
.rp-attr .al{font-family:var(--fMono);font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin-top:7px;}
.rp-attr .ad{position:absolute;top:13px;right:13px;width:6px;height:6px;border-radius:3px;}
.rp-trend{border:1px solid var(--line);border-radius:12px;padding:18px;}
.rp-trendbars{display:flex;align-items:flex-end;gap:8px;height:148px;}
.rp-trendbars>div{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;justify-content:flex-end;}
.rp-trendbars .bar{width:6px;border-radius:3px;background:var(--blue);}
.rp-trendbars .wk{font-family:var(--fMono);font-size:8px;color:var(--mut);}
.rp-side{display:flex;flex-direction:column;gap:16px;}
.rp-card{border:1px solid var(--line);border-radius:12px;padding:16px;background:var(--card);}
.rp-card.b-blue{border-color:var(--blue);}
.rp-card.b-green{border-color:var(--green);}
.rp-card h4{font-family:var(--fTitle);font-weight:700;font-size:15px;text-transform:uppercase;letter-spacing:.02em;margin:0 0 12px;}
.rp-rrow{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px;}
.rp-rrow:last-child{border-bottom:0;}
.rp-pill{font-family:var(--fMono);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:3px 9px;border-radius:4px;display:inline-block;}
`;

// ---------- shared little components ----------------------------------------
// Nav button with a lucide-animated icon. Motion can't be CSS-triggered, so we
// drive the icon's animation imperatively from the whole button's hover (matching
// the old ai-pop behaviour) via the component's startAnimation/stopAnimation handle.
function NavTab({ icon: Icon, label, active, badge, onClick }) {
  const ref = React.useRef(null);
  return (
    <button className={active ? "on" : ""} onClick={onClick}
      onMouseEnter={() => ref.current?.startAnimation?.()}
      onMouseLeave={() => ref.current?.stopAnimation?.()}>
      <span className="ico"><span className="aicon"><Icon ref={ref} size={17} /></span></span>
      <span>{label}</span>
      {badge}
    </button>
  );
}
function Face({ rider, size = 44 }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    let alive = true;
    getFaces().then((m) => {
      if (!alive || !m || !ref.current) return;
      try {
        let f = _faceCache.get(rider.id);
        if (!f) { f = m.generate(); _faceCache.set(rider.id, f); }
        ref.current.innerHTML = ""; m.display(ref.current, f);
      } catch (e) {}
    });
    return () => { alive = false; };
  }, [rider.id]);
  const init = (rider.short || rider.name || "?").replace(/[^A-Za-z ]/g, "").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="face" style={{ width: size, height: size, fontSize: size * 0.34, background: rider.jersey || "#888" }}>
      <span className="fi">{init}</span>
      <div className="fsvg" ref={ref} />
    </div>
  );
}
const Tag = ({ a }) => { const x = ARCHG[a] || ARCHG.helper; return <span className="tag" style={{ background: x.col }}>{x.tag}</span>; };
const Ovr = ({ o }) => <b className="mono" style={{ color: ovrCol(o) }}>{o}</b>;

// elevation profile + race profile viz (shared with race day)
function elevationProfile(stage) {
  const L = stage.lengthKm, step = Math.max(0.5, L / 360), pts = []; let elev = 0;
  const slopeAt = (km) => { for (const [a, b, s] of stage.segments) if (km >= a && km < b) return s; return stage.segments[stage.segments.length - 1][2]; };
  for (let km = 0; km <= L + 1e-9; km += step) { if (km > 0) elev += slopeAt(Math.min(km, L - 1e-6)) * step * 1000; pts.push({ km, elev }); }
  let minE = Infinity, maxE = -Infinity, climb = 0;
  pts.forEach((p, i) => { minE = Math.min(minE, p.elev); maxE = Math.max(maxE, p.elev); if (i && p.elev > pts[i - 1].elev) climb += p.elev - pts[i - 1].elev; });
  return { pts, minE, maxE, L, climb: Math.round(climb), step, slopeAt };
}
function RaceProfile({ stage, prof, frame, mine = [], h = 180, window: win = null, accent = null, onPick = null, spot = null }) {
  const W = 1000, padL = 12, padR = 12, padT = 16, padB = 22;
  const a0 = win ? Math.max(0, win.a) : 0, b0 = win ? Math.min(prof.L, win.b) : prof.L;
  const zoomed = win && (b0 - a0) < prof.L - 1;
  const x = (km) => padL + ((km - a0) / Math.max(b0 - a0, 0.5)) * (W - padL - padR);
  const elevAt = (km) => { const f = Math.min(Math.max(km, 0), prof.L) / prof.step; const i = Math.floor(f), p0 = prof.pts[i], p1 = prof.pts[Math.min(i + 1, prof.pts.length - 1)]; return p0.elev + (p1.elev - p0.elev) * (f - i); };
  // local elevation range inside the window so a climb fills the frame when zoomed in
  let loE = prof.minE, hiE = prof.maxE;
  if (zoomed) { loE = Infinity; hiE = -Infinity; for (const pp of prof.pts) if (pp.km >= a0 && pp.km <= b0) { loE = Math.min(loE, pp.elev); hiE = Math.max(hiE, pp.elev); } if (!isFinite(loE)) { loE = prof.minE; hiE = prof.maxE; } }
  const span = Math.max(hiE - loE, zoomed ? 40 : 60);
  const y = (e) => h - padB - ((e - loE) / span) * (h - padT - padB);
  const terr = accent || (stage.mode === "itt" ? "var(--gold)" : (stage.finishType === "summit" || stage.finishType === "mountain") ? "var(--purple)" : stage.cobbles ? "var(--amber)" : "var(--blue)");
  const inWin = (km) => km >= a0 - 0.01 && km <= b0 + 0.01;
  const pts = prof.pts.filter((pp) => inWin(pp.km));
  if (!pts.length || pts[0].km > a0) pts.unshift({ km: a0, elev: elevAt(a0) });
  if (pts[pts.length - 1].km < b0) pts.push({ km: b0, elev: elevAt(b0) });
  let area = `M ${x(a0)} ${h - padB} `; pts.forEach((pp) => (area += `L ${x(pp.km).toFixed(1)} ${y(pp.elev).toFixed(1)} `)); area += `L ${x(b0)} ${h - padB} Z`;
  const bands = stage.segments.filter(([sa, sb, sl]) => sl >= 0.04 && sb > a0 && sa < b0).map(([sa, sb, sl], i) =>
    <rect key={i} x={x(Math.max(sa, a0))} y={padT} width={x(Math.min(sb, b0)) - x(Math.max(sa, a0))} height={h - padT - padB} fill="var(--purple)" opacity={Math.min(0.04 + sl * 1.4, 0.2)} />);
  const groups = (frame?.groups || []).filter((g) => inWin(g.posKm)).slice().sort((a, b) => a.n - b.n);
  const zScale = zoomed ? 1.5 : 1;
  const dots = groups.map((g, i) => {
    const cx = x(g.posKm), cy = y(elevAt(g.posKm)) - 6, esc = g.type === "break" || g.type === "solo" || g.type === "chase";
    const r = (g.type === "peloton" ? Math.min(7 + Math.sqrt(g.n), 12) : esc ? Math.max(3.2, Math.min(3 + Math.sqrt(g.n), 6.5)) : 3.6) * zScale;
    const fill = esc ? g.jersey : g.type === "grupetto" ? "var(--mut)" : "var(--card2)";
    const label = zoomed ? (g.type === "peloton" ? `PELOTON ×${g.n}` : g.type === "grupetto" ? `GRUPETTO ×${g.n}` : g.n === 1 ? (g.lead || "") : `${g.lead || ""} ×${g.n}`) : null;
    return (
      <g key={i}>
        {g.type === "peloton" ? <ellipse cx={cx} cy={cy} rx={r + 3} ry={r} fill={fill} opacity=".92" />
          : <circle cx={cx} cy={cy} r={r} fill={fill} stroke={g.type === "solo" ? "var(--red)" : "#fff"} strokeWidth={g.type === "solo" ? 2 : 1} />}
        {label && <text x={cx} y={cy - r - 5} textAnchor="middle" fontSize="9.5" fontWeight="800" fill="var(--ink)" className="mono" style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}>{label}</text>}
      </g>
    );
  });
  const inits = (str) => (str.match(/[A-Z0-9]/g) || [str[0]]).slice(0, 2).join("");
  const onRoad = (mine || []).filter((t) => t.posKm != null && t.gType !== "fin" && t.gType !== "out" && inWin(t.posKm));
  const pins = onRoad.map((t, i) => {
    const cx = x(t.posKm), cy = y(elevAt(t.posKm)) + 10, low = t.w < 0.16;
    return (
      <g key={"pin" + i}>
        <line x1={cx} y1={cy - 9} x2={cx} y2={cy - 3} stroke={low ? "var(--red)" : "var(--ink)"} strokeWidth="1" opacity=".5" />
        <circle cx={cx} cy={cy} r={6 * zScale} fill={t.jersey} stroke={low ? "var(--red)" : "var(--bg)"} strokeWidth={low ? 2 : 1.4} />
        <text x={cx} y={cy + 2.7 * zScale} textAnchor="middle" fontSize={6.6 * zScale} fontWeight="800" fill="var(--bg)">{inits(t.short)}</text>
      </g>
    );
  });
  const br = (frame?.groups || []).find((g) => g.type === "break" || g.type === "solo"), pe = (frame?.groups || []).find((g) => g.type === "peloton");
  let gap = null;
  if (br && pe && br.posKm - pe.posKm > 0.25 && inWin(br.posKm) && inWin(pe.posKm)) { const x1 = x(pe.posKm), x2 = x(br.posKm), yb = y(elevAt(br.posKm)) - 6;
    gap = <g><line x1={x1} y1={yb} x2={x2} y2={yb} stroke="var(--red)" strokeWidth="1" strokeDasharray="2 3" opacity=".8" /><text x={(x1 + x2) / 2} y={yb - 5} textAnchor="middle" fontSize="11" fill="var(--red)" className="mono" fontWeight="700">{"+" + bcast(frame.gapSec)}</text></g>; }
  // spotlight: when a decisive moment fires, a pulsing ring routes the eye to WHERE on the road it happened
  let spotNode = null;
  if (spot && spot.km != null && inWin(spot.km)) {
    const SPOTC = { attack: "var(--amber)", catch: "var(--green)", drop: "var(--amber)", win: "var(--gold)", weather: "var(--red)" };
    const sc = SPOTC[spot.kind] || "var(--gold)"; const cx = x(spot.km), cy = y(elevAt(spot.km)) - 6;
    spotNode = (<g pointerEvents="none"><circle cx={cx} cy={cy} r="5" fill="none" stroke={sc} strokeWidth="2.5"><animate attributeName="r" values="5;30" dur="1.2s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.95;0" dur="1.2s" repeatCount="indefinite" /></circle><circle cx={cx} cy={cy} r="3.5" fill={sc} /></g>);
  }
  // ticks: km markers zoomed out, KM-TO-GO markers zoomed in near the finish
  const ticks = [];
  const width = b0 - a0;
  const ts = width > 120 ? 30 : width > 50 ? 10 : width > 15 ? 5 : 1;
  const start = Math.ceil(a0 / ts) * ts;
  for (let km = start; km <= b0 + 0.01; km += ts) ticks.push(km);
  const tickLabel = (km) => (zoomed && b0 >= prof.L - 1 ? (prof.L - km <= 0.01 ? "FIN" : `-${(prof.L - km).toFixed(0)}`) : km.toFixed(0));
  const pick = (e) => {
    if (!onPick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = (e.clientX - rect.left) / rect.width * W;
    onPick(Math.max(0, Math.min(prof.L, a0 + ((vx - padL) / (W - padL - padR)) * (b0 - a0))));
  };
  return (
    <svg viewBox={`0 0 ${W} ${h}`} width="100%" preserveAspectRatio="xMidYMid meet" style={{ display: "block", cursor: onPick ? (zoomed ? "zoom-out" : "zoom-in") : "default" }} onClick={pick}>
      {ticks.map((km) => <g key={km}><line x1={x(km)} y1={padT} x2={x(km)} y2={h - padB} stroke="var(--line)" /><text x={x(km)} y={h - 7} textAnchor="middle" fontSize="9.5" fill="var(--mut)" className="mono">{tickLabel(km)}</text></g>)}
      {bands}
      <path d={area} fill={terr} opacity=".3" />
      <polyline points={pts.map((pp) => `${x(pp.km).toFixed(1)},${y(pp.elev).toFixed(1)}`).join(" ")} fill="none" stroke={terr} strokeWidth="2" />
      {b0 >= prof.L - 0.01 && <line x1={x(prof.L)} y1={padT} x2={x(prof.L)} y2={h - padB} stroke="var(--red)" strokeWidth="2" />}
      {gap}{dots}{pins}{spotNode}
    </svg>
  );
}

// ============================================================================
//  RACE VIEW — one stage, watch + live control (re-sim from current point)
// ============================================================================
const DUTYLAB = { leader: ["LEADER", "#d6311f"], coleader: ["CO-LEAD", "#e0851e"], sprinter: ["SPRINT", "#b3531d"], leadout: ["LEAD-OUT", "#7a3fb0"], attacker: ["ATTACK", "#2b59c3"], captain: ["CAPTAIN", "var(--green)"], domestique: ["DOM", "#6b6760"] };
const GSTAT = { peloton: "in the bunch", break: "in the break", solo: "up the road", chase: "chasing", grupetto: "grupetto", fin: "finished", out: "out of race" };
const bcast = (sec) => { sec = Math.round(Math.max(0, sec)); return sec >= 60 ? Math.floor(sec / 60) + "'" + String(sec % 60).padStart(2, "0") + '"' : sec + '"'; };  // TV gap format: 1'35" / 40"
// Live race-shape readout: groups placed by their gap behind the front, gap clock + survival verdict
function RaceSituation({ frame, mine, kmToGo, atEnd }) {
  const groups = (frame.groups || []).filter((g) => g.n > 0);
  const frontKm = groups.length ? Math.max(...groups.map((g) => g.posKm)) : 0;
  const frontG = groups.find((g) => g.posKm === frontKm) || {};
  const vFront = Math.max((frontG.spd || 40) / 3.6, 7);
  const gapOf = (km) => Math.max(0, (frontKm - km) * 1000 / vFront);
  const maxGap = Math.max(60, (frame.gapSec || 0) * 1.7);   // scale to the break↔bunch action, not far stragglers
  const racing = groups.filter((g) => g.type !== "grupetto");
  const droppedN = groups.filter((g) => g.type === "grupetto").reduce((s, g) => s + g.n, 0);
  const br = groups.find((g) => g.type === "break" || g.type === "solo");
  const pe = groups.find((g) => g.type === "peloton");
  const lead = frame.gapSec || 0;
  const needed = Math.max((kmToGo / 10) * 60, 1);     // ~1 min per 10 km to survive
  let verdict = "", vcol = "#5b5750";
  if (lead > 3 && br && pe) {
    const ratio = lead / needed;
    if (kmToGo < 1.5) { verdict = "holding on!"; vcol = "var(--green)"; }
    else if (ratio > 1.35) { verdict = "break has time"; vcol = "var(--green)"; }
    else if (ratio > 0.82) { verdict = "touch and go"; vcol = "#c0871e"; }
    else { verdict = "coming back"; vcol = "#d6311f"; }
  } else if (groups.length <= 1) verdict = "all together";
  const finale = kmToGo <= 5 && !atEnd;
  const tlab = { break: "break", solo: "leader", peloton: "bunch", chase: "chase", grupetto: "grupetto", fin: "fin" };
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div className="ph" style={finale ? { background: "rgba(240,68,56,.16)", color: "#f3705f" } : null}>
        {finale ? (kmToGo <= 1 ? "🔔 Final kilometre" : "🔔 Finale") : "Race situation"}
        <span className="mono" style={{ letterSpacing: 0 }}>{Math.max(0, kmToGo).toFixed(1)} km to go</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "12px 14px 2px", flexWrap: "wrap" }}>
        {lead > 3 && br && pe ? (
          <>
            <span className="mono" style={{ fontSize: 28, fontWeight: 800, color: "#d6311f", lineHeight: 1 }}>+{fmtGap(lead)}</span>
            <span style={{ fontSize: 12.5, color: "var(--mut)" }}>{br.n === 1 ? "lone leader" : `${br.n}-rider break`} over the {pe.n > 40 ? "bunch" : `${pe.n}-strong chase`}</span>
          </>
        ) : <span className="mono" style={{ fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{groups.length <= 1 ? "All together" : `${groups.length} groups on the road`}</span>}
        {verdict && <span style={{ marginLeft: "auto", fontWeight: 800, color: vcol, fontSize: 12.5, textTransform: "uppercase", letterSpacing: ".04em" }}>{verdict}</span>}
      </div>
      <div style={{ position: "relative", height: 54, margin: "12px 16px 2px", borderLeft: "2px solid var(--ink)" }}>
        <span style={{ position: "absolute", left: 2, top: -15, fontSize: 8.5, fontWeight: 800, letterSpacing: ".08em", color: "var(--ink)" }}>FINISH ▸</span>
        {racing.map((g, i) => {
          const x = Math.min(gapOf(g.posKm), maxGap) / maxGap * 100, wide = g.type === "peloton";
          const sz = wide ? 20 : 11;
          return (
            <div key={i} style={{ position: "absolute", left: `calc(${x}% - ${sz / 2}px)`, top: 18 }}>
              <div style={{ width: sz, height: sz, borderRadius: wide ? 5 : 999, background: g.jersey, border: "1.5px solid rgba(0,0,0,.4)" }} />
              <div style={{ position: "absolute", top: sz + 2, left: "50%", transform: "translateX(-50%)", fontSize: 8.5, color: "var(--mut)", whiteSpace: "nowrap", fontWeight: 600 }}>{tlab[g.type] || g.type} {g.n}</div>
            </div>
          );
        })}
        {droppedN > 0 && (
          <div style={{ position: "absolute", left: "calc(100% - 5px)", top: 20 }}>
            <div style={{ width: 9, height: 9, borderRadius: 999, background: "var(--know0)", opacity: 0.6 }} />
            <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", fontSize: 8.5, color: "var(--mut)", whiteSpace: "nowrap" }}>+{droppedN} shed</div>
          </div>
        )}
        {(mine || []).filter((t) => t.gType !== "fin" && t.gType !== "out").map((t) => {
          const x = Math.min(maxGap, t.gapSec || 0) / maxGap * 100;
          return <div key={t.id} title={t.short} style={{ position: "absolute", left: `calc(${x}% - 5px)`, top: -1, fontSize: 12, color: t.jersey, lineHeight: 1, textShadow: "0 0 2px rgba(0,0,0,.5)" }}>▾</div>;
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 16px 10px", fontSize: 10.5, color: "var(--mut)" }}>
        <span className="mono">{frontG.spd || 0} km/h at the front{(mine || []).some((t) => t.gType !== "fin" && t.gType !== "out") ? " · ▾ your riders" : ""}</span>
        {br && br.lead ? <span>led by {br.lead}</span> : <span />}
      </div>
    </div>
  );
}

function TimeTrialView({ sim, race, stage, onFinish, state }) {
  const userLids = new Set(state.teams[state.userTeamId].riderIds);
  const isLast = stage === race.stages[race.stages.length - 1];
  const res = sim.results;
  const rows = res.slice(0, 12).slice();
  for (const m of res.filter((r) => userLids.has(r.lid))) if (!rows.includes(m)) rows.push(m);
  rows.sort((a, b) => a.place - b.place);
  const myBest = res.find((r) => userLids.has(r.lid));
  return (
    <div className="card">
      <div className="ph">⏱ {stage.name} — time trial<span className="mono" style={{ letterSpacing: 0 }}>{fmtTime(sim.durationSec)} winner</span></div>
      <div style={{ padding: "11px 14px", borderBottom: "1px solid var(--line)", fontSize: 12.5, color: "var(--mut)" }}>
        Against the clock — no drafting, no teammates. {myBest ? <>Your best: <b style={{ color: "var(--ink)" }}>{myBest.short}</b>, {myBest.place === 1 ? "the fastest time!" : `${myBest.place}${myBest.place === 2 ? "nd" : myBest.place === 3 ? "rd" : "th"}, +${fmtGap(myBest.gapSec)}`}.</> : null}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead><tr><th>#</th><th>Rider</th><th>Team</th><th className="num">Time</th><th className="num">Gap</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.lid} className={userLids.has(r.lid) ? "me" : ""}><td className="mono">{r.place}</td><td style={{ fontWeight: 600 }}>{r.short}</td><td style={{ color: "var(--mut)", fontSize: 11 }}>{r.team}</td><td className="num mono">{fmtTime(r.timeSec)}</td><td className="num mono">{r.place === 1 ? "—" : "+" + fmtGap(r.gapSec)}</td></tr>)}</tbody>
        </table>
      </div>
      <div style={{ padding: 12 }}><button className="btn red" style={{ width: "100%" }} onClick={() => onFinish(sim.results.map((r) => ({ lid: r.lid, timeSec: r.timeSec, gapSec: r.gapSec })), sim.log)}>{isLast ? "See the result →" : "Confirm stage →"}</button></div>
    </div>
  );
}
function RaceView({ state, race, stage, entries, seedBump, baseCommands = [], onFinish, onSimInstant }) {
  const uti = entries.findIndex((e) => e.teamId === state.userTeamId);
  const prof = React.useMemo(() => elevationProfile(stage), [stage]);
  const [commands, setCommands] = React.useState([]);
  const allCmds = React.useMemo(() => [...baseCommands, ...commands], [baseCommands, commands]);
  const [sim, setSim] = React.useState(() => runStage(state, race, stage, entries, seedBump, baseCommands, true).out);
  const [fi, setFi] = React.useState(0);
  const fiRef = React.useRef(0);   // fractional playback clock (state only carries whole-frame changes)
  const seek = (v) => { fiRef.current = typeof v === "function" ? v(fiRef.current) : v; setFi(fiRef.current); };
  const [playing, setPlaying] = React.useState(true);
  const [speed, setSpeed] = React.useState(3);
  const [autoSlow, setAutoSlow] = React.useState(true);
  const [paceLevel, setPaceLevel] = React.useState(null);
  const [selRider, setSelRider] = React.useState(null);
  const [profile, setProfile] = React.useState(null);
  const [zoomMode, setZoomMode] = React.useState("auto");    // "auto" | "off" | {a,b} manual window
  const flammeRef = React.useRef(false);
  const [banner, setBanner] = React.useState(null);          // big moment overlay (attack / catch / crack / win / order)
  const bannerTimer = React.useRef(null);
  const lastEvRef = React.useRef(-1);
  const flash = React.useCallback((kind, text, why, km) => {
    setBanner({ kind, text, why, km });
    clearTimeout(bannerTimer.current);
    bannerTimer.current = setTimeout(() => setBanner(null), 2600);
  }, []);
  // surface key events as moment banners the instant playback reaches them
  React.useEffect(() => {
    const curT2 = sim.frames?.[Math.min(Math.floor(fi), (sim.frames?.length || 1) - 1)]?.t ?? 0;
    const KEY = { attack: 1, catch: 1, drop: 1, win: 1, weather: 1 };
    for (let i = sim.log.length - 1; i >= 0; i--) {
      const e = sim.log[i];
      if (e.t <= curT2 + 0.1) {
        if (i > lastEvRef.current && KEY[e.kind]) { lastEvRef.current = i; flash(e.kind, e.text, e.why, e.km); }
        else if (i > lastEvRef.current) lastEvRef.current = i;
        break;
      }
    }
    const lk = sim.frames?.[Math.min(Math.floor(fi), (sim.frames?.length || 1) - 1)]?.leadKm ?? 0;
    if (!flammeRef.current && lk >= stage.lengthKm - 1 && lk < stage.lengthKm - 0.05) { flammeRef.current = true; flash("flamme", "FLAMME ROUGE — 1 KM TO GO"); }
  }, [Math.floor(fi), sim, flash, stage.lengthKm]);

  // re-run when commands change, preserving playback time (skip mount — the initial sim already ran)
  const firstSim = React.useRef(true);
  React.useEffect(() => {
    if (firstSim.current) { firstSim.current = false; return; }
    const tNow = sim.frames[Math.min(Math.floor(fi), sim.frames.length - 1)]?.t ?? 0;
    const out = runStage(state, race, stage, entries, seedBump, allCmds, true).out;
    let idx = out.frames.findIndex((f) => f.t >= tNow); if (idx < 0) idx = out.frames.length - 1;
    setSim(out); setFi(idx); fiRef.current = idx;
    // eslint-disable-next-line
  }, [commands]);

  React.useEffect(() => {
    if (!playing) return;
    let raf, last = performance.now();
    const tick = (now) => { const d = (now - last) / 1000; last = now;
      setFi((i) => {
        const fr = sim.frames[Math.min(Math.floor(i), sim.frames.length - 1)];
        const km2go = prof.L - (fr ? fr.leadKm : 0);
        // cinematic pacing: near-freeze at the line (photo-finish), heavy slow through the finale
        let slow = km2go < 0.6 ? 0.06 : km2go < 1.5 ? 0.16 : km2go < 3.5 ? 0.38 : km2go < 8 ? 0.65 : 1;
        if (autoSlow && fr) { // the race ignites → drop to slow motion so you can watch AND react
          const ev = sim.log.find((e) => e.t >= fr.t - 0.5 && e.t <= fr.t + 8 && (e.kind === "attack" || e.kind === "catch" || e.kind === "drop" || e.kind === "weather"));
          if (ev) slow = Math.min(slow, 0.15);
        }
        const n = fiRef.current + d * speed * 24 * slow;
        fiRef.current = n;                                     // fractional time lives in the ref…
        if (n >= sim.frames.length - 1) { setPlaying(false); return sim.frames.length - 1; }
        return Math.floor(n) === Math.floor(i) ? i : n;        // …re-render only when the shown frame changes
      });
      raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [playing, sim, speed, autoSlow]);

  // self-heal: if a frame-less sim ever lands here, re-run with frames on (never for time trials — they have no peloton)
  React.useEffect(() => {
    if (sim.mode !== "itt" && (!sim.frames || sim.frames.length === 0))
      setSim(runStage(state, race, stage, entries, seedBump, allCmds, true).out);
    // eslint-disable-next-line
  }, [sim]);

  // keyboard control — space play/pause, arrows scrub, [ ] speed
  React.useEffect(() => {
    const h = (e) => {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      if (e.code === "Space") { e.preventDefault(); setPlaying((p) => { if (!p) seek((i) => (i >= sim.frames.length - 1 ? 0 : i)); return !p; }); }
      else if (e.code === "ArrowRight") { e.preventDefault(); setPlaying(false); seek((i) => Math.min(sim.frames.length - 1, i + (e.shiftKey ? 40 : 10))); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); setPlaying(false); seek((i) => Math.max(0, i - (e.shiftKey ? 40 : 10))); }
      else if (e.key === "]") setSpeed((s) => (s === 1 ? 3 : 6));
      else if (e.key === "[") setSpeed((s) => (s === 6 ? 3 : 1));
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [sim]);

  if (sim.mode === "itt") return <TimeTrialView sim={sim} race={race} stage={stage} onFinish={onFinish} state={state} />;

  const frames = sim.frames || [];
  const idx = frames.length ? Math.max(0, Math.min(Math.floor(fi), frames.length - 1)) : -1;
  const frame = idx >= 0 ? frames[idx] : null;
  if (!frame) return <div className="card" style={{ padding: 28, textAlign: "center", color: "var(--mut)" }}>Preparing race…</div>;
  const curT = frame.t, atEnd = idx >= frames.length - 1;
  // interpolate group positions between frames (matched by gid) — smooth motion instead of 20s jumps
  const nxtF = frames[Math.min(idx + 1, frames.length - 1)];
  const frac = Math.max(0, Math.min(1, fi - idx));
  const nxtBy = new Map((nxtF.groups || []).filter((g) => g.gid != null).map((g) => [g.gid, g]));
  const dispGroups = frame.groups.map((g) => {
    const b2 = g.gid != null ? nxtBy.get(g.gid) : null;
    return b2 ? { ...g, posKm: +(g.posKm + (b2.posKm - g.posKm) * frac).toFixed(2), gapSec: Math.round((g.gapSec ?? 0) + ((b2.gapSec ?? g.gapSec ?? 0) - (g.gapSec ?? 0)) * frac) } : g;
  });
  const dispFrame = { ...frame, groups: dispGroups, leadKm: +(frame.leadKm + ((nxtF.leadKm ?? frame.leadKm) - frame.leadKm) * frac).toFixed(2) };
  const front = dispGroups.slice().sort((a, b) => b.posKm - a.posKm)[0];
  const kmToGo = (prof.L - (front ? front.posKm : 0));
  const prevF = frames[Math.max(0, idx - 8)];                     // a few minutes back, for gap-trend arrows
  const prevBy = new Map((prevF.groups || []).filter((g) => g.gid != null).map((g) => [g.gid, g]));
  // grand-tour identity: the race's jersey colour owns the broadcast
  const raceAccent = /Tour de France/i.test(race.name) ? "#ffd700" : /Giro/i.test(race.name) ? "#ff4fa3" : /Vuelta/i.test(race.name) ? "#e0322b" : null;
  // auto-zoom: finale, fresh action, or the climb the front group is on
  const kmToGoNow = prof.L - (dispFrame.leadKm || 0);
  let autoWin = null, winLabel = null;
  if (kmToGoNow <= 10) { autoWin = { a: Math.max(0, prof.L - 12), b: prof.L }; winLabel = "FINALE"; }
  else {
    const recentEv = [...sim.log].reverse().find((e) => e.t <= curT + 0.1 && e.t >= curT - 40 && (e.kind === "attack" || e.kind === "catch" || e.kind === "drop"));
    if (recentEv) { autoWin = { a: Math.max(0, recentEv.km - 7), b: Math.min(prof.L, recentEv.km + 8) }; winLabel = "THE ACTION"; }
    else {
      const frontKm = dispFrame.leadKm || 0;
      const climbSeg = stage.segments.find(([sa, sb, sl]) => sl >= 0.04 && frontKm >= sa - 1 && frontKm < sb && (sb - sa) >= 3);
      if (climbSeg) { autoWin = { a: Math.max(0, climbSeg[0] - 2), b: Math.min(prof.L, climbSeg[1] + 3) }; winLabel = "THE CLIMB"; }
    }
  }
  const effWin = zoomMode === "off" ? null : (typeof zoomMode === "object" ? zoomMode : autoWin);
  const effLabel = typeof zoomMode === "object" ? "ZOOM" : (effWin ? winLabel : null);
  const glowFor = (k) => k === "win" ? ACC.gold : k === "catch" ? ACC.green : k === "weather" ? ACC.red : k === "flamme" ? (raceAccent || ACC.red) : ACC.amber;
  const pickZoom = (km) => {
    if (effWin) setZoomMode("off");                          // click while zoomed → back to the full overview
    else setZoomMode({ a: Math.max(0, km - 7), b: Math.min(prof.L, km + 7) });   // click the map → zoom in there
  };
  const addCmd = (c) => { setCommands((cs) => [...cs, { ...c, fromKm: front ? front.posKm : 0 }]); flash("order", cmdLabel(c)); };
  const setPace = (lvl) => { setPaceLevel(lvl); addCmd({ type: "pace", level: lvl }); };
  const takePull = (lid) => { addCmd({ type: "tempo", lids: [lid], level: "hard", toKm: (front ? front.posKm : 0) + 18 }); setSelRider(null); };
  const PACE_LAB = ["Sit up", "Steady", "Tempo", "Hard", "Full gas"];
  const cmdLabel = (c) => {
    const who = c.lid != null ? (state.riders[c.lid]?.short || "Rider") : (c.lids ? (state.riders[c.lids[0]]?.short || "Rider") : "Team");
    if (c.type === "attack") return c._bridge ? `${who}: bridge` : `${who}: ${c.effort >= 1.12 ? "all-in" : c.effort <= 0.9 ? "probe" : "attack"}`;
    if (c.type === "tempo") return `${who}: pull`;
    if (c.type === "moveup") return `${who}: move up`;
    if (c.type === "protect") return `${who}: protect`;
    if (c.type === "ease") return `${who}: conserve`;
    if (c.type === "dropback") return `${who}: drop back`;
    if (c.type === "pace") return `Tempo: ${PACE_LAB[c.level] ?? ""}`;
    if (c.type === "chase") return `Team: ${c.level === "hard" ? "chase" : "sit up"}`;
    return c.type;
  };
  // what's coming up the road
  const climbAhead = stage.segments.filter(([a, , s]) => s >= 0.045 && a > (front ? front.posKm : 0) + 0.3).sort((x, y) => x[0] - y[0])[0];
  const nextFeat = atEnd ? null : climbAhead ? `⛰ climb in ${(climbAhead[0] - front.posKm).toFixed(0)} km` : kmToGo <= 5 ? "🏁 final kilometres" : kmToGo <= 25 ? "🏁 run-in" : null;
  const log = sim.log.filter((e) => e.t <= curT + 0.1);
  const res = sim.results.filter((r) => r.timeSec <= curT + 0.1);
  const allTracked = sim.tracked.map((t, i) => ({ ...t, ...(frame.track && frame.track[i] ? frame.track[i] : { w: frame.w[i] ?? 0, gType: "peloton", gapSec: 0, effort: 0 }) }));
  const myW = allTracked.filter((t) => state.riders[t.lid]?.teamId === state.userTeamId);   // your squad

  // contextual one-tap cue: the timely decision for THIS moment
  const sprinterLid = (baseCommands.find((c) => c.type === "leadout") || {}).sprinterLid;
  const myUp = myW.find((t) => t.gType === "break" || t.gType === "solo");
  const inBunch = (lid) => { const t = myW.find((x) => x.lid === lid); return t && t.gType === "peloton"; };
  let cue = null;
  if (!atEnd && front) {
    if (sprinterLid != null && kmToGo <= 1.6 && inBunch(sprinterLid)) {
      cue = { label: `🚀 Launch ${state.riders[sprinterLid]?.short}`, sub: "Sprint — jump for the line now", col: "#d6311f", act: () => addCmd({ type: "attack", lid: sprinterLid }) };
    } else if (myUp && kmToGo > 3 && kmToGo <= 70) {
      cue = { label: `⚡ ${state.riders[myUp.lid]?.short}: press on`, sub: "Your rider is up the road — drive it", col: "#2f6f9b", act: () => addCmd({ type: "attack", lid: myUp.lid }) };
    } else if (stage.finishType === "summit" && kmToGo > 0.4 && kmToGo <= 6) {
      const climber = myW.filter((t) => t.gType === "peloton" || t.gType === "break").sort((a, b) => b.w - a.w)[0];
      if (climber) cue = { label: `⛰ Attack with ${state.riders[climber.lid]?.short}`, sub: "The climb is biting — go", col: "#7a3ca8", act: () => addCmd({ type: "attack", lid: climber.lid }) };
    } else if (frame.gapSec > 8 && kmToGo > 4 && kmToGo <= 45 && !commands.some((c) => c.type === "chase" && c.level === "hard")) {
      cue = { label: "🚂 Commit the chase", sub: `Break out front at +${fmtGap(frame.gapSec)}`, col: "#9a5b1e", act: () => addCmd({ type: "chase", teamId: uti, level: "hard" }) };
    }
  }

  // ---- live-race cockpit ----
  const teamName = state.teams[state.userTeamId] ? state.teams[state.userTeamId].name : "Your team";
  const stIdx = race.stages.indexOf(stage);
  const terr = stage.mode === "itt" ? "TIME TRIAL" : (stage.finishType === "summit" || stage.finishType === "mountain") ? "HIGH MOUNTAIN" : stage.finishType === "hilly" ? "HILLY / BREAKAWAY" : stage.cobbles >= 0.8 ? "COBBLES" : stage.cobbles ? "GRAVEL" : "FLAT";
  const myLeader = myW.find((t) => t.duty === "leader") || myW.slice().sort((a, b) => (b.w || 0) - (a.w || 0))[0];
  const hasProtect = (lid) => commands.some((c) => c.type === "protect" && c.lid === lid);
  const chaseOn = commands.some((c) => c.type === "chase" && c.level === "hard");
  const ACC = { blue: "var(--blue)", red: "var(--red)", green: "var(--green)", amber: "var(--amber)", purple: "var(--purple)", gold: "var(--gold)", cyan: "var(--cyan)", mut: "var(--mut)" };
  const cbtn = (label, accent, active, onClick, disabled) => (
    <button className="cmdbtn" disabled={disabled} onClick={disabled ? undefined : onClick}
      style={disabled ? { opacity: .4, cursor: "default" } : active ? { background: accent, borderColor: accent, color: "var(--bg)", boxShadow: "0 0 8px " + accent + "55" } : { borderColor: accent, color: accent }}>{label}</button>
  );
  const FEEDC = { attack: ["ATTACK", ACC.amber], tactic: ["TACTICAL", ACC.blue], catch: ["CATCH", ACC.green], drop: ["DROP", ACC.amber], win: ["FINISH", ACC.gold], break: ["MOVE", ACC.cyan], weather: ["WEATHER", ACC.red] };
  const rivals = res.filter((r) => state.riders[r.lid] && state.riders[r.lid].teamId !== state.userTeamId).slice(0, 2);
  const alert = stage.wind ? { c: ACC.amber, l: "Crosswind Alert - High", t: "Exposed sections ahead. Keep your leader in the front 20." }
    : (stage.finishType === "summit" || stage.finishType === "mountain") ? { c: ACC.purple, l: "Summit Finish", t: "The decisive climb is coming. Save the leader's matches." }
    : kmToGo <= 8 ? { c: ACC.blue, l: "Final Kilometres", t: "Positioning is everything now." } : null;
  return (
    <div className="lr">
      <div className="lr-stagehdr">
        <div>STAGE {stIdx + 1} of {race.stages.length}  |  {terr}  |  {prof.L.toFixed(1)} km  |  ELEVATION {Math.round(prof.climb)}m</div>
        <div><div className="fin" style={raceAccent ? { color: raceAccent } : null}>{race.name}</div><div className="finsub">{atEnd ? "FINISH" : kmToGo.toFixed(1) + " KM REMAINING"}</div></div>
      </div>

      <div className={"card profwrap" + (banner ? " moment" : "")} style={{ position: "relative", ...(banner ? { boxShadow: `0 0 0 1px color-mix(in srgb, ${glowFor(banner.kind)} 55%, transparent), 0 0 26px -4px ${glowFor(banner.kind)}` } : {}) }}>
        {banner && (() => { const bc = banner.kind === "order" ? ["ORDER SENT", ACC.blue] : banner.kind === "flamme" ? ["1 KM", raceAccent || ACC.red] : (FEEDC[banner.kind] || ["RACE", ACC.cyan]); return (
          <div className="lr-banner" style={{ borderColor: bc[1] }}>
            <span className="bk" style={{ background: bc[1], color: "var(--bg)" }}>{bc[0]}</span>
            <span className="bt">{banner.text}</span>
            {banner.why && <span className="bw">{Object.entries(banner.why).slice(0, 3).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join(" · ")}</span>}
          </div>); })()}
        {effLabel && <span className="zoomchip" style={{ borderColor: raceAccent || "var(--blue)", color: raceAccent || "var(--blue)" }}>🔍 {effLabel} — click to zoom out</span>}
        {(() => {  // broadcast gap board — the classic TdF overlay: numbered groups on the road, jersey + gap
          const sorted = dispGroups.slice().sort((a, b) => b.posKm - a.posKm);
          const peloAt = sorted.findIndex((g) => g.type === "peloton");
          const segs = sorted.slice(0, 5).map((g, gi) => {
            const behind = peloAt >= 0 && gi > peloAt;
            const nm = g.lead ? g.lead.split(" ").pop().toUpperCase() : null;
            const name = g.type === "peloton" ? "PELOTON"
              : behind ? (g.type === "grupetto" ? "GRUPETTO" : g.n === 1 ? (nm || "DROPPED") : "GR. ARRIÈRE")
              : gi === 0 ? "TÊTE DE LA COURSE"                                  // only the very front is the head of the race
              : g.type === "solo" || g.n === 1 ? (nm || "CONTRE")               // a lone rider chasing between break and bunch
              : "CONTRE-ATTAQUE";                                              // a counter-group on the road
            const col = g.type === "peloton" ? (raceAccent || ACC.blue) : behind ? ACC.mut : g.type === "chase" ? ACC.cyan : ACC.gold;
            return { g, gi, name, col, num: gi + 1, isLead: gi === 0 };
          });
          return (
            <div className="gapbar">
              {segs.map(({ g, gi, name, col, num, isLead }) => (
                <div key={g.gid ?? gi} className={"gapseg" + (isLead ? " lead" : "")} style={{ "--segc": col }}>
                  <div className="gs-top"><span className="gs-num" style={{ background: col }}>{num}</span>{name}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="gs-jersey" style={{ background: g.jersey || col }} />
                    <span className="gs-gap" style={{ color: isLead ? (raceAccent || "var(--ink)") : "var(--ink)" }}>{isLead ? (prof.L - g.posKm).toFixed(1) + " km" : "+" + bcast(g.gapSec || 0)}</span>
                  </div>
                </div>
              ))}
              {sorted.length > 5 && <div className="gapseg" style={{ justifyContent: "center", color: "var(--mut)", fontSize: 10 }}>+{sorted.length - 5}<br />grp</div>}
            </div>
          );
        })()}
        <RaceProfile stage={stage} prof={prof} frame={dispFrame} mine={myW} h={172} window={effWin} accent={raceAccent} onPick={pickZoom} spot={banner && banner.km != null ? { km: banner.km, kind: banner.kind } : null} />
        {myLeader && (() => {
          const ld = myLeader; const done = ld.gType === "fin" || ld.gType === "out";
          const wpct = Math.round((ld.w || 0) * 100), wc = wpct < 18 ? ACC.red : wpct < 40 ? ACC.amber : ACC.green;
          const ahead = (ld.gapSec || 0) <= 3;
          return (
            <div className="leaderhud">
              <span className="lh-tag">YOUR LEADER</span>
              <span className="lh-name">{ld.short}</span>
              <span className="lh-loc">{GSTAT[ld.gType] || "in the bunch"}</span>
              <span className="lh-gap" style={{ color: done ? "var(--mut)" : ahead ? ACC.green : ACC.gold }}>{done ? "FINISHED" : ahead ? "ON THE FRONT" : "−" + bcast(ld.gapSec)}</span>
              <span className="lh-e">MATCHES<b style={{ color: wc }}>{wpct}%</b><span className="lh-bar"><span style={{ width: wpct + "%", background: wc }} /></span></span>
            </div>);
        })()}
        <div className="ctrlbar">
          <button className="btn pri sm" onClick={() => { if (atEnd) seek(0); setPlaying((p) => !p); }}>{playing ? "❚❚" : "▶"}</button>
          <input className="scrub" type="range" min={0} max={sim.frames.length - 1} value={idx} onChange={(e) => { setPlaying(false); seek(+e.target.value); }} />
          <div className="seg">{[1, 3, 6].map((sp) => <button key={sp} className={sp === speed ? "on" : ""} onClick={() => setSpeed(sp)}>{sp}×</button>)}</div>
          <button className="btn sm" title="Automatically slow down when the race ignites" style={autoSlow ? { background: "var(--blue)", color: "#fff", borderColor: "var(--blue)" } : null} onClick={() => setAutoSlow((v) => !v)}>⚡ auto-slow {autoSlow ? "on" : "off"}</button>
          <button className="btn sm" title="Camera follows the action: the climb, the attacks, the finale" style={zoomMode === "auto" ? { background: "var(--blue)", color: "#fff", borderColor: "var(--blue)" } : null} onClick={() => setZoomMode((z) => (z === "auto" ? "off" : "auto"))}>🎥 auto-zoom {zoomMode === "auto" ? "on" : "off"}</button>
          {nextFeat && <span style={{ fontSize: 11.5, fontWeight: 700, color: nextFeat[0] === "⛰" ? "var(--amber)" : "var(--red)" }}>{nextFeat}</span>}
          <span className="mono" style={{ fontSize: 12, minWidth: 88, textAlign: "right" }}>{kmToGo.toFixed(1)} km left</span>
        </div>
        {commands.length > 0 && (
          <div className="ctrlbar" style={{ borderTop: "1px dashed var(--line)", flexWrap: "wrap", gap: 6 }}>
            <span style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".12em", color: "var(--mut)", fontWeight: 700, marginRight: 2 }}>Active orders</span>
            {commands.map((c, ci) => (<span key={ci} className="ordchip" title="remove this order" onClick={() => setCommands((cs) => cs.filter((_, j) => j !== ci))}>{cmdLabel(c)} <b style={{ opacity: .6 }}>×</b></span>))}
            <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => { setCommands([]); setPaceLevel(null); }}>Clear all</button>
          </div>
        )}
      </div>

      <div className="lr-cols">
        <div>
          <div className="lr-coltitle">{teamName}</div>
          {myW.map((t) => {
            const a = ARCHG[t.archetype] || ARCHG.helper;
            const dl = DUTYLAB[t.duty] || DUTYLAB.domestique;
            const done = t.gType === "fin" || t.gType === "out";
            const low = (t.w || 0) < 0.18;
            const open = selRider === t.lid && !atEnd && !done;
            const eCol = (t.w || 0) < 0.18 ? ACC.red : (t.w || 0) < 0.4 ? ACC.amber : ACC.green;
            let pill = "READY", pc = ACC.green;
            if (t.gType === "out") { pill = "DROPPED"; pc = ACC.red; }
            else if (t.gType === "grupetto") { pill = "GRUPETTO"; pc = ACC.mut; }
            else if (t.pulling && (t.gType === "peloton" || t.gType === "break" || t.gType === "solo")) { pill = "PULLING FRONT"; pc = ACC.green; }
            else if (t.gType === "break" || t.gType === "solo") { pill = "ATTACKING"; pc = ACC.amber; }
            else if (low) { pill = "ON LIMIT"; pc = ACC.red; }
            else if (myLeader && t.lid === myLeader.lid) { pill = "GC LEADER"; pc = ACC.blue; }
            else if (hasProtect(t.lid)) { pill = "PROTECTED"; pc = ACC.green; }
            const grp = (GSTAT[t.gType] || "PELOTON") + ((!done && (t.gapSec || 0) > 3) ? "  −" + fmtGap(t.gapSec) : "");
            return (
              <div key={t.id} className={"rcard" + (open ? " sel" : "") + (t.gType === "out" ? " drp" : "")} style={{ marginBottom: 8, opacity: t.gType === "out" ? .72 : 1 }}
                onClick={() => { if (!done && !atEnd) setSelRider(open ? null : t.lid); }}>
                <div className="rtop">
                  <span className="rav"><Face rider={state.riders[t.lid]} size={30} /></span>
                  <div><div className="nm">{t.short}</div><div className="role">{dl[0]} · {a.tag}</div></div>
                  <span className="spill" style={{ background: pc + "22", color: pc }}>{pill}</span>
                </div>
                <div>
                  <div className="erow"><span>MATCHES</span><span style={{ color: eCol, fontWeight: 700 }}>{((t.w || 0) * 100).toFixed(0)}%</span></div>
                  <span className="track" style={{ display: "block", marginTop: 3 }}><span className="fill" style={{ width: ((t.w || 0) * 100).toFixed(0) + "%", background: eCol }} /></span>
                  <div className="erow" style={{ marginTop: 4 }}><span>TANK</span><span style={{ color: "var(--cyan)", fontWeight: 700 }}>{((t.e ?? 1) * 100).toFixed(0)}%</span></div>
                  <span className="track" style={{ display: "block", marginTop: 3 }}><span className="fill" style={{ width: ((t.e ?? 1) * 100).toFixed(0) + "%", background: "var(--cyan)" }} /></span>
                </div>
                <div className="grp" style={t.gType === "out" ? { color: ACC.red } : null}>{grp}</div>
                {open && (
                  <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexWrap: "wrap", gap: 6, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
                    <button className="btn sm" onClick={() => { addCmd({ type: "attack", lid: t.lid, effort: 0.85 }); setSelRider(null); }}>🔍 Probe</button>
                    <button className="btn sm" onClick={() => { addCmd({ type: "attack", lid: t.lid, effort: 1.0 }); setSelRider(null); }}>⚡ Attack</button>
                    <button className="btn sm" onClick={() => { addCmd({ type: "attack", lid: t.lid, effort: 1.18 }); setSelRider(null); }}>💥 All-in</button>
                    <button className="btn sm" onClick={() => { addCmd({ type: "attack", lid: t.lid, _bridge: true }); setSelRider(null); }}>🌉 Bridge</button>
                    <button className="btn sm" onClick={() => takePull(t.lid)}>🔄 Pull</button>
                    <button className="btn sm" onClick={() => { addCmd({ type: "moveup", lid: t.lid }); setSelRider(null); }}>↑ Move up</button>
                    <button className="btn sm" onClick={() => { addCmd({ type: "protect", lid: t.lid }); setSelRider(null); }}>🛡 Protect</button>
                    <button className="btn sm" onClick={() => { addCmd({ type: "ease", lid: t.lid }); setSelRider(null); }}>💧 Conserve</button>
                    <button className="btn sm" onClick={() => { addCmd({ type: "dropback", lid: t.lid }); setSelRider(null); }}>↓ Drop back</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card">
            <div className="ph">The road<span className="mono" style={{ letterSpacing: 0 }}>{dispGroups.length} groups · {front ? front.spd : 0} km/h</span></div>
            <div style={{ padding: "6px 10px 10px" }}>
              {(() => { const sorted = dispGroups.slice().sort((a, b) => b.posKm - a.posKm); const peloAt = sorted.findIndex((g) => g.type === "peloton");
              return sorted.slice(0, 6).map((g, gi) => {
                const behindBunch = peloAt >= 0 && gi > peloAt;
                const label = g.type === "peloton" ? "PELOTON"
                  : behindBunch ? (g.type === "grupetto" ? "GRUPETTO" : g.n === 1 ? (g.lead || "RIDER") + " — DROPPED" : "DROPPED GROUP")
                  : g.type === "solo" ? (g.lead || "ATTACKER") + " — SOLO"
                  : g.type === "chase" ? "CHASERS"
                  : gi === 0 ? "TÊTE DE LA COURSE" : "BREAK GROUP";
                const gcol = g.type === "peloton" ? (raceAccent || ACC.blue) : behindBunch ? ACC.mut : g.type === "chase" ? ACC.cyan : ACC.gold;
                const prevG = g.gid != null ? prevBy.get(g.gid) : null;
                const trend = prevG != null && g.gapSec != null ? g.gapSec - (prevG.gapSec ?? g.gapSec) : 0;
                const mine = (g.tin || []).map((ti) => sim.tracked[ti]).filter((tk) => tk && state.riders[tk.lid]?.teamId === state.userTeamId);
                return (
                  <div key={g.gid ?? gi} className="roadrow">
                    <span className="rr-dot" style={{ background: gcol }} />
                    <span className="rr-label" style={{ color: gcol }}>{label}</span>
                    <span className="rr-n">{g.n} rider{g.n !== 1 ? "s" : ""}{g.type !== "solo" && g.lead ? " · " + g.lead : ""}</span>
                    {mine.length > 0 && <span className="rr-mine">{mine.map((tk) => tk.short.split(" ").pop()).join(", ")}</span>}
                    <span className="rr-gap mono">{gi === 0 ? "—" : "+" + bcast(g.gapSec || 0)}
                      {gi > 0 && Math.abs(trend) > 2 && <b style={{ color: trend < 0 ? ACC.green : ACC.red, marginLeft: 3 }}>{trend < 0 ? "▼" : "▲"}</b>}</span>
                  </div>);
              }); })()}
              {dispGroups.length > 6 && <div style={{ fontSize: 10.5, color: "var(--mut)", paddingTop: 4 }}>+{dispGroups.length - 6} more groups on the road</div>}
              {myLeader && <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--line)", marginTop: 7, paddingTop: 6, fontSize: 12 }}>
                <span style={{ color: "var(--mut)" }}>{myLeader.short}</span>
                <b style={{ color: ACC.gold }}>{(myLeader.gapSec || 0) <= 0 ? "AT THE FRONT" : "−" + fmtGap(myLeader.gapSec) + " · " + (GSTAT[myLeader.gType] || "bunch")}</b>
              </div>}
            </div>
          </div>
          <div className="card">
            <div className="ph">Race events feed</div>
            <div className="news" ref={(el) => { if (el && el._n !== el.childElementCount) { el._n = el.childElementCount; el.scrollTop = el.scrollHeight; } }} style={{ maxHeight: 230 }}>
              {log.length === 0 && <div style={{ padding: 22, textAlign: "center", color: "var(--mut)", fontSize: 13 }}>Racing…</div>}
              {log.slice(-40).map((e, i) => { const fc = FEEDC[e.kind] || ["RADIO", ACC.cyan]; return (
                <div key={i} className="feedrow">
                  <span className="fk">{e.km} KM</span>
                  <span className="ft" style={{ background: fc[1] + "22", color: fc[1] }}>{fc[0]}</span>
                  <span className="fm">{e.text}</span>
                  <span className="fd" style={{ background: fc[1] }} />
                </div>); })}
            </div>
          </div>
          <div className="card">
            <div className="ph">{atEnd ? "Stage result" : "Virtual general classification"}<span className="mono" style={{ letterSpacing: 0 }}>{res.length}/{sim.results.length}</span></div>
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              {res.length === 0 && <div style={{ padding: 22, textAlign: "center", color: "var(--mut)", fontSize: 13 }}>Racing…</div>}
              {res.slice(0, 12).map((r) => { const isMe = state.riders[r.lid] && state.riders[r.lid].teamId === state.userTeamId; const rr = state.riders[r.lid];
                return (
                  <div key={r.id} className={"gcrow" + (isMe ? " me2" : "")} style={{ cursor: "pointer" }} onClick={() => rr && setProfile(rr)}>
                    <span className="gp" style={r.place === 1 ? { color: ACC.gold } : null}>{r.place}</span>
                    <span className="chip" style={{ background: r.jersey }} />
                    <span className="gn">{r.short}{rr && rr.nation ? <span className="gnat">{rr.nation}</span> : null}</span>
                    <span className="gg">{r.place === 1 ? "LEADER" : "+" + fmtGap(r.gapSec)}</span>
                    {isMe && <span className="rt2" style={{ background: ACC.blue + "22", color: ACC.blue }}>YOU</span>}
                  </div>); })}
            </div>
            {atEnd && <div style={{ padding: 12 }}><button className="btn red" style={{ width: "100%" }} onClick={() => onFinish(sim.results.map((r) => ({ lid: r.lid, timeSec: r.timeSec, gapSec: r.gapSec })), sim.log)}>{stage === race.stages[race.stages.length - 1] ? "See the result →" : "Confirm stage →"}</button></div>}
          </div>
        </div>

        <div>
          <div className="lr-coltitle">Tactical Commands</div>
          {cue && (
            <div className="recact" style={{ marginBottom: 12 }}>
              <div className="rl">★ Recommended Action</div>
              <div className="rt">{cue.label.replace(/^[^A-Za-z]+/, "")}</div>
              <div className="rs">{cue.sub}</div>
              <button className="btn sm" style={{ alignSelf: "flex-start", background: "var(--gold)", color: "var(--bg)", borderColor: "var(--gold)", fontWeight: 800 }} onClick={cue.act}>Do it →</button>
            </div>
          )}
          <div className="cmdgrid" style={{ marginBottom: 12 }}>
            {cbtn("Protect Leader", ACC.blue, myLeader && hasProtect(myLeader.lid), () => myLeader && addCmd({ type: "protect", lid: myLeader.lid }), !myLeader || atEnd)}
            {cbtn("Chase Break", ACC.amber, chaseOn, () => addCmd({ type: "chase", teamId: uti, level: chaseOn ? "soft" : "hard" }), atEnd)}
            {cbtn("Attack", ACC.red, false, () => { const c = myW.filter((t) => t.gType === "peloton" || t.gType === "break").sort((a, b) => (b.w || 0) - (a.w || 0))[0]; if (c) addCmd({ type: "attack", lid: c.lid, effort: 1.0 }); }, atEnd)}
            {cbtn("Conserve", ACC.green, paceLevel === 0, () => setPace(0), atEnd)}
            {cbtn("Tempo", ACC.blue, paceLevel === 2, () => setPace(2), atEnd)}
            {cbtn("Lead-out", ACC.mut, false, () => sprinterLid != null && addCmd({ type: "attack", lid: sprinterLid }), sprinterLid == null || atEnd)}
            {cbtn("Fetch Bottles", ACC.blue, false, () => { const d = myW.find((t) => t.duty === "domestique" && t.gType === "peloton"); if (d) addCmd({ type: "ease", lid: d.lid }); }, atEnd)}
            {cbtn("Mark Rival", ACC.purple, paceLevel === 3, () => setPace(3), atEnd)}
          </div>
          {alert && <div className="alertbar" style={{ background: alert.c + "14", border: "1px solid " + alert.c, color: alert.c, marginBottom: 12 }}><div className="al">{alert.l}</div><div style={{ color: "var(--mut)", fontWeight: 500, marginTop: 3 }}>{alert.t}</div></div>}
          {rivals.length > 0 && (<><div className="sech">Rival Watch</div>
            {rivals.map((r, i) => { const rr = state.riders[r.lid]; const danger = i === 0 || (rr && (rr.attacking || 0) > 70); const tg = danger ? ["ATTACK RISK", ACC.red] : ["WATCHING", ACC.gold];
              return (<div key={r.id} className="rivalrow"><span>{r.short}{rr && rr.nation ? " (" + rr.nation + ")" : ""}</span><span className="rt2" style={{ background: tg[1] + "22", color: tg[1] }}>{tg[0]}</span></div>); })}</>)}
          <div className="sech" style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: 4, background: ACC.cyan, display: "inline-block" }} />Race Radio</div>
          <div className="lr-radio">
            {log.slice(-4).reverse().map((e, i) => <div key={i}><span className="rk">{e.km}km:</span> {e.text}</div>)}
            {log.length === 0 && <div style={{ color: "var(--mut)" }}>Awaiting first reports…</div>}
          </div>
        </div>
      </div>

      <div className="lr-bottom">
        <span>FRONT {front ? front.spd : 0} KM/H</span>
        <span>{kmToGo.toFixed(1)} KM TO GO</span>
        <span>ON ROAD: {res[0] ? res[0].short.toUpperCase() : "—"}</span>
        <span style={{ marginLeft: "auto", color: "var(--cyan)" }}>{atEnd ? "STAGE COMPLETE" : "STAGE IN PROGRESS · " + race.name.toUpperCase()}</span>
      </div>

      {!atEnd && onSimInstant && <div style={{ textAlign: "center" }}><button className="btn sm" onClick={onSimInstant}>skip to finish ⏭</button></div>}
      {profile && <RiderModal state={state} rider={profile} onClose={() => setProfile(null)} godMode={false} refresh={() => {}} />}
    </div>
  );
}

// ============================================================================
//  RACE WEEKEND — squad pick, then play stages (watch or sim), then commit
// ============================================================================
// ---------- post-race: a proper, fulfilling result screen ----------
function RaceResultScreen({ state, race, perStage, gc, cb = {}, summary, log, onClose }) {
  const [profile, setProfile] = React.useState(null);
  const isTour = race.stages.length > 1;
  const uti = state.userTeamId;
  const R = (lid) => state.riders[lid];
  let standings;
  if (isTour) {
    const arr = Object.entries(gc).map(([lid, sec]) => ({ lid: +lid, timeSec: sec })).sort((a, b) => a.timeSec - b.timeSec || (cb[a.lid] || 0) - (cb[b.lid] || 0));
    const w = arr.length ? arr[0].timeSec : 0;
    standings = arr.map((x, i) => ({ ...x, place: i + 1, gapSec: Math.round(x.timeSec - w) }));
  } else {
    const arr = (perStage[0]?.results || []).slice().sort((a, b) => a.timeSec - b.timeSec);
    const w = arr.length ? arr[0].timeSec : 0;
    standings = arr.map((x, i) => ({ ...x, place: i + 1, gapSec: Math.round(x.timeSec - w) }));
  }
  const mine = standings.filter((s) => R(s.lid)?.teamId === uti);
  const best = mine[0];
  const podium = standings.slice(0, 3);
  const winner = standings[0];
  const wonByUs = winner && R(winner.lid)?.teamId === uti;
  const stageWins = isTour
    ? perStage.filter((ps) => { const top = ps.results.slice().sort((a, b) => a.timeSec - b.timeSec)[0]; return top && R(top.lid)?.teamId === uti; }).length
    : (wonByUs ? 1 : 0);

  const dayVerdict = !best ? "No finishers." : best.place === 1 ? "🏆 Victory!" : best.place <= 3 ? "🥂 On the podium!" : best.place <= 8 ? "In the mix." : best.place <= 20 ? "A quiet day." : "One to forget.";
  const medal = ["#d8b04a", "#b9bcc2", "#c8894e"];

  // recap narrative from the closing of the race
  const recap = [];
  const wName = winner ? R(winner.lid)?.short : "?";
  const wTeam = winner ? state.teams[R(winner.lid)?.teamId]?.name : "";
  const caught = (log || []).some((e) => e.kind === "catch");
  const lateAtk = (log || []).filter((e) => e.kind === "attack").slice(-1)[0];
  if (isTour) recap.push(`After ${race.stages.length} stages, ${wName} (${wTeam}) takes the overall${standings[1] ? ` by ${fmtGap(standings[1].gapSec)}` : ""}.`);
  else {
    if (caught) recap.push(`The break was reeled in and ${wName} (${wTeam}) took the win${lateAtk ? " after a late move" : ""}.`);
    else recap.push(`${wName} (${wTeam}) held off the chase to win${lateAtk ? " from a late attack" : ""}.`);
  }
  if (best) recap.push(best.place === 1 ? "Your rider stood on the top step." : `Your best was ${R(best.lid)?.short} in ${best.place === 1 ? "1st" : best.place + (best.place === 2 ? "nd" : best.place === 3 ? "rd" : "th")}.`);

  const ord = (p) => { const t = p % 10, h = p % 100; return p + (t === 1 && h !== 11 ? "st" : t === 2 && h !== 12 ? "nd" : t === 3 && h !== 13 ? "rd" : "th"); };

  return (
    <div className="gm-wrap" style={{ paddingTop: 16, maxWidth: 880 }}>
      <div className="card" style={{ marginBottom: 14, overflow: "hidden" }}>
        <div className="ph" style={{ background: wonByUs ? "rgba(240,68,56,.16)" : null, color: wonByUs ? "#f3705f" : null }}>{race.name} · {isTour ? "Final GC" : "Result"}<span className="mono" style={{ letterSpacing: 0 }}>{race.kind === "tour" ? race.stages.length + " stages" : "one-day"}</span></div>
        {/* podium */}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 14, padding: "22px 12px 18px" }}>
          {[1, 0, 2].map((slot) => { const p = podium[slot]; if (!p) return <div key={slot} style={{ width: 120 }} />; const r = R(p.lid); const h = slot === 0 ? 116 : slot === 1 ? 92 : 78; const isMe = r?.teamId === uti;
            return (
              <div key={slot} style={{ width: 130, textAlign: "center" }}>
                <div onClick={() => r && setProfile(r)} style={{ cursor: "pointer" }}><Face rider={r} size={slot === 0 ? 60 : 48} /></div>
                <div style={{ fontWeight: 800, marginTop: 4, fontSize: slot === 0 ? 15 : 13, color: isMe ? "#f3705f" : "var(--ink)" }}>{r?.short}</div>
                <div style={{ fontSize: 10.5, color: "var(--mut)" }}>{state.teams[r?.teamId]?.name}</div>
                <div style={{ fontSize: 11, color: "var(--mut)" }} className="mono">{p.place === 1 ? fmtTime(p.timeSec) : "+" + fmtGap(p.gapSec)}</div>
                <div style={{ height: h, marginTop: 8, borderRadius: "6px 6px 0 0", background: `linear-gradient(${medal[slot]}, ${medal[slot]}cc)`, display: "flex", alignItems: "flex-start", justifyContent: "center", color: "#3a3320", fontWeight: 900, fontSize: 26, paddingTop: 6, border: "1px solid rgba(0,0,0,.12)" }}>{p.place}</div>
              </div>
            ); })}
        </div>
      </div>

      {isTour && (() => {
        const rec = state.results[race.id]; if (!rec || !rec.jerseys) return null;
        const J = [
          { label: "General",   col: "#f1d23a", ink: "#3a3320", lid: rec.jerseys.gc,     sub: "overall" },
          { label: "Points",    col: "#2fbf71", ink: "#06371f", lid: rec.jerseys.points, sub: rec.points?.[0] ? rec.points[0].pts + " pts" : "" },
          { label: "Mountains", col: "#d7263d", ink: "#ffffff", lid: rec.jerseys.kom,    sub: rec.kom?.[0] ? rec.kom[0].pts + " pts" : "" },
          { label: "Youth",     col: "#eef1f6", ink: "#2a2f3a", lid: rec.jerseys.youth,  sub: "best U25" },
        ];
        return (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="ph">Jerseys{race.grand ? <span className="mono" style={{ letterSpacing: 0 }}>Grand Tour</span> : null}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 1, background: "var(--line)" }}>
              {J.map((j, k) => { const r = j.lid != null && R(j.lid); const isMe = r && r.teamId === uti;
                return (
                  <div key={k} style={{ background: "var(--card)", padding: "13px 10px 14px", textAlign: "center", cursor: r ? "pointer" : "default" }} onClick={() => r && setProfile(r)}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: j.col, color: j.ink, fontWeight: 900, fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px", border: "1px solid rgba(0,0,0,.2)", letterSpacing: ".04em" }}>{j.label.slice(0, 3).toUpperCase()}</div>
                    <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)" }}>{j.label}</div>
                    <div style={{ fontWeight: 800, fontSize: 13.5, marginTop: 2, color: isMe ? "#f3705f" : "var(--ink)" }}>{r ? r.short : "—"}</div>
                    <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 1 }}>{r ? r.archetype : ""}{j.sub ? ` · ${j.sub}` : ""}</div>
                  </div>
                ); })}
            </div>
          </div>
        );
      })()}

      <div className="row cols-2">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* your day */}
          <div className="card">
            <div className="ph">Your day</div>
            <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 16 }}>
              {best ? <>
                <div style={{ textAlign: "center" }}>
                  <div className="mono" style={{ fontSize: 40, fontWeight: 800, lineHeight: 1, color: best.place <= 3 ? "#f3705f" : "var(--ink)" }}>{best.place}</div>
                  <div style={{ fontSize: 10, color: "var(--mut)", textTransform: "uppercase", letterSpacing: ".1em" }}>{isTour ? "GC" : "stage"}</div>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: 15 }}>{dayVerdict}</div>
                  <div style={{ fontSize: 12.5, color: "var(--mut)", cursor: "pointer" }} onClick={() => setProfile(R(best.lid))}>{R(best.lid)?.short} — {ord(best.place)}{best.place > 1 ? `, +${fmtGap(best.gapSec)}` : ""}</div>
                </div>
              </> : <div style={{ color: "var(--mut)" }}>No finishers.</div>}
            </div>
            <div className="statsrow" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
              <div className="stat"><div className="v mono">{summary ? summary.pts : 0}</div><div className="l">points won</div></div>
              <div className="stat"><div className="v mono">{summary ? money(summary.prize) : "—"}</div><div className="l">prize money</div></div>
              <div className="stat"><div className="v mono">{stageWins}</div><div className="l">{isTour ? "stage wins" : "win"}</div></div>
            </div>
          </div>
          {/* recap */}
          <div className="card">
            <div className="ph">Race report</div>
            <div style={{ padding: "12px 16px", fontSize: 13, lineHeight: 1.5 }}>{recap.join(" ")}</div>
            {isTour && (
              <div style={{ padding: "0 16px 12px" }}>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", marginBottom: 4 }}>Stage winners</div>
                {perStage.map((ps, i) => { const top = ps.results.slice().sort((a, b) => a.timeSec - b.timeSec)[0]; const r = top && R(top.lid); const isMe = r?.teamId === uti; return <div key={i} style={{ fontSize: 12, display: "flex", justifyContent: "space-between", padding: "2px 0", color: isMe ? "#f3705f" : "var(--ink)", fontWeight: isMe ? 700 : 400 }}><span>St.{i + 1} · {ps.finishType.replace("_", " ")}</span><span>{r?.short || "?"}</span></div>; })}
              </div>
            )}
          </div>
          <button className="btn red" onClick={onClose}>Back to the season →</button>
        </div>

        {/* full standings */}
        <div className="card" style={{ alignSelf: "start" }}>
          <div className="ph">{isTour ? "General classification" : "Full result"}<span className="mono" style={{ letterSpacing: 0 }}>{standings.length}</span></div>
          <div style={{ maxHeight: 460, overflowY: "auto" }}>
            <table className="tbl"><tbody>
              {standings.slice(0, 25).map((s) => { const r = R(s.lid); const isMe = r?.teamId === uti; const a = ARCHG[r?.archetype] || ARCHG.helper;
                return <tr key={s.lid} className={s.place === 1 ? "win" : isMe ? "me" : ""}>
                  <td className="mono" style={{ color: "var(--mut)", width: 26, textAlign: "right" }}>{s.place}</td>
                  <td style={{ cursor: "pointer", fontWeight: isMe ? 700 : 400 }} onClick={() => r && setProfile(r)}><span className="chip" style={{ background: r?.jersey, marginRight: 6 }} />{r?.short}</td>
                  <td style={{ color: "var(--mut)", fontSize: 11 }}>{state.teams[r?.teamId]?.name}</td>
                  <td className="num mono" style={{ color: "var(--mut)" }}>{s.place === 1 ? fmtTime(s.timeSec) : "+" + fmtGap(s.gapSec)}</td>
                </tr>; })}
            </tbody></table>
          </div>
          {mine.length > 0 && (
            <div style={{ padding: "8px 12px", borderTop: "1px solid var(--line)", fontSize: 11.5, color: "var(--mut)" }}>
              Your squad: {mine.map((s) => `${R(s.lid)?.short} (${s.place})`).join(" · ")}
            </div>
          )}
        </div>
      </div>
      {profile && <RiderModal state={state} rider={profile} onClose={() => setProfile(null)} godMode={false} refresh={() => {}} />}
    </div>
  );
}

function RaceWeekend({ state, onDone }) {
  const race = state.calendar[state.calIndex];
  const dt = dominantType(race);
  const roster = state.teams[state.userTeamId].riderIds.map((id) => state.riders[id]).filter((r) => r && !(r.out > 0));
  const sidelined = state.teams[state.userTeamId].riderIds.map((id) => state.riders[id]).filter((r) => r && r.out > 0);
  const fullSize = race.kind === "tour" ? 8 : 7;
  const availableN = roster.filter((r) => !riderRaceBlock(state, r, race)).length;
  const size = Math.max(4, Math.min(fullSize, availableN));   // short-handed start beats a soft-locked Start button
  const best = [...roster].filter((r) => !riderRaceBlock(state, r, race)).sort((a, b) => fitFor(b, dt) - fitFor(a, dt)).slice(0, size);
  const [sel, setSel] = React.useState(() => new Set(best.map((r) => r.id)));
  const [duties, setDuties] = React.useState(() => (best[0] ? { [best[0].id]: "leader" } : {}));
  const dutyOf = (id) => duties[id] || "domestique";
  const setDuty = (id, v) => setDuties((d) => { const nd = { ...d, [id]: v }; if (v === "leader") for (const k in nd) if (+k !== +id && nd[k] === "leader") nd[k] = "coleader"; return nd; });
  const [phase, setPhase] = React.useState("pick");      // pick -> race -> done
  const [stageIdx, setStageIdx] = React.useState(0);
  const [perStage, setPerStage] = React.useState([]);
  const [entries, setEntries] = React.useState(null);
  const [mode, setMode] = React.useState(null);          // 'watch' | null
  const gc = React.useRef({});
  const gcCb = React.useRef({});
  const summaryRef = React.useRef(null);
  const lastLogRef = React.useRef([]);

  // ---- per-stage tactical plans (each stage gets its own plan; compiled to commands per stage) ----
  const stagesArr = race.stages;
  const sprinterGuess = [...best].sort((a, b) => b.sprint - a.sprint)[0];
  const defaultPlan = (st) => {
    const ft = st.finishType, spr = ft === "flat" || ft === "hilly";
    return {
      plan: ft === "flat" ? "control" : (ft === "summit" || ft === "uphill_short") ? "gc" : (race.kind === "tour" ? "gc" : "auto"),
      sprinterLid: spr && sprinterGuess ? sprinterGuess.id : null,
      train: best.filter((r) => r.id !== sprinterGuess?.id).sort((a, b) => b.cp - a.cp).slice(0, 3).map((r) => r.id),
      hitFromEnd: 4, launchFromEnd: 0.3, sats: [], markers: [], protect: [], tempos: [],
    };
  };
  const [planIdx, setPlanIdx] = React.useState(0);
  const [plans, setPlans] = React.useState(() => stagesArr.map(defaultPlan));
  const [markType, setMarkType] = React.useState("attack");
  const cur = plans[planIdx];
  const setCur = (patch) => setPlans((ps) => ps.map((p, i) => (i === planIdx ? { ...p, ...(typeof patch === "function" ? patch(p) : patch) } : p)));
  const toggleTrain = (id) => setCur((p) => ({ train: p.train.includes(id) ? p.train.filter((x) => x !== id) : [...p.train, id] }));
  const toggleSat = (id) => setCur((p) => ({ sats: p.sats.some((x) => x.lid === id) ? p.sats.filter((x) => x.lid !== id) : [...p.sats, { lid: id, dropAt: Math.round(stagesArr[planIdx].lengthKm * 0.72), work: "sit_on" }] }));
  const setSat = (id, patch) => setCur((p) => ({ sats: p.sats.map((x) => (x.lid === id ? { ...x, ...patch } : x)) }));
  const toggleProtect = (id) => setCur((p) => ({ protect: p.protect.includes(id) ? p.protect.filter((x) => x !== id) : [...p.protect, id] }));
  const addTempo = () => setCur((p) => ({ tempos: [...p.tempos, { id: Date.now() + Math.random(), fromKm: Math.round(stagesArr[planIdx].lengthKm * 0.45), toKm: Math.round(stagesArr[planIdx].lengthKm * 0.65), lids: [], level: "hard" }] }));
  const setTempo = (tid, patch) => setCur((p) => ({ tempos: p.tempos.map((t) => (t.id === tid ? { ...t, ...patch } : t)) }));
  const delTempo = (tid) => setCur((p) => ({ tempos: p.tempos.filter((t) => t.id !== tid) }));
  const toggleTempoRider = (tid, id) => setCur((p) => ({ tempos: p.tempos.map((t) => t.id === tid ? { ...t, lids: t.lids.includes(id) ? t.lids.filter((x) => x !== id) : [...t.lids, id] } : t) }));
  const tacticRef = React.useRef(null);
  const intelRef = React.useRef(null);   // outlook/rivals are static per race — cache so re-renders don't rescan the peloton (or burn RNG)
  const buildTacticFor = (i, lead, d) => {
    const p = plans[i];
    return {
      intent: p.plan === "gc" ? "gc" : p.plan === "breakaway" ? "break" : p.plan === "control" ? "points" : "stage",
      leaderLid: lead, roles: d,
      team: { gapPolicy: p.plan === "control" ? "chase" : p.plan === "breakaway" ? "let_go" : "control" },
      sprint: (p.sprinterLid != null && sel.has(p.sprinterLid)) ? { sprinterLid: p.sprinterLid, train: p.train.filter((x) => sel.has(x)), hitFromEnd: p.hitFromEnd, launchFromEnd: p.launchFromEnd } : null,
      satellites: p.sats.filter((s) => sel.has(s.lid)),
      markers: p.markers.filter((m) => m.who === "team" || sel.has(m.who)),
      protect: p.protect.filter((l) => sel.has(l)),
      tempos: p.tempos.map((t) => ({ ...t, lids: t.lids.filter((l) => sel.has(l)) })).filter((t) => t.lids.length),
    };
  };

  const toggle = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else if (n.size < size && !riderRaceBlock(state, state.riders[id], race)) n.add(id); return n; });

  const applyRecommend = () => {
    const rec = recommendTactics(state, race);
    if (!rec.riderIds.length) return;
    setSel(new Set(rec.riderIds));
    setDuties(rec.duties);
    setPlans(rec.stagePlans);
    setPlanIdx(0);
  };

  const start = () => {
    const ids = [...sel];
    const d = {}; ids.forEach((id) => (d[id] = dutyOf(id)));
    let lead = ids.find((id) => d[id] === "leader"); if (lead == null) { lead = ids[0]; d[lead] = "leader"; }
    const racePlan = plans.some((p) => p.plan === "gc") ? "gc" : plans[0].plan;
    const ue = { riderIds: ids, leaderId: lead, plan: racePlan, duties: d };
    tacticRef.current = stagesArr.map((_, i) => buildTacticFor(i, lead, d));
    setEntries(buildEntries(state, race, ue)); setPhase("race"); setStageIdx(0); gc.current = {}; gcCb.current = {};
  };
  const stage = race.stages[stageIdx];

  const accumulate = (results, log) => {
    results.forEach((r, i) => { gc.current[r.lid] = (gc.current[r.lid] || 0) + r.timeSec; gcCb.current[r.lid] = (gcCb.current[r.lid] || 0) + (i + 1); });
    if (log) lastLogRef.current = log;
    const ps = [...perStage, { stageName: stage.name, finishType: stage.finishType, results }];
    setPerStage(ps);
    if (stageIdx + 1 < race.stages.length) { setStageIdx(stageIdx + 1); setMode(null); }
    else {
      const uti = state.userTeamId;
      const beforePrize = state.teams[uti].prizeYTD || 0, beforePts = state.rankings.team[uti] || 0;
      commitRaceResult(state, race, ps);
      summaryRef.current = { prize: Math.round(((state.teams[uti].prizeYTD || 0) - beforePrize) * 100) / 100, pts: Math.round((state.rankings.team[uti] || 0) - beforePts) };
      setPhase("done");
    }
  };
  const simStage = () => {
    const baseCmds = tacticRef.current ? compileTactic(state, race, stage, tacticRef.current[stageIdx], state.userTeamId) : [];
    const { out } = runStage(state, race, stage, entries, stageIdx + 1, baseCmds, false);
    accumulate(out.results.map((r) => ({ lid: r.lid, timeSec: r.timeSec, gapSec: r.gapSec })), out.log);
  };

  if (phase === "pick") {
    const prof = elevationProfile(stagesArr[planIdx]);
    const squad = [...sel].map((id) => state.riders[id]).filter(Boolean);
    const leadGuess = [...sel].find((id) => dutyOf(id) === "leader") ?? [...sel][0];
    const sprinterOpts = squad.slice().sort((a, b) => b.sprint - a.sprint);
    // race intel + live setup warnings
    if (!intelRef.current || intelRef.current.raceId !== race.id) {
      intelRef.current = { raceId: race.id, outlook: teamOutlook(state, race),
        rivals: raceFavorites(state, race, 8).favorites.filter((f) => state.riders[f.lid]?.teamId !== state.userTeamId).slice(0, 4) };
    }
    const { outlook, rivals } = intelRef.current;
    const warnings = tacticWarnings(state, race, { riderIds: [...sel], leaderId: leadGuess, stagePlans: plans });
    const T = outlook.profile.terrain;
    const COLT = { climb: "var(--green)", punch: "var(--hot)", sprint: "var(--cyan)", flat: "var(--blue)", cobbles: "var(--amber)", gravel: "var(--amber)", tt: "var(--purple)", descent: "var(--mut)" };
    const chanceCol = { Contender: "var(--green)", "Outside shot": "var(--amber)", "Long shot": "var(--hot)", "Making up numbers": "var(--mut)" }[outlook.chance] || "var(--mut)";
    const Bar = ({ k, label }) => <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}><span style={{ width: 46, fontSize: 10, color: "var(--mut)", textAlign: "right" }}>{label}</span><div style={{ flex: 1, height: 6, background: "var(--line)", borderRadius: 4, overflow: "hidden" }}><div style={{ width: (T[k] || 0) + "%", height: "100%", background: COLT[k] }} /></div><span className="mono" style={{ width: 18, fontSize: 9.5 }}>{T[k] || 0}</span></div>;
    const recommendThisStage = () => {
      const sp = recommendStagePlan(state, race, planIdx, { riderIds: [...sel], leaderId: leadGuess });
      if (sp) setCur({ plan: sp.plan, sprinterLid: sp.sprinterLid, train: sp.train, protect: sp.protect, hitFromEnd: sp.hitFromEnd, launchFromEnd: sp.launchFromEnd });
    };
    const ftAbbr = (ft) => ft === "flat" ? "flat" : ft === "hilly" ? "hill" : ft === "uphill_short" ? "punch" : ft === "summit" ? "mtn" : ft === "rolling" ? "roll" : ft;
    const placeMarker = (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const km = Math.max(0, Math.min(prof.L, Math.round(x * prof.L)));
      setCur((p) => ({ markers: [...p.markers, { id: Date.now() + Math.random(), km, type: markType, who: leadGuess ?? "team" }] }));
    };
    return (
      <div className="gm-wrap" style={{ paddingTop: 16 }}>
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="ph">Tactics · {race.kind === "tour" ? race.stages.length + " stages" : "one-day"}<span>{race.name}</span></div>
          {race.kind === "tour" && (
            <div style={{ padding: "8px 12px 0", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", fontWeight: 700 }}>Plan stage:</span>
              {stagesArr.map((st, i) => <button key={i} className={"btn sm" + (planIdx === i ? " pri" : "")} onClick={() => setPlanIdx(i)}>St.{i + 1} <span style={{ opacity: .7 }}>{ftAbbr(st.finishType)}</span></button>)}
            </div>
          )}
          <div style={{ padding: "8px 12px 0", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".12em", color: "var(--mut)", fontWeight: 700 }}>Tap the profile to mark a move:</span>
            <div className="seg">{[["attack", "⚡ Attack"], ["bridge", "🌉 Bridge"]].map(([k, l]) => <button key={k} className={markType === k ? "on" : ""} onClick={() => setMarkType(k)}>{l}</button>)}</div>
            {cur.markers.length > 0 && <button className="btn sm" onClick={() => setCur({ markers: [] })}>clear marks</button>}
          </div>
          <div className="profwrap" style={{ position: "relative", cursor: "crosshair" }} onClick={placeMarker}>
            <RaceProfile stage={stagesArr[planIdx]} prof={prof} frame={null} h={150} />
            {cur.tempos.map((tz) => (
              <div key={tz.id} style={{ position: "absolute", top: 6, bottom: 22, left: (tz.fromKm / prof.L * 100) + "%", width: ((tz.toKm - tz.fromKm) / prof.L * 100) + "%", background: "color-mix(in srgb, var(--green) 16%, transparent)", borderLeft: "2px solid var(--green)", borderRight: "2px solid var(--green)", pointerEvents: "none" }} />
            ))}
            {cur.markers.map((m) => (
              <div key={m.id} style={{ position: "absolute", top: 6, bottom: 22, left: (m.km / prof.L * 100) + "%", borderLeft: `2px solid ${m.type === "attack" ? "var(--red)" : "var(--blue)"}`, pointerEvents: "none" }}>
                <span style={{ position: "absolute", top: -2, left: 2, fontSize: 9, fontWeight: 800, whiteSpace: "nowrap", background: m.type === "attack" ? "var(--red)" : "var(--blue)", color: "#fff", padding: "1px 4px", borderRadius: 3 }}>{m.type === "attack" ? "⚡" : "🌉"} {Math.round(m.km)}km</span>
              </div>
            ))}
          </div>
          <div className="statsrow"><div className="stat"><div className="v">{stagesArr[planIdx].finishType.replace("_", " ")}</div><div className="l">{race.kind === "tour" ? `stage ${planIdx + 1} finish` : "finish"}</div></div><div className="stat"><div className="v mono">{stagesArr[planIdx].lengthKm}km</div><div className="l">distance</div></div><div className="stat"><div className="v mono">{prof.climb}m</div><div className="l">climbing</div></div><div className="stat"><div className="v mono">{race.prestige}</div><div className="l">prestige</div></div></div>
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="ph">Race outlook<button className="btn sm pri" onClick={applyRecommend}>⚡ Recommend tactics</button></div>
          <div style={{ padding: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 16 }}>
            <div>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".11em", color: "var(--mut)", fontWeight: 800 }}>Your chance</div>
              <div style={{ fontFamily: "var(--fTitle)", fontSize: 22, fontWeight: 700, color: chanceCol, lineHeight: 1.15 }}>{outlook.chance}</div>
              {outlook.leader && <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 2 }}>best fit <b style={{ color: "var(--ink)" }}>{state.riders[outlook.leader.lid]?.short}</b> · fit {outlook.leader.fit} · form {outlook.leader.form}</div>}
              {outlook.risks.length > 0 && <div style={{ marginTop: 6, fontSize: 11, color: "var(--amber)" }}>{outlook.risks.map((r, i) => <div key={i}>⚠ {r}</div>)}</div>}
            </div>
            <div>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".11em", color: "var(--mut)", fontWeight: 800, marginBottom: 6 }}>Terrain demands</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1px 14px" }}>
                {[["climb", "Climb"], ["punch", "Punch"], ["sprint", "Sprint"], ["tt", "TT"], ["cobbles", "Cobbles"], ["flat", "Flat"]].map(([k, l]) => <Bar key={k} k={k} label={l} />)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".11em", color: "var(--mut)", fontWeight: 800, marginBottom: 6 }}>Danger men</div>
              {rivals.length === 0 ? <div style={{ fontSize: 12, color: "var(--mut)" }}>—</div> : rivals.map((f) => <div key={f.lid} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 3 }}><span className="chip" style={{ background: f.jersey }} /><b style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</b><span className="mono" style={{ fontSize: 10.5, color: "var(--mut)" }}>{f.fogged ? "?" : f.fit}</span></div>)}
            </div>
          </div>
        </div>

        <div className="row cols-2">
          <div className="card" style={{ alignSelf: "start" }}>
            <div className="ph">Pick your {size} &amp; assign roles<span className="mono" style={{ letterSpacing: 0, color: sel.size === size ? "var(--green)" : "var(--red)" }}>{sel.size}/{size}</span></div>
            {sidelined.length > 0 && <div style={{ padding: "7px 12px", fontSize: 11.5, color: "var(--hot)", borderBottom: "1px solid var(--line)" }}>Unavailable: {sidelined.map((r) => `${r.short} (${r.suspended ? "susp" : "out"} ${r.out})`).join(" · ")}</div>}
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              <table className="tbl"><tbody>
                {[...roster].sort((a, b) => fitFor(b, dt) - fitFor(a, dt)).map((r) => { const block = riderRaceBlock(state, r, race);
                  return (
                  <tr key={r.id} className={sel.has(r.id) ? "me" : ""} style={block && !sel.has(r.id) ? { opacity: 0.55 } : null}>
                    <td style={{ width: 30 }}><input type="checkbox" checked={sel.has(r.id)} disabled={!!block && !sel.has(r.id)} title={block || ""} onChange={() => toggle(r.id)} /></td>
                    <td><Face rider={r} size={26} /></td>
                    <td>{r.short}{block ? <div style={{ fontSize: 9.5, color: "var(--hot)", fontWeight: 700 }}>{block}</div> : null}</td><td><Tag a={r.archetype} /></td>
                    <td className="num"><Ovr o={r.overall} /></td>
                    <td><FatBar f={r.fatigue || 0} w={38} /></td>
                    <td>{sel.has(r.id) ? (
                      <select value={dutyOf(r.id)} onChange={(e) => setDuty(r.id, e.target.value)} style={{ fontSize: 11, padding: "2px 4px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--paper)", color: dutyOf(r.id) === "leader" ? "var(--red)" : "var(--ink)", fontWeight: dutyOf(r.id) === "leader" ? 700 : 400 }}>
                        <option value="leader">Leader</option><option value="coleader">Co-leader</option><option value="sprinter">Sprinter</option><option value="leadout">Lead-out</option><option value="attacker">Attacker</option><option value="captain">Road Captain</option><option value="domestique">Domestique</option>
                      </select>
                    ) : <span style={{ color: "var(--mut)", fontSize: 11 }}>—</span>}</td>
                  </tr>); })}
              </tbody></table>
            </div>
            <div style={{ padding: "6px 12px 12px", fontSize: 11, color: "var(--mut)" }}>Squad &amp; roles apply to the whole race. Everything in the right column is per-stage{race.kind === "tour" ? ` (now editing Stage ${planIdx + 1})` : ""}.</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="card">
              <div className="ph">Stage plan{race.kind === "tour" ? ` · St.${planIdx + 1}` : ""}<button className="btn sm" onClick={recommendThisStage} title="Suggest a plan for this stage from your current squad">↻ Suggest</button></div>
              <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {[["control", "Control for the sprint", "Chase the break, deliver your finisher."],
                  ["gc", "Protect the leader", "Shelter the leader, ride for GC / the finale."],
                  ["breakaway", "Get in the break", "Send riders up the road early."],
                  ["auto", "Race instinct", "Let your riders read the race."]].map(([k, t, d]) => (
                  <label key={k} className="teamopt" style={{ borderColor: cur.plan === k ? "var(--blue)" : "var(--line)", boxShadow: cur.plan === k ? "0 0 0 1.5px var(--blue)" : "none", cursor: "pointer" }}>
                    <input type="radio" name={"plan" + planIdx} checked={cur.plan === k} onChange={() => setCur({ plan: k })} />
                    <div><div style={{ fontWeight: 700 }}>{t}</div><div style={{ fontSize: 11, color: "var(--mut)" }}>{d}</div></div>
                  </label>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="ph">🛡 Protect <span className="mono" style={{ letterSpacing: 0 }}>shelter &amp; keep fresh</span></div>
              <div style={{ padding: "10px 12px", display: "flex", flexWrap: "wrap", gap: 6 }}>
                {squad.map((r) => { const isLeader = dutyOf(r.id) === "leader"; const on = isLeader || cur.protect.includes(r.id);
                  return <button key={r.id} className={"btn sm" + (on ? " pri" : "")} disabled={isLeader} title={isLeader ? "the leader is always protected" : ""} onClick={() => toggleProtect(r.id)}>{on ? "🛡 " : ""}{r.short}</button>; })}
              </div>
              <div style={{ padding: "0 12px 10px", fontSize: 11, color: "var(--mut)" }}>Protected riders sit in and draft — they won't pull. The leader is always protected.</div>
            </div>

            <div className="card">
              <div className="ph">Sprint train{cur.sprinterLid != null && <button className="btn sm" onClick={() => setCur({ sprinterLid: null })}>disable</button>}</div>
              <div style={{ padding: 12, fontSize: 12.5 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>Sprinter
                  <select value={cur.sprinterLid ?? ""} onChange={(e) => setCur({ sprinterLid: e.target.value === "" ? null : +e.target.value })} style={{ flex: 1, padding: "4px 6px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--paper)" }}>
                    <option value="">— none —</option>
                    {sprinterOpts.map((r) => <option key={r.id} value={r.id}>{r.short} (spd {r.sprint})</option>)}
                  </select>
                </label>
                {cur.sprinterLid != null && <>
                  <div style={{ color: "var(--mut)", marginBottom: 5 }}>Lead-out order (tap to add; last = final lead-out man):</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                    {squad.filter((r) => r.id !== cur.sprinterLid).map((r) => { const pos = cur.train.indexOf(r.id); return (
                      <button key={r.id} className={"btn sm" + (pos >= 0 ? " pri" : "")} onClick={() => toggleTrain(r.id)}>{pos >= 0 ? `${pos + 1}. ` : ""}{r.short}{pos === cur.train.length - 1 && pos >= 0 ? " ⏍" : ""}</button>
                    ); })}
                  </div>
                  <div style={{ marginBottom: 8 }}><div style={{ display: "flex", justifyContent: "space-between" }}><span>Train hits the front</span><b className="mono">{cur.hitFromEnd} km out</b></div>
                    <input type="range" min={1} max={12} step={0.5} value={cur.hitFromEnd} onChange={(e) => setCur({ hitFromEnd: +e.target.value })} style={{ width: "100%" }} /></div>
                  <div><div style={{ display: "flex", justifyContent: "space-between" }}><span>Sprinter launches</span><b className="mono">{Math.round(cur.launchFromEnd * 1000)} m out</b></div>
                    <input type="range" min={0.1} max={2} step={0.05} value={cur.launchFromEnd} onChange={(e) => setCur({ launchFromEnd: +e.target.value })} style={{ width: "100%" }} />
                    <div style={{ fontSize: 10.5, color: "var(--mut)" }}>Launching too early fades into the line.</div></div>
                </>}
              </div>
            </div>

            <div className="card">
              <div className="ph">⏱ Tempo sections <button className="btn sm" onClick={addTempo}>+ add</button></div>
              <div style={{ padding: 12, fontSize: 12.5 }}>
                {cur.tempos.length === 0 && <div style={{ color: "var(--mut)" }}>Have chosen riders drive the pace over a stretch of road — burns rivals and shelters your leader. Tap “+ add”.</div>}
                {cur.tempos.map((tz) => (
                  <div key={tz.id} style={{ borderBottom: "1px solid var(--line)", padding: "8px 0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <b className="mono" style={{ color: "var(--green)" }}>km {tz.fromKm}–{tz.toKm}</b>
                      <span style={{ display: "flex", gap: 6, alignItems: "center" }}><div className="seg">{[["hard", "hard"], ["steady", "steady"]].map(([k, l]) => <button key={k} className={tz.level === k ? "on" : ""} onClick={() => setTempo(tz.id, { level: k })}>{l}</button>)}</div><button className="btn sm" onClick={() => delTempo(tz.id)}>×</button></span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--mut)" }}>start km {tz.fromKm}</div>
                    <input type="range" min={0} max={prof.L} step={1} value={tz.fromKm} onChange={(e) => setTempo(tz.id, { fromKm: Math.min(+e.target.value, tz.toKm - 1) })} style={{ width: "100%" }} />
                    <div style={{ fontSize: 11, color: "var(--mut)" }}>end km {tz.toKm}</div>
                    <input type="range" min={0} max={prof.L} step={1} value={tz.toKm} onChange={(e) => setTempo(tz.id, { toKm: Math.max(+e.target.value, tz.fromKm + 1) })} style={{ width: "100%" }} />
                    <div style={{ fontSize: 11, color: "var(--mut)", margin: "4px 0 2px" }}>who drives the pace:</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {squad.filter((r) => dutyOf(r.id) !== "leader").map((r) => { const on = tz.lids.includes(r.id); return <button key={r.id} className={"btn sm" + (on ? " pri" : "")} onClick={() => toggleTempoRider(tz.id, r.id)}>{r.short}</button>; })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="ph">Satellites <span className="mono" style={{ letterSpacing: 0 }}>up the road for the leader</span></div>
              <div style={{ padding: 12, fontSize: 12.5 }}>
                {squad.filter((r) => dutyOf(r.id) !== "leader" && r.id !== cur.sprinterLid).length === 0 && <div style={{ color: "var(--mut)" }}>Pick non-leader riders to send up the road.</div>}
                {squad.filter((r) => dutyOf(r.id) !== "leader" && r.id !== cur.sprinterLid).map((r) => { const s = cur.sats.find((x) => x.lid === r.id); return (
                  <div key={r.id} style={{ borderBottom: "1px solid var(--line)", padding: "6px 0" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="checkbox" checked={!!s} onChange={() => toggleSat(r.id)} /> <b>{r.short}</b> <Tag a={r.archetype} />
                    </label>
                    {s && <div style={{ margin: "6px 0 2px 24px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}><span>drop back at</span><b className="mono">{s.dropAt} km</b></div>
                      <input type="range" min={10} max={prof.L} step={1} value={s.dropAt} onChange={(e) => setSat(r.id, { dropAt: +e.target.value })} style={{ width: "100%" }} />
                      <div className="seg" style={{ marginTop: 4 }}>{[["sit_on", "sit on (save)"], ["build", "work the break"]].map(([k, l]) => <button key={k} className={s.work === k ? "on" : ""} onClick={() => setSat(r.id, { work: k })}>{l}</button>)}</div>
                    </div>}
                  </div>
                ); })}
              </div>
            </div>

            {cur.markers.length > 0 && (
              <div className="card">
                <div className="ph">Marked moves{race.kind === "tour" ? ` · St.${planIdx + 1}` : ""}</div>
                <div style={{ padding: 10 }}>
                  {cur.markers.slice().sort((a, b) => a.km - b.km).map((m) => (
                    <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12.5 }}>
                      <span className="mono" style={{ width: 52 }}>{Math.round(m.km)}km</span>
                      <span style={{ color: m.type === "attack" ? "var(--red)" : "var(--blue)", fontWeight: 700 }}>{m.type}</span>
                      <select value={m.who} onChange={(e) => setCur((p) => ({ markers: p.markers.map((x) => x.id === m.id ? { ...x, who: e.target.value === "team" ? "team" : +e.target.value } : x) }))} style={{ flex: 1, padding: "2px 4px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--paper)", fontSize: 11 }}>
                        <option value="team">whole team</option>
                        {squad.map((r) => <option key={r.id} value={r.id}>{r.short}</option>)}
                      </select>
                      <button className="btn sm" onClick={() => setCur((p) => ({ markers: p.markers.filter((x) => x.id !== m.id) }))}>×</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {warnings.length > 0 && (
              <div className="card" style={{ padding: "9px 12px", display: "flex", flexDirection: "column", gap: 3, borderColor: warnings.some((w) => w.level === "warn") ? "color-mix(in srgb, var(--amber) 45%, var(--line))" : "var(--line)" }}>
                <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".11em", color: "var(--mut)", fontWeight: 800, marginBottom: 2 }}>Pre-race check</div>
                {warnings.map((w, i) => <div key={i} style={{ fontSize: 11.5, color: w.level === "warn" ? "var(--amber)" : "var(--mut)" }}>{w.level === "warn" ? "⚠" : "ℹ"} {w.text}</div>)}
              </div>
            )}
            <button className="btn red" disabled={sel.size !== size} onClick={start}>Start race →</button>
            <div style={{ fontSize: 11, color: "var(--mut)", textAlign: "center", marginTop: -6 }}>The plan runs itself — you fire live shouts (attack · bridge · move up · protect) during the race.</div>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "race") {
    const gcNow = Object.entries(gc.current).map(([lid, sec]) => ({ lid: +lid, sec })).sort((a, b) => a.sec - b.sec || (gcCb.current[a.lid] || 0) - (gcCb.current[b.lid] || 0));
    return (
      <div className="gm-wrap" style={{ paddingTop: 16 }}>
        <div className="ph" style={{ paddingLeft: 0 }}>{race.name} {race.kind === "tour" ? `· Stage ${stageIdx + 1}/${race.stages.length} · ${stage.finishType.replace("_", " ")}` : ""}</div>
        {mode !== "watch" ? (
          <div className="card" style={{ padding: 18, textAlign: "center" }}>
            <div style={{ marginBottom: 12, fontWeight: 700 }}>{stage.name} — {stage.lengthKm} km, {stage.finishType.replace("_", " ")} finish</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button className="btn red" onClick={() => setMode("watch")}>Watch &amp; control</button>
              <button className="btn" onClick={simStage}>Simulate stage</button>
            </div>
            {race.kind === "tour" && gcNow.length > 0 && (
              <div style={{ marginTop: 16, textAlign: "left" }}>
                <div className="ph">GC after {stageIdx} stages</div>
                <table className="tbl"><tbody>{gcNow.slice(0, 8).map((g, i) => { const r = state.riders[g.lid]; const isMe = r?.teamId === state.userTeamId; return <tr key={g.lid} className={isMe ? "me" : ""}><td className="mono num" style={{ width: 24 }}>{i + 1}</td><td>{r?.short}</td><td><Tag a={r?.archetype} /></td><td className="num mono">{i === 0 ? fmtTime(g.sec) : "+" + Math.round(g.sec - gcNow[0].sec) + "s"}</td></tr>; })}</tbody></table>
              </div>
            )}
          </div>
        ) : (
          <RaceView state={state} race={race} stage={stage} entries={entries} seedBump={stageIdx + 1} baseCommands={tacticRef.current ? compileTactic(state, race, stage, tacticRef.current[stageIdx], state.userTeamId) : []} onFinish={accumulate} onSimInstant={simStage} />
        )}
      </div>
    );
  }
  if (phase === "done") {
    return <RaceResultScreen state={state} race={race} perStage={perStage} gc={gc.current} cb={gcCb.current} summary={summaryRef.current} log={lastLogRef.current} onClose={() => onDone(true)} />;
  }
  return null;
}

// ============================================================================
//  SCREENS
// ============================================================================
function teamHeader(state) { return state.teams[state.userTeamId]; }

// FM-style at-a-glance indicators (original implementation)
function moodInfo(v) { v = v ?? 65; return v >= 80 ? ["#1f9d57", "buzzing"] : v >= 65 ? ["#5fb83d", "happy"] : v >= 50 ? ["#c9a227", "settled"] : v >= 35 ? ["#dd8a2a", "unsettled"] : ["#d6311f", "unhappy"]; }
function Mood({ v, label }) { const [c, l] = moodInfo(v); return <span title={"Morale: " + l} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 999, background: c, display: "inline-block", flex: "none" }} />{label && <span style={{ fontSize: 11, color: "var(--mut)" }}>{l}</span>}</span>; }
function FormArrow({ v }) { v = v ?? 60; const up = v >= 68, dn = v <= 46; const c = up ? "#1f9d57" : dn ? "#d6311f" : "#9a948a"; return <span title={"Form: " + Math.round(v)} style={{ color: c, fontWeight: 800, fontSize: 11 }}>{up ? "▲" : dn ? "▼" : "▬"}</span>; }
function ConfBar({ v }) { v = v ?? 62; const c = v >= 66 ? "#1f9d57" : v >= 45 ? "#c9a227" : "#d6311f"; const lab = v >= 80 ? "Secure" : v >= 66 ? "Solid" : v >= 45 ? "Watchful" : v >= 25 ? "Under pressure" : "On the brink"; return <div><div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}><span style={{ color: "var(--mut)" }}>Board confidence</span><b style={{ color: c }}>{lab}</b></div><div style={{ height: 8, background: "#262c36", borderRadius: 5, overflow: "hidden" }}><div style={{ width: v + "%", height: "100%", background: c }} /></div></div>; }
function breakoutCol(band) { return band === "cusp" ? "#f5a524" : band === "pushing" ? "#34d399" : band === "developing" ? "#6b8aa0" : "#8a93a0"; }
function breakoutWord(band) { return band === "cusp" ? "On the cusp" : band === "pushing" ? "Pushing up" : band === "developing" ? "Developing" : "Settled"; }
function BreakoutMeter({ x, w = 122 }) { const c = breakoutCol(x.band); return (
  <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: w }}>
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}><span style={{ color: c, fontWeight: 700 }}>{breakoutWord(x.band)}</span><span className="mono" style={{ color: "var(--mut)" }}>{x.pct}%</span></div>
    <div style={{ height: 7, background: "#262c36", borderRadius: 4, overflow: "hidden" }}><div style={{ width: x.pct + "%", height: "100%", background: c, transition: "width .3s" }} /></div>
  </div>
); }

function Dashboard({ state, go, openRace, doSim, openMsg }) {
  const t = teamHeader(state);
  const next = state.calendar[state.calIndex];
  const champs = state.history.slice(-1)[0];
  const riderTop = riderStandings(state, 5);
  const teamTop = teamStandings(state).slice(0, 5);
  const op = objectiveProgress(state);
  const conf = state.boardConfidence ?? 62;
  const squad = t.riderIds.map((id) => state.riders[id]).filter(Boolean);
  const avgMorale = squad.length ? squad.reduce((s, r) => s + (r.morale ?? 65), 0) / squad.length : 65;
  const inForm = squad.slice().sort((a, b) => (b.form ?? 60) - (a.form ?? 60))[0];
  const unread = (state.inbox || []).length;
  const feed = inboxFeed(state, 6);
  const watch = breakoutWatch(state).filter((x) => x.band !== "settled").slice(0, 3);
  // ---- derived command-dashboard data ----
  const AC = { blue: "var(--blue)", red: "var(--red)", green: "var(--green)", amber: "var(--amber)", purple: "var(--purple)", gold: "var(--gold)", cyan: "var(--cyan)", mut: "var(--mut)" };
  const clmp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fatOf = (r) => Math.round(r.fatigue || 0);   // the REAL persistent stat — the old render-time heuristic contradicted Roster/Plan
  const fatList = squad.map((r) => ({ r, fat: fatOf(r) })).sort((a, b) => b.fat - a.fat);
  const injured = squad.filter((r) => r.out > 0).length;
  const available = squad.length - injured;
  const resting = squad.filter((r) => r.out <= 0 && fatOf(r) >= 65).length;
  const critical = fatList.filter((x) => x.fat >= 75 && x.r.out <= 0).length;
  const tidU = state.userTeamId;
  const recent = [];
  for (const race of state.calendar) { const rec = state.results[race.id]; if (!rec) continue; let best = 99;
    (rec.stageResults || []).forEach((sr) => (sr.top || []).forEach((p) => { if (state.riders[p.lid] && state.riders[p.lid].teamId === tidU && p.place && p.place < best) best = p.place; }));
    if (rec.gc) rec.gc.forEach((g, i) => { if (state.riders[g.lid] && state.riders[g.lid].teamId === tidU && (i + 1) < best) best = i + 1; });
    recent.push(best); }
  const form5 = recent.slice(-5);
  const formCol = (b) => b <= 1 ? AC.green : b <= 5 ? AC.blue : b <= 15 ? AC.mut : AC.red;
  const formHt = (b) => b >= 99 ? 26 : b <= 1 ? 108 : b <= 5 ? 82 : b <= 15 ? 54 : 34;
  const formWord = !form5.length ? "NO RACES YET" : (() => { const a = form5.reduce((s, b) => s + (b >= 99 ? 25 : b), 0) / form5.length; return a <= 3 ? "EXCELLENT" : a <= 8 ? "SOLID" : a <= 16 ? "MIXED" : "ROOM TO GROW"; })();
  const donutPct = squad.length ? available / squad.length : 0;
  const RING = 2 * Math.PI * 34;
  const hardStage = React.useMemo(() => next ? (next.kind === "tour"
    ? next.stages.map((st) => [elevationProfile(st).climb, st]).sort((a, b) => b[0] - a[0])[0][1]
    : next.stages[0]) : null, [next]);
  const hp = hardStage ? elevationProfile(hardStage) : null;
  const terr = hardStage ? (hardStage.mode === "itt" ? ["TIME TRIAL", AC.gold] : (hardStage.finishType === "summit" || hardStage.finishType === "mountain") ? ["MOUNTAIN", AC.purple] : hardStage.finishType === "hilly" ? ["HILLY", AC.amber] : hardStage.cobbles ? ["COBBLES", AC.amber] : ["FLAT", AC.blue]) : ["", AC.blue];
  let heroPath = "";
  if (hp) { const span = Math.max(hp.maxE - hp.minE, 60); const HX = (km) => km / hp.L * 1000; const HY = (e) => 112 - ((e - hp.minE) / span) * 88; heroPath = "M 0 112 " + hp.pts.map((p) => "L " + HX(p.km).toFixed(1) + " " + HY(p.elev).toFixed(1)).join(" ") + " L 1000 112 Z"; }
  const climbs = hardStage && hardStage.segments ? hardStage.segments.map((sg) => sg).filter((sg) => (sg[2] || 0) >= 0.045) : [];
  const wx = hardStage && hardStage.wind ? { c: AC.amber, t: "CROSSWIND RISK", temp: "14°", d: "Exposed sections — keep your leader in the front group through the wind." }
    : terr[0] === "MOUNTAIN" ? { c: AC.blue, t: "COLD AT ALTITUDE", temp: "6°", d: "Layered kit for the descents; watch the leader's matches on the climb." }
    : { c: AC.green, t: "FAIR CONDITIONS", temp: "19°", d: "No weather concerns flagged for this race." };
  const objRows = op ? [
    { title: op.text, c: op.onTrack ? AC.green : AC.red, tag: op.onTrack ? "ON TRACK" : "CRITICAL", pct: clmp(Math.round((1 - (op.rank - 1) / Math.max(1, op.n - 1)) * 100), 0, 100) },
    { title: "Win " + op.winsTarget + " race" + (op.winsTarget > 1 ? "s" : "") + " this season", c: op.wins >= op.winsTarget ? AC.green : AC.amber, tag: op.wins >= op.winsTarget ? "MET" : "HIGH", pct: clmp(Math.round(op.wins / Math.max(1, op.winsTarget) * 100), 0, 100) },
  ] : [];
  const myRank = tierStandings(state, t.tier).findIndex((x) => x.id === t.id) + 1;
  const tickN = tierStandings(state, t.tier).length;
  return (
    <div className="dash">
      {next ? (
        <div className="dhero">
          <div className="tags">
            <span className="dtag" style={{ background: terr[1], color: "var(--bg)" }}>{terr[0]}</span>
            <span className="dtag" style={{ background: AC.blue, color: "#fff" }}>{next.kind === "tour" ? next.stages.length + " STAGES" : "ONE-DAY"}</span>
            <span className="dtag" style={{ background: AC.blue, color: "#fff" }}>{t.tier.toUpperCase()}</span>
          </div>
          <h2>{next.name}</h2>
          <div className="hsub">Week {next.week} · prestige {next.prestige}{hp ? " · " + Math.round(hp.L) + " km" : ""}{hardStage && hardStage.finishType === "summit" ? " · summit finish" : ""}</div>
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <button className="btn red" onClick={openRace}>Open race weekend →</button>
            <button className="btn" onClick={doSim}>Quick-sim</button>
          </div>
          <div className="hobj">
            {op && <div className="hobjt">Objective: {op.text}</div>}
            {op && <div style={{ marginTop: 8 }}><span className="riskpill" style={{ background: op.onTrack ? AC.gold : AC.red, color: "var(--bg)" }}>{op.onTrack ? "ON TRACK" : "HIGH PRIORITY"}</span></div>}
          </div>
          <div className="hsil">
            <svg viewBox="0 0 1000 120" preserveAspectRatio="none" width="100%" height="120" style={{ display: "block" }}>
              {heroPath && <path d={heroPath} fill="#161d28" />}
              {heroPath && <line x1="0" y1="111.5" x2="1000" y2="111.5" stroke={AC.red} strokeWidth="1.5" />}
              {climbs.slice(0, 2).map((sg, k) => { const x = (sg[0] / (hp.L || 1)) * 1000; return <text key={k} x={x} y="22" textAnchor="middle" fontSize="13" fill={AC.purple}>⛰</text>; })}
            </svg>
          </div>
        </div>
      ) : (
        <div className="dhero" style={{ borderColor: "var(--line)", boxShadow: "none" }}>
          <h2>Season complete</h2>
          <div className="hsub" style={{ marginBottom: 12 }}>Time to plan the off-season.</div>
          <button className="btn red" onClick={() => go("offseason")}>Go to off-season →</button>
        </div>
      )}

      {/* FM-style inbox — the command centre, right under the next race */}
      <div className="card clik" onClick={() => go("inbox")}>
        <div className="ph">Inbox<span className="mono" style={{ letterSpacing: 0 }}>{unread > 0 ? unread + " new" : "latest"}</span></div>
        <div>
          {feed.length === 0 ? <div style={{ padding: 18, color: "var(--mut)", fontSize: 13 }}>No messages yet — race reports and decisions land here.</div>
            : feed.slice(0, 5).map((it) => it.type === "decision"
              ? <div key={"d" + it.ev.id} className="ibx-msg ibx-unread ibx-clik" onClick={(e) => { e.stopPropagation(); openMsg && openMsg(it); }}><span className="ibx-ic" style={{ color: AC.amber }}>◆</span><div style={{ flex: 1, minWidth: 0 }}><span className="ibx-flag">DECISION</span> <span style={{ fontSize: 12.5 }}>{it.ev.text}</span></div></div>
              : (() => { const ic = NEWS_ICON[it.n.kind] || ["·", AC.mut]; const canOpen = !!resolveMsgTarget(state, it); return <div key={"n" + it.idx} className={"ibx-msg" + (it.unread ? " ibx-unread" : "") + (canOpen ? " ibx-clik" : "")} onClick={canOpen ? (e) => { e.stopPropagation(); openMsg && openMsg(it); } : undefined}><span className="ibx-ic" style={{ color: ic[1] }}>{ic[0]}</span><div style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>{it.n.text}</div><span className="ibx-wk mono">{it.n.date ? "w" + it.n.date : "—"}</span></div>; })())}
        </div>
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--line)", fontSize: 11.5, color: "var(--blue)", fontWeight: 600 }}>Open full inbox →</div>
      </div>

      <div className="dgrid3">
        <div className="dcard clik" onClick={() => go("roster")}>
          <h3>Fatigue watch</h3>
          {fatList.slice(0, 4).map((x) => { const fc = x.fat >= 75 ? AC.red : x.fat >= 55 ? AC.amber : AC.green; return (
            <div key={x.r.id} className="fatrow">
              <div className="ftl"><span style={{ color: "var(--ink)" }}>{x.r.short}</span><span style={{ color: fc }}>{x.fat}%</span></div>
              <span className="track"><span className="fill" style={{ width: x.fat + "%", background: fc }} /></span>
            </div>); })}
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12 }}>
            <span style={{ fontFamily: "var(--fMono)", fontSize: 11, color: critical ? AC.red : "var(--mut)" }}>{critical} at critical risk</span>
            <span className="dlink" onClick={() => go("roster")}>View all</span>
          </div>
        </div>

        <div className="dcard clik" onClick={() => go("calendar")}>
          <h3>Team form</h3>
          <div className="formbars">
            {(form5.length ? form5 : [99, 99, 99, 99, 99]).map((b, i) => <div key={i} style={{ height: formHt(b), background: formCol(b) }} title={b >= 99 ? "no result" : "best: " + b} />)}
          </div>
          <div style={{ textAlign: "center", fontFamily: "var(--fMono)", fontSize: 11, color: "var(--mut)", marginTop: 8 }}>Last {form5.length || 5} results: <b style={{ color: "var(--ink)" }}>{formWord}</b></div>
        </div>

        <div className="dcard clik" onClick={() => go("roster")}>
          <h3>Squad status</h3>
          <div className="donut">
            <svg width="92" height="92" viewBox="0 0 92 92">
              <circle cx="46" cy="46" r="34" fill="none" stroke="var(--line)" strokeWidth="9" />
              <circle cx="46" cy="46" r="34" fill="none" stroke={AC.blue} strokeWidth="9" strokeLinecap="round" strokeDasharray={RING} strokeDashoffset={RING * (1 - donutPct)} transform="rotate(-90 46 46)" />
            </svg>
            <div><div className="dn">{available}/{squad.length}</div><div style={{ fontFamily: "var(--fMono)", fontSize: 10.5, color: "var(--mut)", letterSpacing: ".06em", marginTop: 3 }}>AVAILABLE</div></div>
          </div>
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--fMono)", fontSize: 11.5 }}><span style={{ color: "var(--mut)" }}>INJURED</span><b style={{ color: injured ? AC.amber : "var(--ink)" }}>{injured}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--fMono)", fontSize: 11.5 }}><span style={{ color: "var(--mut)" }}>NEEDS REST</span><b style={{ color: resting ? AC.amber : "var(--ink)" }}>{resting}</b></div>
          </div>
        </div>
      </div>

      <div className="dgrid2">
        <div className="dcard clik" onClick={() => go("finance")}>
          <h3>Sponsor objectives</h3>
          {objRows.length ? objRows.map((o, i) => (
            <div key={i} className="objr">
              <div className="objh"><span className="objt">{o.title}</span><span className="riskpill" style={{ background: o.c + "22", color: o.c }}>{o.tag}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--fMono)", fontSize: 10, color: "var(--mut)", marginBottom: 5 }}><span>PROGRESS</span><span>{o.pct}%</span></div>
              <span className="track"><span className="fill" style={{ width: o.pct + "%", background: o.c }} /></span>
            </div>
          )) : <div style={{ color: "var(--mut)", fontSize: 13 }}>No board objective set.</div>}
          <div style={{ marginTop: 4 }}><span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 11.5, color: "var(--mut)" }}>Squad mood <Mood v={avgMorale} label /></span></div>
        </div>

        <div className="dcard" style={{ borderColor: wx.c }}>
          <h3>Weather alert</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
            <div style={{ fontFamily: "var(--fTitle)", fontWeight: 700, fontSize: 30, color: wx.c }}>{wx.temp}</div>
            <div><div style={{ fontFamily: "var(--fTitle)", fontWeight: 700, fontSize: 17, textTransform: "uppercase" }}>{wx.t}</div><div style={{ fontFamily: "var(--fMono)", fontSize: 11, color: "var(--mut)" }}>{next ? next.name : ""}</div></div>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--mut)", lineHeight: 1.4 }}>{wx.d}</div>
        </div>
      </div>

      <div className="dticker">
        <span>LIVE: {t.name.toUpperCase()} — {t.tier.toUpperCase()} RANK {myRank}/{tickN}</span>
        {next && <span>NEXT: {next.name.toUpperCase()} · WEEK {next.week}</span>}
        {inForm && <span>FLYING: {inForm.short.toUpperCase()}</span>}
        <span>SQUAD MOOD {Math.round(avgMorale)}%</span>
        {unread > 0 && <span style={{ color: AC.gold }}>{unread} IN INBOX</span>}
      </div>

      <div className="row cols-2">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {watch.length > 0 && (
            <div className="card clik" onClick={() => go("development")}>
              <div className="ph">Development watch<span style={{ letterSpacing: 0, color: "var(--mut)" }}>breakthrough tracker</span></div>
              <div style={{ padding: "11px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
                {watch.map((x) => (
                  <div key={x.lid} style={{ display: "flex", alignItems: "center", gap: 11 }}>
                    <Face rider={state.riders[x.lid]} size={30} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}><span style={{ fontWeight: 600, fontSize: 13 }}>{x.short}</span><Tag a={x.archetype} /><span style={{ fontSize: 11, color: "var(--mut)" }}>{x.age}y · OVR {x.overall}</span></div>
                      <div style={{ fontSize: 11, color: "var(--mut)" }}>{x.hint}</div>
                    </div>
                    <BreakoutMeter x={x} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card clik" onClick={() => go("standings")}>
            <div className="ph">Rider ranking<button className="btn sm" onClick={() => go("standings")}>full</button></div>
            <table className="tbl"><tbody>
              {riderTop.map((x, i) => { const r = state.riders[x.lid]; if (!r) return null; const isMe = r.teamId === state.userTeamId; return <tr key={x.lid} className={isMe ? "me" : ""}><td className="mono num" style={{ width: 24 }}>{i + 1}</td><td><span className="chip" style={{ background: r.jersey, marginRight: 6 }} />{r.short}</td><td><Tag a={r.archetype} /></td><td className="num mono">{x.pts}</td></tr>; })}
            </tbody></table>
          </div>
          <div className="card clik" onClick={() => go("standings")}>
            <div className="ph">Team ranking</div>
            <table className="tbl"><tbody>
              {teamTop.map((x, i) => { const tm = state.teams[x.id]; const isMe = x.id === state.userTeamId; return <tr key={x.id} className={isMe ? "me" : ""}><td className="mono num" style={{ width: 24 }}>{i + 1}</td><td><span className="chip" style={{ background: tm.jersey, marginRight: 6 }} />{tm.name}</td><td className="num mono">{x.pts}</td></tr>; })}
            </tbody></table>
          </div>
          {champs && <div className="card clik" onClick={() => go("history")}><div className="ph">Last champion</div><div style={{ padding: 14 }}><b>{champs.championName}</b><div style={{ fontSize: 12, color: "var(--mut)" }}>{champs.season} · team: {champs.teamChampionName}</div></div></div>}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
//  GLOBAL TABLE TOOLS — reusable search + tag-filter + sort for every table
// ============================================================================
const RIDER_TAGS = [
  { label: "Sprinter", test: (r) => r.archetype === "sprinter" },
  { label: "Climber", test: (r) => r.archetype === "climber" },
  { label: "GC", test: (r) => r.archetype === "gc" },
  { label: "Puncheur", test: (r) => r.archetype === "puncheur" },
  { label: "Rouleur", test: (r) => r.archetype === "rouleur" },
  { label: "Lead-out", test: (r) => r.archetype === "leadout" },
  { label: "Domestique", test: (r) => r.archetype === "helper" },
  { label: "Classics", test: (r) => (r.abil?.cobbles || 0) >= 76 },
  { label: "Gravel", test: (r) => (r.abil?.gravel || 0) >= 74 },
  { label: "TT", test: (r) => (r.abil?.timetrial || 0) >= 80 },
  { label: "U23", test: (r) => r.age <= 23 },
  { label: "Veteran", test: (r) => r.age >= 33 },
  { label: "Star", test: (r) => (r.overall || 0) >= 80 },
  { label: "Prospect", test: (r) => r.age <= 23 && ((r.potential || r.overall || 0) - (r.overall || 0)) >= 5 },
  { label: "Peaking", test: (r, c) => c && c.state && periodizedForm(c.state, r, c.week ?? c.state.calendar?.[c.state.calIndex]?.week ?? 0).phase === "peak" },
  { label: "In form", test: (r) => (r.form ?? 60) >= 72 },
  { label: "Injured", test: (r) => (r.out | 0) > 0 && !r.suspended },
  { label: "Listed", test: (r) => !!r.transferListed },
  { label: "Expiring", test: (r) => (r.contractYears || 0) <= 0 },
];
const RIDER_SORTS = [
  { label: "Overall", val: (r) => r.overall || 0 },
  { label: "Potential", val: (r) => r.potential || r.overall || 0 },
  { label: "Form", val: (r) => r.form ?? 60 },
  { label: "Age", val: (r) => r.age || 0, asc: true },
  { label: "Value", val: (r) => valueOf(r) },
  { label: "Climbing", val: (r) => r.abil?.climbing || 0 },
  { label: "Sprint", val: (r) => r.abil?.sprint || 0 },
  { label: "Punch", val: (r) => r.abil?.punch || 0 },
  { label: "Time-trial", val: (r) => r.abil?.timetrial || 0 },
  { label: "Cobbles", val: (r) => r.abil?.cobbles || 0 },
  { label: "Gravel", val: (r) => r.abil?.gravel || 0 },
  { label: "Sprint→flat", val: (r) => r.abil?.flat || 0 },
  { label: "W/kg", val: (r) => (r.cp && r.weight ? r.cp / r.weight : 0) },
  { label: "Recent Δ", val: (r) => r.lastGrowth || 0 },
];
const RACE_TAGS = [
  { label: "Grand Tour", test: (x) => x.cat === "GT" },
  { label: "Monument", test: (x) => x.cat === "Monument" },
  { label: "Classic", test: (x) => x.cat === "WT-1day" },
  { label: "Semi-classic", test: (x) => x.cat === "Semi-classic" },
  { label: "Stage race", test: (x) => x.cat === "WT-stage" },
  { label: "Worlds", test: (x) => x.cat === "Worlds" },
  { label: "Cobbles", test: (x) => (x.stages || []).some((s) => s.cobbles && !s.gravel) },
  { label: "Gravel", test: (x) => (x.stages || []).some((s) => s.gravel) },
  { label: "Mountains", test: (x) => (x.stages || []).some((s) => s.finishType === "summit") },
  { label: "Sprint", test: (x) => x.kind === "oneday" && (x.stages || [])[0]?.finishType === "flat" },
];
const RACE_SORTS = [
  { label: "Date", val: (x) => x.week || 0, asc: true },
  { label: "Prestige", val: (x) => x.prestige || 0 },
  { label: "Coefficient", val: (x) => x.coef || 0 },
  { label: "Prize", val: (x) => x.purse || 0 },
];
function useTableTools(items, cfg = {}) {
  const { tags = [], sorts = [], search, defaultSort = 0, ctx } = cfg;
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(() => new Set());
  const [sortLabel, setSortLabel] = React.useState(sorts[defaultSort]?.label || sorts[0]?.label || "");
  const [flip, setFlip] = React.useState(false);
  const toggle = (label) => setActive((s) => { const n = new Set(s); n.has(label) ? n.delete(label) : n.add(label); return n; });
  const clickSort = (label) => { if (label === sortLabel) setFlip((f) => !f); else { setSortLabel(label); setFlip(false); } };
  const usable = tags.filter((tg) => items.some((it) => { try { return tg.test(it, ctx); } catch (e) { return false; } }));
  const sort = sorts.find((s) => s.label === sortLabel) || sorts[0];
  const asc = sort ? (flip ? !sort.asc : !!sort.asc) : false;
  let list = items.slice();
  if (q.trim()) { const Q = q.toLowerCase(); list = list.filter((it) => (search ? search(it) : (it.name || "")).toLowerCase().includes(Q)); }
  if (active.size) list = list.filter((it) => tags.some((tg) => active.has(tg.label) && (() => { try { return tg.test(it, ctx); } catch (e) { return false; } })()));
  if (sort) list.sort((a, b) => { const va = sort.val(a, ctx), vb = sort.val(b, ctx); return asc ? va - vb : vb - va; });
  // clickable sortable header cell — pass the matching sort label (or omit for a plain header)
  const th = (text, sortLab, props = {}) => {
    const sortable = sortLab && sorts.some((s) => s.label === sortLab);
    if (!sortable) return <th {...props}>{text}</th>;
    const on = sortLab === sortLabel;
    const { style, ...rest } = props;
    return <th {...rest} onClick={() => clickSort(sortLab)} style={{ cursor: "pointer", whiteSpace: "nowrap", userSelect: "none", ...(style || {}) }}>{text}<span style={{ marginLeft: 3, fontSize: 9, opacity: on ? 0.85 : 0.25 }}>{on ? (asc ? "▲" : "▼") : "↕"}</span></th>;
  };
  const toolbar = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "8px 0", marginBottom: 4 }}>
      {search !== null && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…" style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--ink)", width: 130 }} />}
      {sorts.length > 0 && <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
        <select value={sortLabel} onChange={(e) => { setSortLabel(e.target.value); setFlip(false); }} style={{ fontSize: 12, padding: "4px 6px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--ink)" }}>
          {sorts.map((s) => <option key={s.label} value={s.label}>{s.label}</option>)}
        </select>
        <button className="btn sm" title="reverse" onClick={() => setFlip((f) => !f)}>{asc ? "▲" : "▼"}</button>
      </span>}
      {usable.map((tg) => <button key={tg.label} className={"btn sm" + (active.has(tg.label) ? " pri" : "")} onClick={() => toggle(tg.label)}>{tg.label}</button>)}
      {(active.size > 0 || q) && <button className="btn sm" onClick={() => { setActive(new Set()); setQ(""); }} style={{ opacity: 0.7 }}>clear</button>}
    </div>
  );
  return { list, toolbar, active, th, sortLabel };
}

function Roster({ state, refresh, godMode }) {
  const t = teamHeader(state);
  const [detail, setDetail] = React.useState(null);
  const { list: riders, toolbar, th } = useTableTools(t.riderIds.map((id) => state.riders[id]).filter(Boolean), { tags: RIDER_TAGS, sorts: RIDER_SORTS, search: (r) => r.name + " " + (r.nation || ""), ctx: { state, week: state.calendar?.[state.calIndex]?.week ?? 0 } });
  const ripe = new Map(breakoutWatch(state).map((x) => [x.lid, x]));
  const focusOf = (id) => (state.trainingFocus && state.trainingFocus[id]) || "auto";
  const setFocus = (id, v) => { state.trainingFocus = state.trainingFocus || {}; state.trainingFocus[id] = v; refresh(); };
  const resign = (r) => {
    const o = reSignOffer(r);
    if (!o.willing && !confirm(`${r.short} wants to test the market (${o.note}). Table an offer anyway at €${o.salary}M/yr?`)) return;
    signTo(state, t, r, o.years, o.salary);
    state.news.push({ season: state.season, date: 0, kind: "morale", text: `${r.short} re-signs — ${o.years}y at €${o.salary}M/yr.` });
    refresh();
  };
  const release = (r) => { releaseFrom(state, t, r); recountTeam(state); refresh(); };
  return (
    <div className="card">
      <div className="ph">Roster · {t.name}<span className="mono" style={{ letterSpacing: 0 }}>wage {money(t.salaryTotal || 0)}</span></div>
      <div style={{ padding: "0 12px" }}>{toolbar}</div>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead><tr><th></th>{th("Rider")}{th("Type")}{th("OVR", "Overall", { className: "num" })}{th("POT", "Potential", { className: "num" })}{th("Age", "Age", { className: "num" })}<th className="num">Mor</th>{th("Form", "Form", { className: "num" })}<th>Fatigue</th><th className="num">Salary</th><th className="num">Yrs</th><th>Training</th><th></th></tr></thead>
          <tbody>
            {riders.map((r) => (
              <tr key={r.id}>
                <td><Face rider={r} size={30} /></td>
                <td style={{ cursor: "pointer", fontWeight: 700, fontFamily: "var(--fTitle)", fontSize: 15 }} onClick={() => setDetail(r)}>{r.name}{r.out > 0 && <span title={r.suspended ? "Suspended" : "Injured"} style={{ marginLeft: 6, fontSize: 9.5, fontWeight: 800, padding: "1px 5px", borderRadius: 4, background: "rgba(255,59,59,.16)", color: "var(--red)", verticalAlign: "middle" }}>{r.suspended ? "SUSP" : "OUT"} {r.out}</span>}</td>
                <td><Tag a={r.archetype} /></td>
                <td className="num"><Ovr o={r.overall} /></td>
                <td className="num mono" style={{ color: r.potential > r.overall + 4 ? "var(--green)" : "var(--mut)" }}>{(() => { const kp = knownPotential(r); return kp.unknown ? "?" : kp.mid; })()}{ripe.get(r.id)?.band === "cusp" ? <span title="On the cusp of a breakthrough" style={{ color: "var(--gold)", marginLeft: 4 }}>▲</span> : ripe.get(r.id)?.band === "pushing" ? <span title="Pushing for a step up" style={{ color: "var(--green)", marginLeft: 4 }}>▴</span> : null}</td>
                <td className="num mono">{r.age}</td>
                <td className="num"><Mood v={r.morale ?? 65} /></td>
                <td className="num"><FormArrow v={r.form ?? 60} /></td>
                <td><FatBar f={r.fatigue || 0} /></td>
                <td className="num mono">{money(r.salary)}</td>
                <td className="num mono" style={{ color: r.contractYears <= 0 ? "var(--red)" : "var(--ink)" }}>{r.contractYears <= 0 ? "exp" : r.contractYears}</td>
                <td><div className="seg">{["threshold", "punch", "sprint"].map((k) => <button key={k} className={focusOf(r.id) === k ? "on" : ""} title={k} onClick={() => setFocus(r.id, focusOf(r.id) === k ? "auto" : k)}>{k[0].toUpperCase()}</button>)}</div></td>
                <td>{r.contractYears <= 0 || r.transferListed ? <button className="btn sm" onClick={() => resign(r)}>Re-sign</button> : <button className="btn sm" onClick={() => release(r)}>Release</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail && <RiderModal state={state} rider={detail} onClose={() => setDetail(null)} godMode={godMode} refresh={refresh} />}
    </div>
  );
}

// power–duration "test sheet" + multi-season progression line
function PowerProfilePanel({ rider }) {
  const pp = powerProfile(rider);
  const rows = [["FTP", pp.ftp], ["20-min", pp.p20], ["5-min", pp.p5], ["1-min", pp.p1], ["Sprint", pp.sprint]];
  const maxWkg = Math.max(...rows.map((r) => r[1].wkg));
  return (
    <div>
      <div style={{ fontSize: 11.5, color: "var(--mut)", marginBottom: 6 }}>Best effort: <b style={{ color: "#f3705f" }}>{pp.p20.wkg} W/kg for 20 min</b> · FTP <b className="mono" style={{ color: "var(--ink)" }}>{pp.ftp.wkg} W/kg</b> @ {pp.weight}kg</div>
      {rows.map(([lab, v]) => (
        <div key={lab} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, marginBottom: 4 }}>
          <span style={{ width: 48, color: "var(--mut)" }}>{lab}</span>
          <span className="track" style={{ flex: 1 }}><span className="fill" style={{ width: (v.wkg / maxWkg * 100) + "%", background: "#f3705f" }} /></span>
          <b className="mono" style={{ width: 62, textAlign: "right" }}>{v.wkg}<span style={{ color: "var(--mut)", fontWeight: 400 }}> w/kg</span></b>
          <span className="mono" style={{ width: 50, textAlign: "right", color: "var(--mut)" }}>{v.w}W</span>
        </div>
      ))}
    </div>
  );
}
function ProgressChart({ history, h = 72 }) {
  const hist = (history || []).filter((x) => isFinite(x.wkg));
  if (hist.length < 2) return <div style={{ fontSize: 11.5, color: "var(--mut)" }}>Progression charts here after a season or two of training.</div>;
  const W = 250, pad = 7;
  const xs = hist.map((_, i) => pad + i / (hist.length - 1) * (W - pad * 2));
  const vals = hist.map((x) => x.wkg);
  const lo = Math.min(...vals) - 0.1, hi = Math.max(...vals) + 0.1;
  const y = (v) => h - pad - 9 - (v - lo) / (hi - lo || 1) * (h - pad * 2 - 9);
  const pts = hist.map((x, i) => `${xs[i].toFixed(1)},${y(x.wkg).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${h}`} width="100%" height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke="#f3705f" strokeWidth="2" />
      {hist.map((x, i) => <circle key={i} cx={xs[i]} cy={y(x.wkg)} r="2.4" fill="#f3705f" />)}
      <text x={pad} y={10} fontSize="9" fill="#8a93a0" className="mono">{hi.toFixed(1)}</text>
      <text x={pad} y={h - 2} fontSize="9" fill="#8a93a0" className="mono">{lo.toFixed(1)} w/kg · seasons {hist[0].s}–{hist[hist.length - 1].s}</text>
    </svg>
  );
}

function RiderModal({ state, rider, onClose, godMode, refresh }) {
  const a = ARCHG[rider.archetype] || ARCHG.helper;
  const isMine = rider.teamId === state.userTeamId;
  const disc = disciplines(rider);
  const kp = knownPotential(rider);
  const seasonPts = Math.round(state.rankings.rider[rider.id] || 0);
  const car = rider.career || { wins: 0, podiums: 0, top10: 0, points: 0, seasons: 0 };
  const valBar = (label, v, col) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 5 }}>
      <span style={{ width: 88, color: "var(--mut)" }}>{label}</span>
      <span className="track"><span className="fill" style={{ width: (v / 99 * 100) + "%", background: col }} /></span>
      <b className="mono" style={{ width: 22, textAlign: "right" }}>{v}</b>
    </div>
  );
  const Sec = ({ title, children }) => <div style={{ marginBottom: 12 }}><div style={{ fontSize: 10.5, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--mut)", fontWeight: 800, marginBottom: 6 }}>{title}</div>{children}</div>;
  const room = (rider.potential || rider.overall) - rider.overall;
  const traj = rider.age < rider.peak && room > 7 ? ["high ceiling", "var(--green)"] : rider.age < rider.peak && room > 2 ? ["developing", "#2b59c3"] : rider.age <= rider.peak + 1 ? ["at peak", "#8a93a0"] : ["declining", "#d6311f"];
  const [tab, setTab] = React.useState("overview");
  const clmp2 = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const AC = { blue: "var(--blue)", red: "var(--red)", green: "var(--green)", amber: "var(--amber)", purple: "var(--purple)", gold: "var(--gold)", cyan: "var(--cyan)", mut: "var(--mut)" };
  const fatPct = Math.round(rider.fatigue || 0);   // real season fatigue — was a fabricated heuristic that contradicted the hero FatBar
  const moodC = moodColor(rider.morale ?? 65), moodW = moodWord(rider.morale ?? 65);
  const attrDefs = [["Climbing", "climbing"], ["Sprinting", "sprint"], ["Time trial", "timetrial"], ["Endurance", "stamina"], ["Recovery", "recovery"], ["Acceleration", "punch"], ["Descending", "descending"], ["Cobbles", "cobbles"], ["Gravel", "gravel"], ["Teamwork", "bikehandling"], ["Race IQ", "positioning"]];
  const attrCol = (v) => v >= 88 ? AC.red : v >= 80 ? AC.blue : v >= 70 ? AC.green : v >= 55 ? AC.amber : AC.mut;
  let fbars = [];
  try { const cw = state.calendar[state.calIndex]?.week || 12; const start = Math.max(1, cw - 11); for (let i = 0; i < 12; i++) fbars.push(Math.round(periodizedForm(state, rider, start + i).form)); } catch (e) { fbars = Array.from({ length: 12 }, () => Math.round(rider.form ?? 60)); }
  const fTrend = fbars[11] - fbars[0];
  const trendLab = fTrend > 3 ? ["RISING", AC.green, "\u25b2"] : fTrend < -3 ? ["FALLING", AC.red, "\u25bc"] : ["STEADY", AC.blue, "\u25ac"];
  const recent = (rider.palmares || []).slice().reverse().slice(0, 3);
  const injuryRisk = clmp2(Math.round(8 + Math.max(0, (rider.age || 26) - 30) * 2.5 + (100 - (rider.abil?.recovery || 60)) * 0.2), 3, 70);
  const injLab = injuryRisk < 20 ? ["LOW", AC.green] : injuryRisk < 40 ? ["MODERATE", AC.amber] : ["HIGH", AC.red];
  const endYear = state.season + Math.max(0, rider.contractYears || 0);
  return (
    <div className="modal" onClick={onClose}>
      <div className="sheet rpro" onClick={(e) => e.stopPropagation()}>
        <div className="rp-grid">
          <div>
            <div className="rp-hero">
              <div className="rp-face"><Face rider={rider} size={132} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="rp-tagrow">
                  {rider.status && <span className="rp-tag" style={{ background: AC.gold, color: "var(--bg)" }}>{(STATUS_LABEL[rider.status] || rider.status).toUpperCase()}</span>}
                  <span className="rp-tag" style={{ background: a.col, color: "var(--bg)" }}>{a.tag.toUpperCase()}</span>
                  {!isMine && <span className="rp-tag" style={{ background: AC.mut + "33", color: AC.mut }}>{state.teams[rider.teamId]?.name || "FREE AGENT"}</span>}
                </div>
                <div className="rp-name">{rider.name}</div>
                <div className="rp-vitals">
                  <div><div className="lab">NAT</div><div className="val">{rider.nation || "\u2014"}</div></div>
                  <div><div className="lab">AGE</div><div className="val">{rider.age}</div></div>
                  <div><div className="lab">WEIGHT</div><div className="val">{rider.weight}<span style={{ fontSize: 13 }}>kg</span></div></div>
                  <div><div className="lab">OVR</div><div className="val" style={{ color: ovrCol(rider.overall) }}>{rider.overall}</div></div>
                  <div><div className="lab">FATIGUE</div><div style={{ marginTop: 5 }}><FatBar f={rider.fatigue || 0} w={60} /></div><div style={{ fontSize: 9.5, color: "var(--mut)", marginTop: 2 }}>{fatigueLabel(Math.round(rider.fatigue || 0))} · {gtCapFor(rider)} GT cap</div></div>
                </div>
              </div>
            </div>
            <div className="rp-tabs">
              {[["overview", "Overview"], ["power", "Power"], ["training", "Training"], ["history", "History"], ["contract", "Contract"]].map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
            </div>

            {tab === "overview" && <>
              <div className="rp-metrics">
                <div className="rp-metric" style={{ borderColor: AC.green }}><span className="ml">Fitness</span><span className="mv" style={{ color: AC.green }}>{rider.overall}</span><span className="track"><span className="fill" style={{ width: rider.overall + "%", background: AC.green }} /></span></div>
                <div className="rp-metric" style={{ borderColor: AC.amber }}><span className="ml">Fatigue</span><span className="mv" style={{ color: fatPct >= 70 ? AC.red : fatPct >= 45 ? AC.amber : AC.green }}>{fatPct}%</span><span className="track"><span className="fill" style={{ width: fatPct + "%", background: fatPct >= 70 ? AC.red : AC.amber }} /></span></div>
                <div className="rp-metric" style={{ borderColor: AC.blue }}><span className="ml">Morale</span><span className="rp-pill" style={{ background: moodC + "22", color: moodC, alignSelf: "flex-start", marginTop: 4 }}>{moodW}</span></div>
                <div className="rp-metric" style={{ borderColor: AC.cyan }}><span className="ml">Form</span><span className="mv" style={{ color: trendLab[1], fontSize: 18, display: "flex", alignItems: "center", gap: 7 }}>{trendLab[2]} {trendLab[0]}</span></div>
              </div>

              <div className="rp-sect">Attributes</div>
              <div className="rp-attrs">
                {attrDefs.map(([l, k]) => { const e = estAbil(rider, k); const v = e.mid; const c = attrCol(v); return (
                  <div key={k} className="rp-attr"><span className="ad" style={{ background: c }} /><div className="av" style={{ color: c }}>{v}</div><div className="al">{l}</div></div>); })}
              </div>

              <div className="rp-trend">
                <div className="rp-sect" style={{ marginBottom: 14 }}>Form trend (12 weeks)</div>
                <div className="rp-trendbars">
                  {fbars.map((v, i) => <div key={i}><span className="bar" style={{ height: clmp2((v - 40) / 55 * 124, 6, 124) }} /><span className="wk">W{i + 1}</span></div>)}
                </div>
              </div>
            </>}

            {tab === "power" && (
              <div style={{ padding: "6px 0 12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 22px" }}>
                <div>
<Sec title="Power profile · test">
              <PowerProfilePanel rider={rider} />
              <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 11.5, color: "var(--mut)", flexWrap: "wrap" }}>
                <span>CP <b className="mono" style={{ color: "var(--ink)" }}>{rider.cp}W</b></span>
                <span>W′ <b className="mono" style={{ color: "var(--ink)" }}>{(rider.wPrime / 1000).toFixed(1)}kJ</b></span>
                {rider.trainedAlt && <span style={{ color: "var(--green)", fontWeight: 700 }}>⛰ altitude camp</span>}
              </div>
            </Sec>
                </div>
                <div>
<Sec title="Terrain ability">
              {valBar("Climbing", disc.climbing, "#4a7c59")}{valBar("Time trial", disc.timetrial, "#4a7c59")}{valBar("Sprint", disc.sprint, "#4a7c59")}{valBar("Hills / Punch", disc.punch, "#4a7c59")}{valBar("Breakaway", disc.breakaway, "#4a7c59")}{valBar("Endurance", disc.endurance, "#4a7c59")}
            </Sec>
                </div>
              </div>
            )}
            {tab === "training" && (
              <div style={{ padding: "6px 0 12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 22px" }}>
                <div>
<Sec title="Abilities">
              {(() => {
                const aEdit = (key, d) => { rider.abil[key] = Math.max(1, Math.min(99, (rider.abil[key] || 1) + d)); syncShadows(rider); derivePhysicals(rider); rider.overall = overallOf(rider); refresh(); };
                const km = knownPower(rider);
                const aBar = (label, key) => {
                  const e = estAbil(rider, key);
                  return (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, marginBottom: 4 }}>
                      <span style={{ width: 74, color: "var(--mut)" }}>{label}</span>
                      <span className="track" style={{ flex: 1, position: "relative" }}>
                        {!e.exact && <span style={{ position: "absolute", left: (e.lo / 99 * 100) + "%", width: ((e.hi - e.lo) / 99 * 100) + "%", top: 0, bottom: 0, background: a.col, opacity: .22, borderRadius: 3 }} />}
                        <span className="fill" style={{ width: (e.mid / 99 * 100) + "%", background: a.col, opacity: e.exact ? 1 : .85 }} />
                      </span>
                      <b className="mono" style={{ width: 42, textAlign: "right", color: e.exact ? "var(--ink)" : "var(--mut)" }}>{e.exact ? e.mid : `${e.lo}–${e.hi}`}</b>
                      {godMode && <span style={{ display: "inline-flex", gap: 2 }}><button className="btn sm" onClick={() => aEdit(key, -1)}>−</button><button className="btn sm" onClick={() => aEdit(key, 1)}>+</button></span>}
                    </div>
                  );
                };
                const peaking = rider._peakTheme || (rider.form ?? 60) >= 88;
                return <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "0 0 4px" }}>
                    <span style={{ fontSize: 10, color: "var(--mut)", fontWeight: 700 }}>TERRAIN</span>
                    <span style={{ fontSize: 10, color: km.exact ? "var(--green)" : "#e08a1e", fontWeight: 700 }}>power read {km.pk}%</span>
                  </div>
                  {[["Climbing", "climbing"], ["Punch", "punch"], ["Flat", "flat"], ["Time-trial", "timetrial"], ["Sprint", "sprint"], ["Cobbles", "cobbles"], ["Gravel", "gravel"], ["Bike handling", "bikehandling"]].map(([l, k]) => aBar(l, k))}
                  <div style={{ fontSize: 10, color: "var(--mut)", fontWeight: 700, margin: "8px 0 4px" }}>ENGINE &amp; CRAFT</div>
                  {[["Stamina", "stamina"], ["Recovery", "recovery"], ["Positioning", "positioning"], ["Descending", "descending"], ["Attacking", "attacking"]].map(([l, k]) => aBar(l, k))}
                  <div style={{ display: "flex", gap: 12, marginTop: 9, fontSize: 11.5, color: "var(--mut)", flexWrap: "wrap", alignItems: "center" }}>
                    <span>Measured CP <b className="mono" style={{ color: "var(--ink)" }}>{rider.cp}W</b></span>
                    <span>W/kg <b className="mono" style={{ color: "var(--ink)" }}>{(rider.cp / rider.weight).toFixed(2)}</b></span>
                    <span>W′ <b className="mono" style={{ color: "var(--ink)" }}>{(rider.wPrime / 1000).toFixed(1)}kJ</b></span>
                    {peaking && <span style={{ fontSize: 10, fontWeight: 800, padding: "2px 7px", borderRadius: 999, background: "rgba(245,165,36,.18)", color: "#f5a524" }}>● PEAKING{rider._peakTheme ? " · " + rider._peakTheme : ""}</span>}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--mut)", marginTop: 5, opacity: .8 }}>{km.exact ? "Live power is read each race from form, peak & the day." : "Estimated — race against this rider to sharpen the read."}</div>
                </>;
              })()}
            </Sec>
                </div>
                <div>
{isMine && <Sec title="Season plan · periodization">
              {(() => {
                const now = periodizedForm(state, rider, state.calendar[state.calIndex]?.week || 0);
                return <>
                  {[0, 1].map((slot) => {
                    const t = rider.plan?.targets?.[slot];
                    return <div key={slot} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6, fontSize: 11.5, flexWrap: "wrap" }}>
                      <span style={{ width: 46, color: "var(--mut)" }}>Peak {slot + 1}</span>
                      <select className="sel" value={t ? t.calIndex : ""} onChange={(e) => { const v = e.target.value; setRiderTarget(state, rider, slot, v === "" ? null : +v, t?.theme || "allround"); refresh(); }} style={{ flex: 1, minWidth: 130 }}>
                        <option value="">— no target —</option>
                        {state.calendar.map((race, ci) => <option key={ci} value={ci}>wk{race.week} · {race.name}</option>)}
                      </select>
                      {t && <select className="sel" value={t.theme} onChange={(e) => { setRiderTarget(state, rider, slot, t.calIndex, e.target.value); refresh(); }} style={{ width: 104 }}>
                        {PEAK_THEMES.map((th) => <option key={th.key} value={th.key}>{th.label}</option>)}
                      </select>}
                    </div>;
                  })}
                  <div style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 2 }}>This week: form <b style={{ color: now.phase === "peak" ? "#f5a524" : now.phase === "trough" ? "#f3705f" : "var(--ink)" }}>{now.form}</b> · <b>{now.phase}</b> phase. Two peaks max — a real trough follows each, so space them out.</div>
                </>;
              })()}
            </Sec>}
                </div>
              </div>
            )}
            {tab === "history" && (
              <div style={{ padding: "6px 0 12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 22px" }}>
                <div>
<Sec title="Career">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                {[["Wins", car.wins], ["Podiums", car.podiums], ["Top 10s", car.top10], ["Seasons", car.seasons], ["Career pts", car.points], ["This yr", seasonPts]].map(([l, v]) => (
                  <div key={l} style={{ background: "#1f242d", borderRadius: 7, padding: "6px 8px" }}><div className="mono" style={{ fontWeight: 800, fontSize: 14 }}>{v}</div><div style={{ fontSize: 9.5, color: "var(--mut)" }}>{l}</div></div>
                ))}
              </div>
            </Sec>
<Sec title="Palmares">
              {(() => { const pal = (rider.palmares || []).filter((p) => p.place <= 3).slice().reverse();
                if (!pal.length) return <div style={{ fontSize: 11.5, color: "var(--mut)" }}>No major results yet{rider.age <= 21 ? " — one for the U23 races." : "."}</div>;
                const mc = ["#c79a33", "#9aa0a6", "#b07a44"];
                return <div style={{ maxHeight: 124, overflowY: "auto" }}>{pal.slice(0, 16).map((p, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "2px 0" }}>
                    <span className="mono" style={{ width: 28, fontWeight: 800, color: mc[p.place - 1] }}>{p.place === 1 ? "1st" : p.place === 2 ? "2nd" : "3rd"}</span>
                    <span style={{ flex: 1 }}>{p.race}{p.kind === "u23" ? <span style={{ color: "var(--mut)", fontSize: 10 }}> · U23</span> : p.kind === "tour" ? <span style={{ color: "var(--mut)", fontSize: 10 }}> · GC</span> : ""}</span>
                    <span className="mono" style={{ color: "var(--mut)", fontSize: 10.5 }}>{p.s}</span>
                  </div>))}</div>; })()}
            </Sec>
                </div>
                <div>
<Sec title="Progression · W/kg">
              <ProgressChart history={rider.history} />
            </Sec>
{(() => {
              if (rider.teamId !== state.userTeamId) return null;
              const bw = breakoutWatch(state).find((x) => x.lid === rider.id);
              if (!bw) return null;
              const perfF = Math.max(0, Math.min(1, (bw.perf + 0.2) / 1.6));
              const resultsLab = perfF >= 0.6 ? "strong" : perfF >= 0.35 ? "okay" : "light";
              const gap = rider.peak - rider.age;
              const c = breakoutCol(bw.band);
              return <Sec title="Breakthrough watch">
                <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  <BreakoutMeter x={bw} w={"100%"} />
                  <div style={{ fontSize: 12.5, color: c, fontWeight: 600 }}>{bw.band === "cusp" ? "★ " : ""}{bw.hint}</div>
                  <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5, color: "var(--mut)" }}>
                    <span>Results <b style={{ color: "var(--ink)" }}>{resultsLab}</b></span>
                    <span>Age window <b style={{ color: "var(--ink)" }}>{gap > 1 ? "open" : gap >= -1 ? "closing" : "shut"}</b></span>
                    <span>Headroom <b style={{ color: "var(--ink)" }}>+{Math.max(0, bw.room)}</b></span>
                    <span>Morale <b style={{ color: "var(--ink)" }}>{Math.round(rider.morale ?? 65)}</b></span>
                  </div>
                </div>
              </Sec>;
            })()}
                </div>
              </div>
            )}
            {tab === "contract" && (
              <div style={{ padding: "6px 0 12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 22px" }}>
                <div>
<Sec title="Contract & development">
              <div style={{ fontSize: 12, color: "var(--mut)", lineHeight: 1.7 }}>
                <div>Value <b className="mono" style={{ color: "var(--ink)" }}>{money(rider.value)}</b> · Wage <b className="mono" style={{ color: "var(--ink)" }}>{money(rider.salary)}</b>/yr · {rider.contractYears <= 0 ? "expiring" : rider.contractYears + "y left"}{rider.status ? <span> · <b style={{ color: "var(--ink)" }}>{STATUS_LABEL[rider.status] || rider.status}</b></span> : null}</div>
                <div>Outlook <b style={{ color: traj[1] }}>{traj[0]}</b> · peak age <b className="mono" style={{ color: "var(--ink)" }}>{rider.peak}</b>{rider.lastGrowth ? <span> · last season <b className="mono" style={{ color: rider.lastGrowth > 0 ? "var(--green)" : "#d6311f" }}>{rider.lastGrowth > 0 ? "+" : ""}{rider.lastGrowth}</b></span> : null}</div>
              </div>
            </Sec>
                </div>
                <div>
<Sec title="Temperament & condition">
              {valBar("Ambition", rider.amb || 50, "#6a4c93")}{valBar("Temperament", rider.temp || 50, "#6a4c93")}{valBar("Loyalty", rider.loyal || 50, "#6a4c93")}{valBar("Professional", rider.prof || 50, "#6a4c93")}
              <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 11.5 }}>
                <span style={{ color: "var(--mut)" }}>Morale <b className="mono" style={{ color: moodColor(rider.morale ?? 65) }}>{moodWord(rider.morale ?? 65)}</b></span>
                <span style={{ color: "var(--mut)" }}>Form <b className="mono" style={{ color: "var(--ink)" }}>{Math.round(rider.form ?? 60)}</b></span>
                {rider.transferListed && <span className="warn">listed</span>}
              </div>
            </Sec>
                </div>
              </div>
            )}
          </div>
          <div className="rp-side">
            <div className="rp-card b-blue">
              <h4>Recent results</h4>
              {recent.length ? recent.map((p, i) => <div key={i} className="rp-rrow"><span>{p.race}{p.kind === "tour" ? " GC" : p.kind === "u23" ? " U23" : ""}</span><b style={{ color: p.place === 1 ? AC.green : p.place <= 3 ? AC.gold : "var(--ink)" }}>{p.place === 1 ? "1st" : p.place === 2 ? "2nd" : p.place === 3 ? "3rd" : p.place + "th"}</b></div>) : <div style={{ fontSize: 12.5, color: "var(--mut)" }}>No major results yet.</div>}
            </div>
            <div className="rp-card">
              <h4>Contract status</h4>
              <div style={{ fontFamily: "var(--fMono)", fontSize: 10, color: "var(--mut)", letterSpacing: ".06em" }}>SALARY</div>
              <div style={{ fontFamily: "var(--fTitle)", fontWeight: 700, fontSize: 28, margin: "2px 0 12px" }}>{money(rider.salary)}</div>
              <div className="rp-rrow"><span style={{ color: "var(--mut)" }}>Ends</span><b>{rider.contractYears <= 0 ? "EXPIRING" : "DEC " + endYear}</b></div>
              <div className="rp-rrow"><span style={{ color: "var(--mut)" }}>Value</span><b className="mono">{money(rider.value)}</b></div>
              <div className="rp-rrow" style={{ borderBottom: 0 }}><span style={{ color: "var(--mut)" }}>Outlook</span><b style={{ color: traj[1] }}>{traj[0]}</b></div>
            </div>
            <div className="rp-card b-green">
              <h4>Medical</h4>
              <span className="rp-pill" style={{ background: (rider.out > 0 ? AC.red : AC.green) + "22", color: rider.out > 0 ? AC.red : AC.green }}>{rider.out > 0 ? "OUT " + rider.out + "w" : "FIT TO RACE"}</span>
              <div style={{ marginTop: 12, fontSize: 13 }}>Injury risk: <b style={{ color: injLab[1] }}>{injLab[0]} ({injuryRisk}%)</b></div>
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--mut)", lineHeight: 1.4 }}>{rider.age >= 32 ? "Manage load carefully; veteran legs need recovery." : (rider.abil?.recovery || 60) < 55 ? "Below-par recovery \u2014 watch back-to-back race blocks." : "Good recovery profile; cleared for a full programme."}</div>
            </div>
          </div>
        </div>
        <div style={{ padding: 12, borderTop: "1px solid var(--line)", textAlign: "right" }}><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}


function Finance({ state, refresh }) {
  const [msg, setMsg] = React.useState(null);
  const [showMarket, setShowMarket] = React.useState(false);
  const t = state.teams[state.userTeamId];
  const f = teamFinances(state, state.userTeamId);
  const market = sponsorMarket(state, state.userTeamId);
  const openByTier = (tier) => f.sponsors.some((s) => s.tier === tier && (s.years || 0) <= 0);
  const TIER_LABEL = { title: "Title", co: "Co-sponsor", equipment: "Equipment" };
  const act = (fn) => { const r = fn(); setMsg(r && r.ok === false ? { ok: 0, text: r.reason || "Couldn't do that." } : { ok: 1, text: r && r.text ? r.text : "Done." }); refresh && refresh(); };
  const doRenew = (id) => act(() => { const r = renegotiateSponsor(state, state.userTeamId, id); return r.ok ? { ok: 1, text: `Renewed ${r.sponsor.name} at ${money(r.sponsor.value)}/yr.` } : r; });
  const doBuyout = (id, name) => act(() => { const r = buyoutSponsor(state, state.userTeamId, id); return r.ok ? { ok: 1, text: `Bought out ${name} for ${money(r.fee)}. Slot is open.` } : r; });
  const doSign = (offerId, name) => act(() => { const r = signSponsor(state, state.userTeamId, offerId); return r.ok ? { ok: 1, text: `Signed ${name}!` } : r; });

  const Metric = ({ label, val, color, sub }) => <div className="rp-metric" style={{ borderColor: color }}><span className="ml">{label}</span><span className="mv" style={{ color, fontSize: 23 }}>{val}</span>{sub && <span style={{ fontSize: 10.5, color: "var(--mut)", display: "block", marginTop: 2 }}>{sub}</span>}</div>;
  const netCol = f.net < 0 ? "var(--red)" : "var(--green)";
  const overCol = f.wageOver > 0 ? "var(--red)" : "var(--green)";
  const askPill = (sp) => { const m = sp.prog.met; return <span className="riskpill" style={{ background: `color-mix(in srgb, ${m ? "var(--green)" : "var(--amber)"} 20%, transparent)`, color: m ? "var(--green)" : "var(--amber)", flex: "none" }}>{m ? "MET" : "OPEN"} · {sp.prog.text}</span>; };

  return (
    <div className="dash">
      {msg && <div style={{ margin: "0 0 12px", padding: "8px 12px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: `color-mix(in srgb, var(${msg.ok ? "--green" : "--red"}) 13%, transparent)`, color: msg.ok ? "var(--green)" : "var(--hot)", border: `1px solid color-mix(in srgb, var(${msg.ok ? "--green" : "--red"}) 30%, transparent)` }}>{msg.text}<span style={{ float: "right", cursor: "pointer", color: "var(--mut)" }} onClick={() => setMsg(null)}>×</span></div>}
      {(f.debtSeasons > 0 || f.wageOver > 0.01) && <div style={{ margin: "0 0 12px", padding: "9px 12px", borderRadius: 8, fontSize: 12.5, background: "color-mix(in srgb, var(--amber) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--amber) 35%, transparent)", color: "var(--amber)" }}>{f.debtSeasons > 0 ? `⚠ In the red ${f.debtSeasons} season${f.debtSeasons > 1 ? "s" : ""} — the board is unhappy and a forced sale looms. ` : ""}{f.wageOver > 0.01 ? `Your wage bill is ${money(f.wageOver)} over your sustainable budget — win prize money, land sponsor bonuses, or trim wages.` : ""}</div>}

      <div className="rp-metrics">
        <Metric label="Cash on hand" val={money(f.budget)} color={f.budget < 0 ? "var(--red)" : "var(--blue)"} />
        <Metric label="Projected net / yr" val={money(f.net)} color={netCol} sub={`incl. ${money(f.projBonus)} sponsor bonuses on track`} />
        <Metric label="Sponsor income" val={money(f.income)} color="var(--green)" />
        <Metric label="Wage bill / yr" val={money(f.wageBill)} color={overCol} sub={`budget ${money(f.wageBudget)} · ${f.wageOver > 0 ? money(f.wageOver) + " over" : money(-f.wageOver) + " room"}`} />
      </div>

      <div className="dgrid2">
        <div className="dcard">
          <h3>Budget · {state.season}</h3>
          {[["Sponsor income", f.income], ["Prize money (YTD)", f.prize], ["Sponsor bonuses (on track)", f.projBonus], ["Wage bill", -f.wageBill], ["Academy", -f.dev], ["Scouts", -f.scouts], ["Operating costs", -f.ops]].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--line)", fontSize: 13 }}><span style={{ color: "var(--mut)" }}>{k}</span><b className="mono" style={{ color: v < 0 ? "var(--red)" : "var(--green)" }}>{money(v)}</b></div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 0 2px", fontWeight: 800, fontSize: 14 }}><span>Projected net / yr</span><b className="mono" style={{ color: netCol }}>{money(f.net)}</b></div>
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--mut)" }}>Sponsor asks are your second goal layer — meet them for season-end bonuses. Sustainable wage budget = sponsor income − running costs.</div>
        </div>

        <div className="dcard">
          <h3 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>Sponsors<button className="btn sm" onClick={() => setShowMarket((v) => !v)}>{showMarket ? "Hide market" : "Sponsor market"}</button></h3>
          {f.sponsors.map((sp) => { const expired = (sp.years || 0) <= 0; const vacant = !!sp.vacant;
            const atRisk = !vacant && !sp.prog.met && (sp.patience ?? 9) <= 1;
            return (
            <div key={sp.id} style={{ padding: 11, border: `1px solid ${vacant ? "color-mix(in srgb, var(--red) 45%, var(--line))" : atRisk ? "color-mix(in srgb, var(--red) 40%, var(--line))" : expired ? "color-mix(in srgb, var(--amber) 40%, var(--line))" : "var(--line)"}`, borderRadius: 9, marginBottom: 9, background: "var(--card2)" }}>
              {vacant ? (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span><b style={{ fontFamily: "var(--fTitle)", fontSize: 15, textTransform: "uppercase", color: "var(--red)" }}>Vacant {TIER_LABEL[sp.tier] || sp.tier} slot</b></span>
                  <button className="btn sm pri" onClick={() => setShowMarket(true)}>Sign from market →</button>
                </div>
              ) : <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <span><b style={{ fontFamily: "var(--fTitle)", fontSize: 15, textTransform: "uppercase" }}>{sp.name}</b> <span style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--mut)" }}>{TIER_LABEL[sp.tier] || sp.tier}</span></span>
                <span className="mono" style={{ color: "var(--ink)" }}>{money(sp.value)}/yr</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, gap: 10 }}>
                <span style={{ fontSize: 12 }}>{sp.askLabel} <span style={{ color: "var(--mut)" }}>· bonus {money(sp.bonus)}</span></span>
                {askPill(sp)}
              </div>
              {atRisk && <div style={{ fontSize: 11, color: "var(--red)", fontWeight: 700, marginTop: 4 }}>⚠ Last warning — miss this again and {sp.name} walks (−{sp.tier === "title" ? "huge" : "some"} board confidence{sp.tier === "title" ? " + lost title funding" : ""}).</div>}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 7 }}>
                <span style={{ fontSize: 11, color: expired ? "var(--amber)" : "var(--mut)" }}>{expired ? "Contract expired — renew or replace" : `${sp.years}y left${sp.patience != null && !sp.prog.met ? ` · patience ${sp.patience}` : ""}`}</span>
                <span style={{ display: "flex", gap: 6 }}>
                  {expired ? <button className="btn sm pri" onClick={() => doRenew(sp.id)}>Renew</button>
                           : <button className="btn sm" onClick={() => doBuyout(sp.id, sp.name)}>Buy out {money(sp.value * Math.max(1, sp.years) * 0.5)}</button>}
                </span>
              </div>
              </>}
            </div>); })}
        </div>
      </div>

      {showMarket && (
        <div className="dcard" style={{ marginTop: 14 }}>
          <h3>Sponsor market · {state.season}</h3>
          <div style={{ fontSize: 11.5, color: "var(--mut)", marginBottom: 8 }}>Bigger deals demand more. Sign into an open slot — buy out a current sponsor first to free one. {openSponsorSlots(t) === 0 ? "(No open slots right now.)" : `(${openSponsorSlots(t)} open slot${openSponsorSlots(t) > 1 ? "s" : ""}.)`}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px,1fr))", gap: 10 }}>
            {market.map((o) => { const canSign = openByTier(o.tier); return (
              <div key={o.id} style={{ padding: 11, border: "1px solid var(--line)", borderRadius: 9, background: "var(--card2)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><b style={{ fontFamily: "var(--fTitle)", fontSize: 14.5, textTransform: "uppercase" }}>{o.name}</b><span className="mono">{money(o.value)}/yr</span></div>
                <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--mut)", marginTop: 1 }}>{TIER_LABEL[o.tier] || o.tier} · {o.years}y</div>
                <div style={{ fontSize: 12, margin: "6px 0" }}>{labelAsk(o.ask)} <span style={{ color: "var(--mut)" }}>· bonus {money(o.bonus)}</span></div>
                <button className="btn sm pri" disabled={!canSign} title={canSign ? "" : "No open slot — buy out a sponsor first"} onClick={() => doSign(o.id, o.name)}>Sign</button>
              </div>); })}
          </div>
        </div>
      )}
    </div>
  );
}

const ROLE_OPTS = [["leader", "Team Leader"], ["coleader", "Co-Leader"], ["rotation", "Rotation"], ["domestique", "Domestique"], ["prospect", "Prospect"]];

function NegoModal({ state, rider, fee, onClose, onDone }) {
  const team = teamHeader(state);
  const init = contractDemand(state, team, rider, (rider.teamId === state.userTeamId && rider.status) ? rider.status : "rotation");
  const [wage, setWage] = React.useState(init.wage);
  const [years, setYears] = React.useState(init.years);
  const [role, setRole] = React.useState(init.role);
  const res = offerAcceptance(state, team, rider, { wage, years, role });
  const maxW = Math.max(init.wage * 1.6, (rider.value || 1) * 1.6, 1);
  const confirm = () => { completeTransfer(state, state.userTeamId, rider, fee || 0, { wage, years, role }); onDone(); };
  return (
    <div className="modal" onClick={onClose}><div className="sheet" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
      <div className="ph">Contract terms · {rider.short}</div>
      <div style={{ padding: 16, fontSize: 13 }}>
        {fee ? <div style={{ marginBottom: 10, color: "var(--mut)" }}>Transfer fee agreed: <b className="mono" style={{ color: "var(--ink)" }}>{money(fee)}</b></div> : null}
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span>Annual wage</span><b className="mono">{money(wage)}/yr</b></div>
          <input type="range" min={0.05} max={Math.round(maxW * 20) / 20} step={0.05} value={wage} onChange={(e) => setWage(+e.target.value)} style={{ width: "100%" }} />
        </div>
        <div style={{ display: "flex", gap: 16, marginBottom: 12, alignItems: "center" }}>
          <label style={{ fontSize: 12.5 }}>Length <select value={years} onChange={(e) => setYears(+e.target.value)} style={{ marginLeft: 6, padding: "3px 6px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--paper)" }}>{[1, 2, 3, 4, 5].map((y) => <option key={y} value={y}>{y}y</option>)}</select></label>
          <label style={{ fontSize: 12.5 }}>Squad role <select value={role} onChange={(e) => setRole(e.target.value)} style={{ marginLeft: 6, padding: "3px 6px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--paper)" }}>{ROLE_OPTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        </div>
        <div style={{ padding: "9px 11px", borderRadius: 8, background: res.accept ? "rgba(52,211,153,.12)" : "rgba(240,68,56,.13)", color: res.accept ? "#0a6e5c" : "#f3705f", fontSize: 12.5, fontWeight: 600 }}>
          {res.accept ? "✓ The rider accepts these terms." : `✗ ${res.reason}.`}
        </div>
      </div>
      <div style={{ padding: 12, borderTop: "1px solid var(--line)", display: "flex", justifyContent: "space-between" }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn pri" disabled={!res.accept} onClick={confirm}>Confirm signing</button>
      </div>
    </div></div>
  );
}

function BidModal({ state, rider, onClose, onAccepted }) {
  const ask = askingPrice(state, rider);
  const seller = state.teams[rider.teamId];
  const [fee, setFee] = React.useState(ask);
  const [msg, setMsg] = React.useState(null);
  const submit = () => { const r = evaluateBid(state, rider, fee); if (r.ok) { onAccepted(fee); return; } setMsg((r.reason || "Rejected") + (r.counter ? ` — valuation €${r.counter}M.` : ".")); if (r.counter) setFee(r.counter); };
  const maxF = Math.max(ask * 1.5, 1);
  return (
    <div className="modal" onClick={onClose}><div className="sheet" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
      <div className="ph">Bid for {rider.short}</div>
      <div style={{ padding: 16, fontSize: 13 }}>
        <div style={{ color: "var(--mut)", marginBottom: 10 }}>{seller?.name} · valued at <b className="mono" style={{ color: "var(--ink)" }}>{money(rider.value)}</b> · {rider.contractYears}y left · asking <b className="mono" style={{ color: "var(--ink)" }}>{money(ask)}</b></div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}><span>Your bid</span><b className="mono">{money(fee)}</b></div>
        <input type="range" min={0.1} max={Math.round(maxF * 10) / 10} step={0.1} value={fee} onChange={(e) => { setFee(+e.target.value); setMsg(null); }} style={{ width: "100%" }} />
        {msg && <div style={{ marginTop: 10, padding: "9px 11px", borderRadius: 8, background: "rgba(240,68,56,.13)", color: "#f3705f", fontSize: 12.5, fontWeight: 600 }}>{msg}</div>}
      </div>
      <div style={{ padding: 12, borderTop: "1px solid var(--line)", display: "flex", justifyContent: "space-between" }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn pri" onClick={submit}>Submit bid</button>
      </div>
    </div></div>
  );
}

function Transfers({ state, refresh }) {
  const t = teamHeader(state);
  const [view, setView] = React.useState("free");
  const [detail, setDetail] = React.useState(null);
  const [bid, setBid] = React.useState(null);
  const [nego, setNego] = React.useState(null);
  const [offers, setOffers] = React.useState(null);
  const proj = t.sponsors.reduce((s, sp) => s + sp.value, 0) - (t.salaryTotal || 0);
  const faAll = freeAgents(state);
  const baseList = view === "sell" ? t.riderIds.map((id) => state.riders[id]).filter(Boolean)
    : view === "free" ? faAll
    : Object.values(state.riders).filter((r) => r.teamId != null && r.teamId !== state.userTeamId && !r.dev);
  const { list, toolbar, th } = useTableTools(baseList, { tags: RIDER_TAGS, sorts: RIDER_SORTS, search: (r) => r.name + " " + (r.nation || ""), ctx: { state } });

  const getOffers = (r) => { setTransferListed(state, r, true); setOffers({ rider: r, list: solicitOffers(state, r) }); refresh(); };

  return (
    <div className="card">
      <div className="ph">Transfers · {t.name}<span className="mono" style={{ letterSpacing: 0 }}>{t.riderIds.length}/11 · cash {money(t.budget)} · room {money(proj)}/yr</span></div>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div className="seg">{[["free", `Free agents (${faAll.length})`], ["buy", "Buy"], ["sell", "Sell"]].map(([k, l]) => <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{l}</button>)}</div>
        <span style={{ fontSize: 11, color: "var(--mut)" }}>{view === "free" ? "Out-of-contract — free, just agree terms." : view === "buy" ? "Under contract — agree a fee, then personal terms." : "List your riders and field offers."}</span>
      </div>
      <div style={{ padding: "0 12px" }}>{toolbar}</div>
      <div style={{ maxHeight: 470, overflowY: "auto" }}>
        {view === "sell" ? (
          <table className="tbl"><thead><tr><th></th>{th("Rider")}{th("Type")}{th("OVR", "Overall", { className: "num" })}{th("Age", "Age", { className: "num" })}{th("CLI", "Climbing", { className: "num" })}{th("PUN", "Punch", { className: "num" })}{th("SPR", "Sprint", { className: "num" })}{th("TT", "Time-trial", { className: "num" })}{th("COB", "Cobbles", { className: "num" })}<th className="num">Wage</th><th className="num">Yrs</th>{th("Value", "Value", { className: "num" })}<th></th></tr></thead><tbody>
            {list.map((r) => (<tr key={r.id} className={r.transferListed ? "win" : ""}>
              <td><Face rider={r} size={26} /></td><td style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setDetail(r)}>{r.short}</td><td><Tag a={r.archetype} /></td>
              <td className="num"><Ovr o={r.overall} /></td><td className="num mono">{r.age}</td>
              <td className="num mono">{r.abil?.climbing || 0}</td><td className="num mono">{r.abil?.punch || 0}</td><td className="num mono">{r.abil?.sprint || 0}</td><td className="num mono">{r.abil?.timetrial || 0}</td><td className="num mono">{r.abil?.cobbles || 0}</td>
              <td className="num mono">{money(r.salary)}</td><td className="num mono">{r.contractYears}</td><td className="num mono">{money(r.value)}</td>
              <td><button className="btn sm pri" onClick={() => getOffers(r)}>Get offers</button></td>
            </tr>))}
          </tbody></table>
        ) : (
          <table className="tbl"><thead><tr><th></th>{th("Rider")}{th("Nat")}{th("Type")}{th("OVR", "Overall", { className: "num" })}{th("POT", "Potential", { className: "num" })}{th("Age", "Age", { className: "num" })}{th("CLI", "Climbing", { className: "num" })}{th("PUN", "Punch", { className: "num" })}{th("SPR", "Sprint", { className: "num" })}{th("TT", "Time-trial", { className: "num" })}{th("COB", "Cobbles", { className: "num" })}{th(view === "buy" ? "Asking" : "Wants", "Value", { className: "num" })}<th></th></tr></thead><tbody>
            {list.slice(0, 70).map((r) => { const kp = knownPotential(r);
              return <tr key={r.id}>
                <td><Face rider={r} size={26} /></td><td style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setDetail(r)}>{r.short}</td>
                <td className="mono" style={{ fontSize: 11, color: "var(--mut)" }}>{r.nation}</td><td><Tag a={r.archetype} /></td>
                <td className="num"><Ovr o={r.overall} /></td>
                <td className="num mono" style={{ color: r.potential > r.overall + 4 ? "var(--green)" : "var(--mut)" }}>{kp.unknown ? "?" : kp.mid}</td>
                <td className="num mono">{r.age}</td>
                <td className="num mono">{r.abil?.climbing || 0}</td>
                <td className="num mono">{r.abil?.punch || 0}</td>
                <td className="num mono">{r.abil?.sprint || 0}</td>
                <td className="num mono">{r.abil?.timetrial || 0}</td>
                <td className="num mono">{r.abil?.cobbles || 0}</td>
                <td className="num mono">{view === "buy" ? money(askingPrice(state, r)) : money(r.value)}</td>
                <td>{view === "free" ? <button className="btn sm pri" disabled={t.riderIds.length >= 11} onClick={() => setNego({ rider: r, fee: 0 })}>Sign</button>
                  : <button className="btn sm pri" disabled={t.riderIds.length >= 11} onClick={() => setBid(r)}>Bid</button>}</td>
              </tr>; })}
          </tbody></table>
        )}
        {list.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "var(--mut)" }}>No riders match.</div>}
      </div>
      {bid && <BidModal state={state} rider={bid} onClose={() => setBid(null)} onAccepted={(fee) => { const r = bid; setBid(null); setNego({ rider: r, fee }); }} />}
      {nego && <NegoModal state={state} rider={nego.rider} fee={nego.fee} onClose={() => setNego(null)} onDone={() => { setNego(null); recountTeam(state); refresh(); }} />}
      {offers && (
        <div className="modal" onClick={() => { setOffers(null); refresh(); }}><div className="sheet" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
          <div className="ph">Offers for {offers.rider.short}</div>
          <div style={{ padding: 16 }}>
            {offers.list.length === 0 ? <div style={{ color: "var(--mut)", fontSize: 13 }}>No clubs are interested at his valuation right now. He stays transfer-listed.</div> : offers.list.map((o, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #262c36" }}>
                <span>{o.teamName}</span><span style={{ display: "flex", gap: 10, alignItems: "center" }}><b className="mono">{money(o.fee)}</b><button className="btn sm pri" onClick={() => { acceptSale(state, offers.rider, o); setOffers(null); recountTeam(state); refresh(); }}>Accept</button></span>
              </div>
            ))}
          </div>
          <div style={{ padding: 12, borderTop: "1px solid var(--line)", display: "flex", justifyContent: "space-between" }}>
            <button className="btn" onClick={() => { setTransferListed(state, offers.rider, false); setOffers(null); refresh(); }}>Unlist</button>
            <button className="btn" onClick={() => { setOffers(null); refresh(); }}>Keep listed</button>
          </div>
        </div></div>
      )}
      {detail && <RiderModal state={state} rider={detail} onClose={() => setDetail(null)} godMode={false} refresh={refresh} />}
    </div>
  );
}

const SWAP_UI = 3; // teams promoted/relegated per tier (matches engine SWAP_N)
function Standings({ state }) {
  const [tab, setTab] = React.useState("riders");
  const [tier, setTier] = React.useState(state.teams[state.userTeamId].tier);
  const [detail, setDetail] = React.useState(null);
  const rs = riderStandings(state, 40), ts = tab === "teams" ? tierStandings(state, tier) : [];
  return (
    <div className="card">
      <div className="ph">Season ranking · {state.season}<div className="seg"><button className={tab === "riders" ? "on" : ""} onClick={() => setTab("riders")}>Riders</button><button className={tab === "teams" ? "on" : ""} onClick={() => setTab("teams")}>Teams</button></div></div>
      {tab === "teams" && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)", display: "flex", gap: 6 }}>
          {TIERS.map((tr) => <button key={tr} className={"btn sm" + (tier === tr ? " pri" : "")} onClick={() => setTier(tr)}>{tr}{tr === state.teams[state.userTeamId].tier ? " ★" : ""}</button>)}
        </div>
      )}
      <div style={{ maxHeight: 540, overflowY: "auto" }}>
        {tab === "riders" ? (
          <table className="tbl"><thead><tr><th className="num">#</th><th>Rider</th><th>Team</th><th>Type</th><th className="num">Age</th><th className="num">Pts</th></tr></thead><tbody>
            {rs.map((x, i) => { const r = state.riders[x.lid]; if (!r) return null; const isMe = r.teamId === state.userTeamId; return <tr key={x.lid} className={isMe ? "me" : ""}><td className="num mono" style={{ color: "var(--mut)" }}>{i + 1}</td><td style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setDetail(r)}><span className="chip" style={{ background: r.jersey, marginRight: 6 }} />{r.short}</td><td style={{ color: "var(--mut)" }}>{state.teams[r.teamId]?.name}</td><td><Tag a={r.archetype} /></td><td className="num mono">{r.age}</td><td className="num mono">{x.pts}</td></tr>; })}
          </tbody></table>
        ) : (
          <table className="tbl"><thead><tr><th className="num">#</th><th>Team</th><th className="num">Prestige</th><th className="num">Pts</th></tr></thead><tbody>
            {ts.map((x, i) => { const tm = state.teams[x.id]; const isMe = x.id === state.userTeamId; const relzone = i >= ts.length - SWAP_UI && tier !== "Continental"; const promzone = i < SWAP_UI && tier !== "WorldTour"; return <tr key={x.id} className={isMe ? "me" : ""}><td className="num mono" style={{ color: promzone ? "var(--green)" : relzone ? "#f3705f" : "var(--mut)" }}>{i + 1}{promzone ? " ▲" : relzone ? " ▼" : ""}</td><td><span className="chip" style={{ background: tm.jersey, marginRight: 6 }} />{tm.name}</td><td className="num mono">{tm.prestige}</td><td className="num mono">{x.pts}</td></tr>; })}
          </tbody></table>
        )}
      </div>
      {tab === "teams" && <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--mut)", borderTop: "1px solid var(--line)" }}>▲ promotion · ▼ relegation — top/bottom {SWAP_UI} move at season's end.</div>}
      {detail && <RiderModal state={state} rider={detail} onClose={() => setDetail(null)} godMode={false} refresh={() => {}} />}
    </div>
  );
}

function SeasonPlan({ state, refresh }) {
  const [detail, setDetail] = React.useState(null);
  const [msg, setMsg] = React.useState(null);
  const t = state.teams[state.userTeamId];
  const wkNow = state.calendar[state.calIndex]?.week || 0;
  const squad = t.riderIds.map((id) => state.riders[id]).filter(Boolean);
  const maxWk = Math.max(...state.calendar.map((r) => r.week), 1);
  const { list: riders, toolbar } = useTableTools(squad, { tags: RIDER_TAGS, sorts: RIDER_SORTS, search: (r) => r.name + " " + (r.nation || ""), ctx: { state, week: wkNow }, defaultSort: 2 });

  // plan-health KPIs over the full squad (not the filtered view)
  const planned = squad.filter((r) => (r.plan?.targets || []).length > 0).length;
  const allPlanned = planned === squad.length && squad.length > 0;
  const peaks = squad.reduce((s, r) => s + (r.plan?.targets || []).length, 0);
  const peakingNow = squad.filter((r) => periodizedForm(state, r, wkNow).phase === "peak").length;

  const THEME_COL = { climb: "var(--green)", tt: "var(--purple)", sprint: "var(--cyan)", allround: "var(--blue)" };
  const phaseCol = (p) => p === "peak" ? "var(--gold)" : p === "build" ? "var(--blue)" : p === "trough" ? "var(--hot)" : "var(--mut)";
  const doAuto = (fillOnly) => { const n = autoPlanUser(state, { fillOnly }); setMsg(fillOnly ? `Filled ${n} rider${n !== 1 ? "s" : ""} that had no plan.` : `Auto-planned all ${n} riders.`); refresh(); };

  const Kpi = ({ label, value, sub, accent }) => (
    <div style={{ flex: 1, minWidth: 150, background: "var(--card2)", border: `1px solid ${accent || "var(--line)"}`, borderLeft: `3px solid ${accent || "var(--line)"}`, borderRadius: 12, padding: "11px 14px" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".11em", color: "var(--mut)", fontWeight: 800 }}>{label}</div>
      <div style={{ fontFamily: "var(--fTitle)", fontSize: 28, fontWeight: 700, lineHeight: 1.08, marginTop: 3 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, marginTop: 2, color: accent || "var(--mut)" }}>{sub}</div>}
    </div>
  );
  const Timeline = ({ r }) => {
    const ts = (r.plan?.targets || []).map((tg) => ({ wk: state.calendar[tg.calIndex]?.week, theme: tg.theme, name: state.calendar[tg.calIndex]?.name })).filter((x) => x.wk != null);
    return (
      <div style={{ position: "relative", height: 16, background: "rgba(255,255,255,.04)", border: "1px solid var(--line)", borderRadius: 5 }} title={ts.length ? ts.map((x) => `wk${x.wk} · ${x.name} (${x.theme})`).join("\n") : "no targets set"}>
        <div style={{ position: "absolute", left: `${(wkNow / maxWk) * 100}%`, top: -2, bottom: -2, width: 1.5, background: "var(--ink)", opacity: .5 }} />
        {ts.map((x, i) => <span key={i} style={{ position: "absolute", left: `calc(${(x.wk / maxWk) * 100}% - 5px)`, top: "50%", transform: "translateY(-50%) rotate(45deg)", width: 9, height: 9, borderRadius: 2, background: THEME_COL[x.theme] || "var(--blue)", border: "1px solid var(--bg)" }} />)}
      </div>
    );
  };
  const slotSel = (r, slot) => {
    const tg = r.plan?.targets?.[slot];
    return <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
      <select className="sel" value={tg ? tg.calIndex : ""} onChange={(e) => { const v = e.target.value; setRiderTarget(state, r, slot, v === "" ? null : +v, tg?.theme || "allround"); refresh(); }} style={{ maxWidth: 150 }}>
        <option value="">— none —</option>
        {state.calendar.map((race, ci) => <option key={ci} value={ci}>wk{race.week} · {race.name}</option>)}
      </select>
      {tg && <select className="sel" value={tg.theme} onChange={(e) => { setRiderTarget(state, r, slot, tg.calIndex, e.target.value); refresh(); }} style={{ width: 88 }}>{PEAK_THEMES.map((th) => <option key={th.key} value={th.key}>{th.label}</option>)}</select>}
    </div>;
  };

  return <div className="card">
    <div className="ph">Season plan · periodization<span className="mono" style={{ letterSpacing: 0 }}>wk {wkNow} · {state.season}</span></div>

    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", padding: "12px 12px 4px" }}>
      <Kpi label="Riders planned" value={<>{planned}<span style={{ fontSize: 15, color: "var(--mut)" }}>/{squad.length}</span></>} sub={allPlanned ? "all riders covered" : `${squad.length - planned} without a plan`} accent={allPlanned ? "var(--green)" : "var(--amber)"} />
      <Kpi label="Peaks scheduled" value={peaks} sub={`across ${squad.length} riders`} />
      <Kpi label="Peaking this week" value={peakingNow} sub={peakingNow ? "in form now" : "none at peak"} accent={peakingNow ? "var(--gold)" : null} />
    </div>

    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 12px" }}>
      <button className="btn sm pri" onClick={() => doAuto(false)}>Auto-plan all</button>
      <button className="btn sm" disabled={allPlanned} onClick={() => doAuto(true)}>Fill gaps{allPlanned ? "" : ` (${squad.length - planned})`}</button>
      <span style={{ flex: 1 }} />
      <span style={{ display: "flex", gap: 10, fontSize: 10.5, color: "var(--mut)", flexWrap: "wrap" }}>
        {PEAK_THEMES.map((th) => <span key={th.key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: THEME_COL[th.key], transform: "rotate(45deg)" }} />{th.label}</span>)}
      </span>
    </div>
    {msg && <div style={{ margin: "2px 12px 0", padding: "7px 11px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "color-mix(in srgb, var(--green) 12%, transparent)", color: "var(--green)", border: "1px solid color-mix(in srgb, var(--green) 30%, transparent)" }}>{msg}<span style={{ float: "right", cursor: "pointer", color: "var(--mut)" }} onClick={() => setMsg(null)}>×</span></div>}

    <div style={{ padding: "8px 12px 0", fontSize: 11.5, color: "var(--mut)" }}>Target up to two races per rider and pick the peak focus. Fitness builds toward each target, peaks for it, then dips into a trough — so space your two peaks out. The bar is the season; ◆ marks a peak, the line is this week.</div>
    <div style={{ padding: "6px 12px 0" }}>{toolbar}</div>
    <div style={{ maxHeight: 520, overflowY: "auto" }}><table className="tbl">
      <thead><tr><th></th><th>Rider</th><th>Form</th><th>Fatigue</th><th style={{ minWidth: 160 }}>Season</th><th>Peak 1</th><th>Peak 2</th></tr></thead>
      <tbody>{riders.map((r) => { const pf = periodizedForm(state, r, wkNow); const col = phaseCol(pf.phase); const noPlan = !(r.plan?.targets || []).length;
        const plannedGTs = (r.plan?.targets || []).filter((tg) => state.calendar[tg.calIndex]?.grand).length; const gtCap = gtCapFor(r); const overGT = plannedGTs > gtCap;
        return <tr key={r.id} style={noPlan ? { background: "color-mix(in srgb, var(--amber) 7%, transparent)" } : null}>
          <td style={{ width: 28 }}><Face rider={r} size={26} /></td>
          <td style={{ cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap" }} onClick={() => setDetail(r)}>{r.short} <Tag a={r.archetype} />{noPlan && <span title="No plan set" style={{ marginLeft: 5, fontSize: 8.5, fontWeight: 800, color: "var(--bg)", background: "var(--amber)", borderRadius: 4, padding: "1px 4px", verticalAlign: "middle" }}>NO PLAN</span>}{overGT && <span title={`Planned for ${plannedGTs} Grand Tours but can only start ${gtCap} (recovery ${r.abil?.recovery ?? 60})`} style={{ marginLeft: 5, fontSize: 8.5, fontWeight: 800, color: "var(--bg)", background: "var(--red)", borderRadius: 4, padding: "1px 4px", verticalAlign: "middle" }}>{plannedGTs}× GT &gt; {gtCap}</span>}</td>
          <td style={{ whiteSpace: "nowrap" }}><span className="mono" style={{ color: col, fontWeight: 700 }}>{pf.form}</span> <span style={{ fontSize: 10, color: col }}>{pf.phase}</span></td>
          <td><FatBar f={r.fatigue || 0} /></td>
          <td style={{ minWidth: 160 }}><Timeline r={r} /></td>
          <td>{slotSel(r, 0)}</td>
          <td>{slotSel(r, 1)}</td>
        </tr>; })}</tbody>
    </table></div>
    {detail && <RiderModal state={state} rider={detail} onClose={() => setDetail(null)} godMode={false} refresh={refresh} />}
  </div>;
}

function TourClassifications({ state, rec, onRider }) {
  const [tab, setTab] = React.useState("points");
  const tabs = [["points", "Points"], ["kom", "Mountains"], ["youth", "Youth"], ["teams", "Teams"]];
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        {tabs.map(([k, l]) => <button key={k} className={"btn sm" + (tab === k ? " pri" : "")} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <table className="tbl"><tbody>
        {tab !== "teams" && (rec[tab] || []).slice(0, 10).map((x, i) => { const r = state.riders[x.lid]; if (!r) return null; return (
          <tr key={x.lid} className={i === 0 ? "win" : ""}><td className="num mono" style={{ width: 24 }}>{i + 1}</td>
            <td style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => onRider(r)}><span className="chip" style={{ background: r.jersey, marginRight: 6 }} />{r.short}</td>
            <td className="num mono">{tab === "youth" ? (i === 0 ? "leader" : "+" + Math.round(x.gap) + "s") : x.pts + " pts"}</td></tr>); })}
        {tab === "teams" && (rec.teamClass || []).slice(0, 10).map((t, i) => { const tm = state.teams[t.tid]; if (!tm) return null; return (
          <tr key={t.tid} className={i === 0 ? "win" : ""}><td className="num mono" style={{ width: 24 }}>{i + 1}</td>
            <td style={{ fontWeight: 600 }}><span className="chip" style={{ background: tm.jersey, marginRight: 6 }} />{tm.name}</td>
            <td className="num mono">{i === 0 ? "leader" : "+" + Math.round(t.gap) + "s"}</td></tr>); })}
      </tbody></table>
    </div>
  );
}
function RacePreview({ state, race, onClose }) {
  const { profile, favorites } = raceFavorites(state, race, 8);
  const out = teamOutlook(state, race);
  const T = profile.terrain;
  const COL = { climb: "#4a7c59", punch: "#c2783f", sprint: "#3f7cc2", cobbles: "#8a6d3b", gravel: "#b08442", tt: "#7a5fb0", flat: "#5a8aa0", descent: "#6b8f9c" };
  const L = ({ children }) => <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--mut)", margin: "0 0 5px" }}>{children}</div>;
  const Bar = ({ k, label }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
      <span style={{ width: 58, fontSize: 10.5, color: "var(--mut)", textAlign: "right" }}>{label}</span>
      <div style={{ flex: 1, height: 7, background: "var(--line)", borderRadius: 4, overflow: "hidden" }}><div style={{ width: T[k] + "%", height: "100%", background: COL[k] }} /></div>
      <span className="mono" style={{ width: 22, fontSize: 10 }}>{T[k]}</span>
    </div>
  );
  const odds = (i) => i === 0 ? "favourite" : i <= 2 ? "co-favourite" : i <= 5 ? "contender" : "outsider";
  const chanceColor = { "Contender": "#2fbf71", "Outside shot": "#f5a524", "Long shot": "#e08a3c", "Making up numbers": "var(--mut)" }[out.chance] || "var(--mut)";
  const catColor = { Monument: "var(--gold)", GT: "var(--gold)", Worlds: "var(--gold)", "WT-1day": "var(--blue)", "WT-stage": "var(--blue)", "Semi-classic": "var(--mut)" }[profile.cat] || "var(--mut)";
  return (
    <div className="modal" onClick={onClose}><div className="sheet" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
      <div className="ph">{race.name}<span className="mono" style={{ letterSpacing: 0 }}>wk {race.week} · {profile.country || "—"}</span></div>
      <div style={{ padding: 14, maxHeight: "70vh", overflowY: "auto" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          <span className="tierpill" style={{ background: catColor, color: catColor === "var(--gold)" ? "var(--bg)" : "#fff" }}>{profile.cat || "race"}</span>
          <span className="pill">prestige {profile.prestige}</span>
          <span className="pill">coef {profile.coef ?? "—"}</span>
          <span className="pill">≈ €{profile.purse ?? "?"}k</span>
          {profile.distanceKm ? <span className="pill">{profile.distanceKm}km{race.kind === "tour" ? ` · ${profile.stages} st` : ""}</span> : null}
        </div>
        <div style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: 12 }}>{profile.identity}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 18px", marginBottom: 10 }}>
          <Bar k="climb" label="Climb" /><Bar k="cobbles" label="Cobbles" />
          <Bar k="punch" label="Punch" /><Bar k="gravel" label="Gravel" />
          <Bar k="sprint" label="Sprint" /><Bar k="tt" label="Time trial" />
          <Bar k="flat" label="Flat" /><Bar k="descent" label="Descent" />
        </div>
        <div style={{ display: "flex", gap: 14, fontSize: 11, color: "var(--mut)", marginBottom: 12 }}>
          <span>weather risk <b style={{ color: profile.weatherRisk > 60 ? "var(--hot)" : "var(--ink)" }}>{profile.weatherRisk}</b></span>
          <span>attrition <b>{profile.attritionRisk}</b></span>
          <span>unpredictability <b>{profile.randomness}</b></span>
        </div>
        {race.kind === "tour" && (() => {
          const sm = race.stages.filter((s) => s.finishType === "summit").length;
          const it = race.stages.filter((s) => s.mode === "itt").length;
          const sp = race.stages.filter((s) => s.finishType === "flat" && !s.cobbles && s.mode !== "itt").length;
          const hl = race.stages.filter((s) => s.finishType === "hilly" || s.finishType === "uphill_short").length;
          return <div style={{ marginBottom: 12 }}><L>Stage breakdown</L><div style={{ fontSize: 12 }}>{sm} summit · {hl} hilly · {sp} bunch · {it} ITT — GC, points, mountains, youth &amp; team classifications all contested</div></div>;
        })()}
        {profile.sectors && profile.sectors.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <L>Key sectors</L>
            {profile.sectors.map((sec, i) => {
              const tag = { cobble: ["pavé", "#8a6d3b"], berg: ["berg", "#9c6b3f"], gravel: ["gravel", "#b08442"], climb: ["climb", "#4a7c59"], descent: ["descent", "#6b8f9c"] }[sec.kind] || ["sector", "#888"];
              return (
                <div key={i} style={{ padding: "4px 0", borderBottom: i < profile.sectors.length - 1 ? "1px solid var(--line)" : "none" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontSize: 8.5, fontWeight: 800, textTransform: "uppercase", color: "#fff", background: tag[1], padding: "1px 5px", borderRadius: 4 }}>{tag[0]}</span>
                    <b style={{ flex: 1, fontSize: 12 }}>{sec.name}</b>
                    <span className="mono" style={{ fontSize: 10, color: "var(--mut)" }}>{sec.toFinish <= 0.5 ? "at finish" : sec.toFinish + "km to go"}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--mut)", marginTop: 1 }}>{sec.lengthKm}km{sec.grad ? ` · ${sec.grad}%${sec.maxGrad ? ` (max ${sec.maxGrad}%)` : ""}` : ""}{sec.cat ? ` · cat ${sec.cat}` : ""}{sec.diff ? " · " + "★".repeat(sec.diff) : ""}{sec.crash ? " · crash " + "⚠".repeat(Math.min(3, sec.crash)) : ""} · tests {sec.affects.join(", ")}</div>
                </div>
              );
            })}
          </div>
        )}
        <div style={{ marginBottom: 12 }}>
          <L>Tactical demands</L>
          <div style={{ fontSize: 12 }}>{profile.tactics.join(" · ")}</div>
          <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 4 }}>Suits: {profile.archetypes.join(", ")}</div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <L>Pre-race favourites</L>
          <table className="tbl"><tbody>
            {favorites.map((f, i) => (<tr key={f.lid} className={i === 0 ? "win" : ""}>
              <td className="num mono" style={{ width: 20 }}>{i + 1}</td>
              <td><span className="chip" style={{ background: f.jersey, marginRight: 6 }} />{f.name}</td>
              <td style={{ fontSize: 10.5, color: "var(--mut)" }}>{f.why}</td>
              <td className="mono" style={{ fontSize: 10, textAlign: "right", color: f.fogged ? "var(--mut)" : "var(--ink)" }}>{f.fogged ? odds(i) : f.fit}</td>
            </tr>))}
          </tbody></table>
        </div>
        <div style={{ paddingTop: 10, borderTop: "1px solid var(--line)" }}>
          <L>{state.teams[state.userTeamId].name} — your chances</L>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ fontWeight: 800, color: chanceColor }}>{out.chance}</span>
            {out.leader && <span style={{ fontSize: 12 }}>leader <b>{out.leader.name}</b> · fit {out.leader.fit} · form {out.leader.form}</span>}
          </div>
          {out.risks.length > 0 && <div style={{ fontSize: 11, color: "#f5a524", marginBottom: 8 }}>⚠ {out.risks.join(" · ")}</div>}
          <L>Suggested lineup</L>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {out.lineup.map((l) => (<span key={l.lid} style={{ fontSize: 11, padding: "2px 7px", borderRadius: 5, background: "var(--line)" }}>{l.name} <span style={{ color: "var(--mut)" }}>· {l.role} · {l.fit}</span></span>))}
          </div>
        </div>
      </div>
      <div style={{ padding: 12, textAlign: "right", borderTop: "1px solid var(--line)" }}><button className="btn" onClick={onClose}>Close</button></div>
    </div></div>
  );
}

// shared race-result overlay — stage/GC classification, gaps, jersey winners (reused by Calendar + Inbox)
function ResultModal({ state, rec, onClose, onRider }) {
  if (!rec) return null;
  const nameCell = (r) => <td style={{ cursor: r ? "pointer" : "default", fontWeight: r ? 600 : 400 }} onClick={() => r && onRider && onRider(r)}>{r?.short || "?"}</td>;
  return (
    <div className="modal" onClick={onClose}><div className="sheet" onClick={(e) => e.stopPropagation()}>
      <div className="ph">{rec.name} · {rec.season}</div>
      <div style={{ padding: 14 }}>
        {rec.gc ? (<><div style={{ fontWeight: 700, marginBottom: 6 }}>General classification</div><table className="tbl"><tbody>{rec.gc.slice(0, 12).map((g, i) => { const r = state.riders[g.lid]; return <tr key={g.lid} className={i === 0 ? "win" : ""}><td className="num mono" style={{ width: 24 }}>{i + 1}</td>{nameCell(r)}<td className="num mono">{i === 0 ? "leader" : "+" + Math.round(g.gap) + "s"}</td></tr>; })}</tbody></table></>)
          : rec.stageResults?.[0]?.top ? (<><div style={{ fontWeight: 700, marginBottom: 6 }}>Result</div><table className="tbl"><tbody>{rec.stageResults[0].top.map((p, i) => { const r = state.riders[p.lid]; return <tr key={p.lid} className={i === 0 ? "win" : ""}><td className="num mono" style={{ width: 24 }}>{i + 1}</td>{nameCell(r)}<td className="num mono">{i === 0 ? "win" : fmtGap(p.gapSec)}</td></tr>; })}</tbody></table></>)
          : <div style={{ color: "var(--mut)", fontSize: 13 }}>Result details unavailable.</div>}
        {rec.jerseys && (
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", marginBottom: 6 }}>Jersey winners</div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {[["#f1d23a", "#3a3320", "GC", rec.jerseys.gc], ["#2fbf71", "#06371f", "PTS", rec.jerseys.points], ["#d7263d", "#fff", "KOM", rec.jerseys.kom], ["#eef1f6", "#2a2f3a", "U25", rec.jerseys.youth]].map(([c, ink, lab, lid], i) => { const r = lid != null && state.riders[lid]; return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 7 }}><span style={{ width: 22, height: 22, borderRadius: 6, background: c, color: ink, fontSize: 8.5, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(0,0,0,.2)" }}>{lab}</span><span style={{ cursor: r ? "pointer" : "default", fontWeight: 600, fontSize: 12.5 }} onClick={() => r && onRider && onRider(r)}>{r ? r.short : "—"}</span></div>
              ); })}
              {rec.jerseys.teams != null && (() => { const tm = state.teams[rec.jerseys.teams]; return tm ? (
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}><span style={{ width: 22, height: 22, borderRadius: 6, background: "#3a6ea5", color: "#fff", fontSize: 8.5, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid rgba(0,0,0,.2)" }}>TEAM</span><span style={{ fontWeight: 600, fontSize: 12.5 }}>{tm.shortName || tm.name}</span></div>
              ) : null; })()}
            </div>
          </div>
        )}
        {rec.gc && rec.points && <TourClassifications state={state} rec={rec} onRider={onRider} />}
      </div>
      <div style={{ padding: 12, textAlign: "right", borderTop: "1px solid var(--line)" }}><button className="btn" onClick={onClose}>Close</button></div>
    </div></div>
  );
}
function Calendar({ state, skipTo }) {
  const [open, setOpen] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
  const [skipAsk, setSkipAsk] = React.useState(null);
  const askSkip = (i, name) => { const w = (typeof skipWarnings === "function") ? skipWarnings(state, i) : []; if (w.length) setSkipAsk({ i, name, w }); else skipTo(i); };
  const [detail, setDetail] = React.useState(null);
  const nameCell = (r) => <td style={{ cursor: r ? "pointer" : "default", fontWeight: r ? 600 : 400 }} onClick={() => r && setDetail(r)}>{r?.short || "?"}</td>;
  const stLabel = (st) => st.mode === "itt" ? "time trial" : st.cobbles >= 0.8 ? "cobbles" : st.cobbles ? "gravel" : st.wind ? "crosswind" : st.finishType.replace("_", " ");
  const myTargets = {};
  for (const id of state.teams[state.userTeamId].riderIds) { const r = state.riders[id]; for (const t of (r?.plan?.targets || [])) (myTargets[t.calIndex] = myTargets[t.calIndex] || []).push(`${r.short} (${t.theme})`); }
  const { list, toolbar, th } = useTableTools(state.calendar, { tags: RACE_TAGS, sorts: RACE_SORTS, search: (r) => r.name + " " + (r.country || ""), ctx: {} });
  return (
    <div className="card">
      <div className="ph">Calendar · {state.season}</div>
      <div style={{ padding: "0 12px" }}>{toolbar}</div>
      <div style={{ maxHeight: 560, overflowY: "auto" }}>
        <table className="tbl"><thead><tr>{th("Wk", "Date", { className: "num" })}{th("Race")}<th>Type</th><th>Winner</th><th></th></tr></thead><tbody>
          {list.map((race) => { const i = state.calendar.indexOf(race); const rec = state.results[race.id]; const wr = rec && state.riders[rec.winnerLid]; const isNext = i === state.calIndex;
            return <tr key={race.id} className={isNext ? "win" : ""}>
              <td className="num mono" style={{ color: "var(--mut)" }}>{race.week}</td>
              <td style={{ fontWeight: isNext ? 700 : 600, fontFamily: "var(--fTitle)", fontSize: 15 }}>{race.name}{race.grand ? <span className="tierpill" style={{ background: "var(--gold)", color: "var(--bg)", marginLeft: 7, fontSize: 8.5, padding: "1px 6px" }}>GT</span> : null}{myTargets[i] && <span title={"Target: " + myTargets[i].join(", ")} style={{ marginLeft: 7, fontSize: 9.5, fontWeight: 800, color: "var(--gold)" }}>▲{myTargets[i].length}</span>}</td>
              <td style={{ color: "var(--mut)" }}>{race.kind === "tour" ? (() => { const m = race.stages.filter((s) => s.finishType === "summit").length, it = race.stages.filter((s) => s.mode === "itt").length; return `${race.stages.length}-stage${m ? ` · ${m} mtn` : ""}${it ? ` · ${it} ITT` : ""}`; })() : stLabel(race.stages[0])}</td>
              <td>{wr ? <span style={{ cursor: "pointer" }} onClick={() => setDetail(wr)}><span className="chip" style={{ background: wr.jersey, marginRight: 6 }} />{wr.short}</span> : isNext ? <span className="pill">next</span> : <span style={{ color: "var(--mut)" }}>—</span>}</td>
              <td>{rec ? <button className="btn sm" onClick={() => setOpen(rec)}>result</button> : <span style={{ display: "flex", gap: 5, justifyContent: "flex-end" }}><button className="btn sm" onClick={() => setPreview(race)}>preview</button>{i > state.calIndex && skipTo && <button className="btn sm" title="Auto-race everything up to here" onClick={() => askSkip(i, race.name)}>skip to</button>}</span>}</td>
            </tr>; })}
        </tbody></table>
      </div>
      {open && <ResultModal state={state} rec={open} onClose={() => setOpen(null)} onRider={setDetail} />}
      {detail && <RiderModal state={state} rider={detail} onClose={() => setDetail(null)} godMode={false} refresh={() => {}} />}
      {preview && <RacePreview state={state} race={preview} onClose={() => setPreview(null)} />}
      {skipAsk && (
        <div className="modal" onClick={() => setSkipAsk(null)}><div className="sheet" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
          <div className="ph">Skip to {skipAsk.name}?</div>
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 12.5, marginBottom: 10, color: "var(--mut)" }}>The races in between will be auto-raced with your best available squad, then the season stops at {skipAsk.name}.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {skipAsk.w.map((x, k) => <div key={k} style={{ fontSize: 11.5, color: "var(--amber)" }}>⚠ {x}</div>)}
            </div>
          </div>
          <div style={{ padding: 12, display: "flex", gap: 8, justifyContent: "flex-end", borderTop: "1px solid var(--line)" }}>
            <button className="btn" onClick={() => setSkipAsk(null)}>Cancel</button>
            <button className="btn red" onClick={() => { const i = skipAsk.i; setSkipAsk(null); skipTo(i); }}>Auto-race &amp; skip →</button>
          </div>
        </div></div>
      )}
    </div>
  );
}

function History({ state }) {
  return (
    <div className="card">
      <div className="ph">Hall of champions</div>
      {state.history.length === 0 ? <div style={{ padding: 24, color: "var(--mut)" }}>No completed seasons yet.</div> : (
        <table className="tbl"><thead><tr><th>Season</th><th>Rider champion</th><th>Team champion</th></tr></thead><tbody>
          {state.history.slice().reverse().map((h) => <tr key={h.season}><td className="mono">{h.season}</td><td><b>{h.championName}</b></td><td>{h.teamChampionName}</td></tr>)}
        </tbody></table>
      )}
    </div>
  );
}

function OffSeason({ state, refresh, finalize }) {
  const t = state.teams[state.userTeamId];
  const os = state._os || (state._os = {});
  const step = state._osStep || 0;
  const setStep = (n) => { state._osStep = n; refresh(); };
  const [detail, setDetail] = React.useState(null);
  const [msg, setMsg] = React.useState(null);
  const expiring = t.riderIds.map((id) => state.riders[id]).filter((r) => r && r.contractYears <= 0);

  const doReview = () => { if (!os.review) { os.review = osReview(state); os.story = seasonStory(state, os.review.objective); } setStep(1); };
  const doYouth = () => { if (!os.youth) os.youth = osYouthRaces(state); setStep(2); };
  const doDevelop = () => { if (!os.closed) { osYouthClose(state); os.closed = true; } if (!os.dev) os.dev = osDevelop(state, state.trainingFocus || {}); setStep(3); };
  const doIntake = () => { if (!os.intake) os.intake = osIntake(state); setStep(4); };
  const doTransfers = () => { closeIntake(state, t); if (!os.trans) os.trans = osTransfers(state); setStep(5); };
  const doSponsors = () => setStep(6);
  const doFinish = () => { osFinish(state); state._os = null; state._osStep = 0; finalize(); };
  const spRenew = (id) => { const r = renegotiateSponsor(state, state.userTeamId, id); setMsg(r.ok ? { ok: 1, text: `Renewed ${r.sponsor.name} at ${money(r.sponsor.value)}/yr.` } : { ok: 0, text: r.reason }); refresh(); };
  const spBuyout = (id, nm) => { const r = buyoutSponsor(state, state.userTeamId, id); setMsg(r.ok ? { ok: 1, text: `Bought out ${nm} for ${money(r.fee)}.` } : { ok: 0, text: r.reason }); refresh(); };
  const spSign = (id, nm) => { const r = signSponsor(state, state.userTeamId, id); setMsg(r.ok ? { ok: 1, text: `Signed ${nm}!${r.teamName ? ` Team renamed to ${r.teamName}.` : ""}` } : { ok: 0, text: r.reason }); refresh(); };
  const doInvest = () => { const res = investYouth(state, t); setMsg(res.ok ? { ok: 1, text: `Academy upgraded to ${res.youthRating} (−${money(res.spent)}).` } : { ok: 0, text: res.reason }); refresh(); };
  const doSign = (lid) => { const res = signIntake(state, t, lid); if (!res.ok) setMsg({ ok: 0, text: res.reason }); refresh(); };

  const odds = (r) => Math.max(0.05, Math.min(0.95, 0.46 + (t.prestige - (r.prominence || 0) * 0.7) / 70 + ((r.know || 0) - 40) / 220));
  const headhunt = (r) => { const res = recruitProspect(state, t, r); setMsg(res.ok ? { ok: 1, text: `${r.short} signs for your academy!` } : res.reason === "academy full" ? { ok: 0, text: "Academy full (6)." } : res.sniped ? { ok: 0, text: `${r.short} signed for ${res.sniped}.` } : { ok: 0, text: `${r.short} turned you down.` }); refresh(); };
  const youthMarket = () => prospectPool(state, 30).filter((r) => r.teamId == null);

  const STEPS = ["Review", "Youth racing", "Headhunt", "Development", "Intake", "Transfers", "Sponsors"];
  const Stepper = () => <div style={{ display: "flex", gap: 4, padding: "10px 12px", borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
    {STEPS.map((s, i) => <span key={i} style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999, background: i === Math.min(step, STEPS.length - 1) ? "var(--ink)" : i < step ? "color-mix(in srgb, var(--green) 16%, transparent)" : "var(--line)", color: i === Math.min(step, STEPS.length - 1) ? "#fff" : i < step ? "var(--green)" : "var(--mut)" }}>{i < step ? "✓ " : ""}{s}</span>)}
  </div>;
  const Wrap = ({ title, children, foot }) => <div className="gm-wrap" style={{ paddingTop: 16, maxWidth: 860 }}><div className="card"><div className="ph">{title}<span className="mono" style={{ letterSpacing: 0 }}>off-season {state.season}</span></div><Stepper />{children}{foot}</div>{detail && <RiderModal state={state} rider={detail} onClose={() => setDetail(null)} godMode={false} refresh={refresh} />}</div>;
  const NextBtn = ({ on, children }) => <div style={{ padding: 12, borderTop: "1px solid var(--line)", textAlign: "right" }}><button className="btn red" onClick={on}>{children}</button></div>;

  // STEP 0 — intro + expiring contracts
  if (step === 0) return (
    <Wrap title={`${state.season} — end of season`}>
      <div style={{ padding: "12px 14px", fontSize: 13, color: "var(--mut)" }}>Before the winter: re-sign anyone you want to keep, and set each rider's <b>training focus</b> &amp; <b>altitude camp</b> on the Development tab. Then step through the off-season.</div>
      <div style={{ padding: "0 14px 12px" }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", fontWeight: 800, marginBottom: 6 }}>Expiring contracts ({expiring.length})</div>
        {expiring.length === 0 ? <div style={{ color: "var(--mut)", fontSize: 12.5 }}>No expiring contracts on your roster.</div> : (
          <table className="tbl"><tbody>{expiring.map((r) => <tr key={r.id}><td><Face rider={r} size={24} /></td><td style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setDetail(r)}>{r.short}</td><td><Tag a={r.archetype} /></td><td className="num"><Ovr o={r.overall} /></td><td className="num mono">{money(valueOf(r))}/yr</td><td><button className="btn sm pri" onClick={() => { signTo(state, t, r, 3); refresh(); }}>Re-sign 3y</button></td><td><button className="btn sm" onClick={() => { releaseFrom(state, t, r); recountTeam(state); refresh(); }}>Let go</button></td></tr>)}</tbody></table>
        )}
      </div>
      <NextBtn on={doReview}>Begin off-season →</NextBtn>
    </Wrap>
  );

  // STEP 1 — season story (recap + awards + state of the peloton + board verdict)
  if (step === 1) { const rv = os.review || {}; const story = os.story || seasonStory(state, rv.objective);
    const o = rv.objective;
    const vcol = o ? (o.verdict === "exceeded" || o.verdict === "met" ? "var(--green)" : o.verdict === "missed" ? "var(--amber)" : "var(--red)") : "var(--mut)";
    const ordn = (n) => { const t = n % 10, h = n % 100; return n + (t === 1 && h !== 11 ? "st" : t === 2 && h !== 12 ? "nd" : t === 3 && h !== 13 ? "rd" : "th"); };
    const Award = ({ a }) => (
      <div style={{ flex: 1, minWidth: 168, background: "var(--card2)", border: `1px solid ${a.me ? "color-mix(in srgb, var(--gold) 45%, var(--line))" : "var(--line)"}`, borderRadius: 12, padding: "11px 13px" }}>
        <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".11em", color: "var(--gold)", fontWeight: 800 }}>{a.title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "5px 0 3px" }}>{a.lid != null && <Face rider={state.riders[a.lid]} size={30} />}<div style={{ fontWeight: 800, fontSize: 14, cursor: a.lid != null ? "pointer" : "default" }} onClick={() => a.lid != null && setDetail(state.riders[a.lid])}>{a.name}</div></div>
        <div style={{ fontSize: 11, color: "var(--mut)", lineHeight: 1.4 }}>{a.cite}</div>
      </div>
    );
    const StandRow = ({ rank, name, team, pts, me, lid }) => (
      <tr className={me ? "me" : ""}><td className="num mono" style={{ width: 22, color: rank === 1 ? "var(--gold)" : "var(--mut)" }}>{rank}</td><td style={{ cursor: lid != null ? "pointer" : "default", fontWeight: me ? 700 : 600 }} onClick={() => lid != null && setDetail(state.riders[lid])}>{name}</td>{team !== undefined && <td style={{ fontSize: 11, color: "var(--mut)" }}>{team}</td>}<td className="num mono">{pts}</td></tr>
    );
    return <Wrap title={`${story.season} — season story`}>
      <div style={{ padding: 14, borderBottom: "1px solid var(--line)" }}>
        <div style={{ fontFamily: "var(--fTitle)", fontSize: 22, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>{story.headline}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 7, fontSize: 13, lineHeight: 1.55 }}>{story.recap.map((p, i) => <div key={i}>{p}</div>)}</div>
        {rv.moved && <div style={{ marginTop: 9, fontWeight: 800, fontSize: 13.5, color: TIERS.indexOf(rv.tierAfter) < TIERS.indexOf(rv.tierBefore) ? "var(--green)" : "var(--red)" }}>{TIERS.indexOf(rv.tierAfter) < TIERS.indexOf(rv.tierBefore) ? `▲ Promoted to ${rv.tierAfter}!` : `▼ Relegated to ${rv.tierAfter}`}</div>}
        {rv.finance && <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 6 }}>Budget <b className="mono" style={{ color: "var(--ink)" }}>{money(rv.finance.budget)}</b> · prize won {money(rv.finance.prizeYTD)}{rv.sponsorUnhappy && rv.sponsorUnhappy.length ? <span style={{ color: "var(--hot)" }}> · unhappy sponsor: {rv.sponsorUnhappy.join(", ")}</span> : ""}</div>}
      </div>
      {o && <div style={{ margin: "12px 14px 0", padding: "11px 14px", borderRadius: 10, background: `color-mix(in srgb, ${vcol} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${vcol} 33%, transparent)` }}>
        <div style={{ fontWeight: 800, color: vcol, textTransform: "uppercase", letterSpacing: ".05em", fontSize: 12 }}>Board verdict — objective {o.verdict}</div>
        <div style={{ fontSize: 12.5, color: "var(--mut)", margin: "3px 0 7px" }}>Brief: “{o.text}” — you finished {ordn(o.rank)} with {o.wins} win{o.wins !== 1 ? "s" : ""}.</div>
        <ConfBar v={o.confidence} />
        <div style={{ fontSize: 11.5, color: vcol, marginTop: 4, fontWeight: 600 }}>Confidence {o.delta >= 0 ? "+" : ""}{o.delta}</div>
      </div>}
      <div style={{ padding: "12px 14px 4px" }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", fontWeight: 800, marginBottom: 7 }}>Awards night</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{story.awards.map((a) => <Award key={a.key} a={a} />)}</div>
      </div>
      <div style={{ padding: "12px 14px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px,1fr))", gap: 16 }}>
        <div>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", fontWeight: 800, marginBottom: 5 }}>State of the peloton — teams</div>
          <table className="tbl"><tbody>{story.topTeams.map((t) => <StandRow key={t.rank} rank={t.rank} name={t.name} pts={t.pts} me={t.me} />)}</tbody></table>
        </div>
        <div>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", fontWeight: 800, marginBottom: 5 }}>Top riders</div>
          <table className="tbl"><tbody>{story.topRiders.map((r) => <StandRow key={r.rank} rank={r.rank} name={r.name} team={r.team} pts={r.pts} me={r.me} lid={r.lid} />)}</tbody></table>
        </div>
      </div>
      <NextBtn on={doYouth}>Next: youth racing →</NextBtn>
    </Wrap>;
  }

  // STEP 2 — youth races + headhunt
  if (step === 2) { const yr = os.youth || []; const mk = youthMarket();
    return <Wrap title="U23 racing & headhunting">
      {msg && <div style={{ margin: "10px 14px 0", padding: "7px 11px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: msg.ok ? "color-mix(in srgb, var(--green) 12%, transparent)" : "color-mix(in srgb, var(--red) 13%, transparent)", color: msg.ok ? "var(--green)" : "var(--hot)" }}>{msg.text}</div>}
      <div style={{ padding: "12px 14px" }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", fontWeight: 800, marginBottom: 6 }}>The U23 season — prominence won on the road</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px,1fr))", gap: 8, marginBottom: 12 }}>
          {yr.map((y, i) => <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "7px 9px", background: "var(--card2)" }}>
            <div style={{ fontWeight: 700, fontSize: 12 }}>{y.name}</div>
            {y.top.slice(0, 3).map((p) => { const r = state.riders[p.lid]; return <div key={p.lid} onClick={() => r && setDetail(r)} style={{ display: "flex", gap: 6, fontSize: 11.5, cursor: "pointer" }}><span className="mono" style={{ width: 14, color: p.place === 1 ? "var(--gold)" : "var(--mut)" }}>{p.place}</span><span style={{ flex: 1 }}>{r?.short}</span><span style={{ fontSize: 10, color: r?.teamId == null ? "var(--green)" : "var(--mut)" }}>{r?.teamId == null ? "free" : (state.teams[r?.teamId]?.name || "").slice(0, 10)}</span></div>; })}
          </div>)}
        </div>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", fontWeight: 800, marginBottom: 4 }}>Free youth — headhunt now, before rivals do (academy {(t.devIds || []).length}/6)</div>
        <div style={{ maxHeight: 240, overflowY: "auto" }}><table className="tbl"><tbody>
          {mk.slice(0, 18).map((r) => <tr key={r.id}>
            <td style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setDetail(r)}>{r.short}</td><td className="mono" style={{ fontSize: 11, color: "var(--mut)" }}>{r.nation}</td><td className="num mono">{r.age}</td><td><Tag a={r.archetype} /></td>
            <td className="num"><span className="mono" style={{ fontSize: 11, fontWeight: 700, color: (r.prominence || 0) >= 55 ? "var(--hot)" : (r.prominence || 0) >= 35 ? "var(--amber)" : "var(--mut)" }}>{(r.prominence || 0) >= 55 ? "🔥" : ""}{Math.round(r.prominence || 0)}</span></td>
            <td className="num mono" style={{ fontSize: 11, color: odds(r) >= 0.6 ? "var(--green)" : odds(r) >= 0.35 ? "var(--amber)" : "var(--red)" }}>{Math.round(odds(r) * 100)}%</td>
            <td><button className="btn sm pri" disabled={(t.devIds || []).length >= 6} onClick={() => headhunt(r)}>Headhunt</button></td>
          </tr>)}
        </tbody></table></div>
      </div>
      <NextBtn on={doDevelop}>Done — let rivals sign the rest →</NextBtn>
    </Wrap>;
  }

  // STEP 3 — development results + winter movers storyline
  if (step === 3) { const d = os.dev || { report: [], leagueBreakouts: [], risers: [], fallers: [], lateBlooms: [], stalled: [] };
    const Story = ({ label, color, items, line }) => items && items.length ? (
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".1em", color, fontWeight: 800, marginBottom: 3 }}>{label}</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--ink)" }}>{line(items)}</div>
      </div>
    ) : null;
    const nm = (m) => <span style={{ cursor: "pointer", fontWeight: 700 }} onClick={() => state.riders[m.lid] && setDetail(state.riders[m.lid])}>{m.short || m.name}</span>;
    const join = (items, fn) => items.map((m, i) => <span key={m.lid}>{i > 0 ? (i === items.length - 1 ? " and " : ", ") : ""}{fn(m)}</span>);
    return <Wrap title="Winter development">
      <div style={{ padding: "12px 14px" }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", fontWeight: 800, marginBottom: 6 }}>Your squad's winter</div>
        <div style={{ maxHeight: 260, overflowY: "auto" }}><table className="tbl"><tbody>
          {d.report.map((r) => <tr key={r.lid}>
            <td style={{ fontWeight: 600 }}>{r.short}{r.dev ? <span style={{ color: "var(--blue)", fontSize: 10 }}> ·academy</span> : ""}{r.alt ? <span style={{ color: "var(--green)", fontSize: 10 }}> ⛰</span> : ""}</td>
            <td><Tag a={r.archetype} /></td><td className="num mono">{r.age}</td>
            <td className="num"><Ovr o={r.overall} /></td>
            <td className="num mono" style={{ color: r.delta > 0 ? "var(--green)" : r.delta < 0 ? "var(--red)" : "var(--mut)", fontWeight: 700 }}>{r.delta > 0 ? "+" : ""}{r.delta} OVR</td>
            <td className="num mono" style={{ fontSize: 11, color: r.dWkg > 0 ? "var(--green)" : r.dWkg < 0 ? "var(--red)" : "var(--mut)" }}>{r.dWkg > 0 ? "+" : ""}{r.dWkg} w/kg</td>
            <td>{r.breakout ? <span style={{ color: "var(--hot)", fontWeight: 800, fontSize: 11 }}>BREAKOUT ★</span> : r.slump ? <span style={{ color: "var(--amber)", fontWeight: 800, fontSize: 11 }}>SLUMP ▼</span> : ""}</td>
          </tr>)}
        </tbody></table></div>

        <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
          <div style={{ fontFamily: "var(--fTitle)", fontSize: 16, fontWeight: 700, textTransform: "uppercase", marginBottom: 2 }}>Movers of the winter</div>
          <Story label="Risers" color="var(--green)" items={d.risers} line={(it) => <>The off-season's big climbers: {join(it.slice(0, 6), (m) => <>{nm(m)} <span style={{ color: "var(--green)", fontWeight: 700 }}>(+{m.delta}{m.mine ? ", yours" : `, ${m.team}`})</span></>)}.</>} />
          <Story label="Breakthroughs" color="var(--hot)" items={(d.risers || []).filter((m) => m.breakout)} line={(it) => <>A star is born — {join(it.slice(0, 4), (m) => <>{nm(m)} explodes to {m.overall} OVR</>)}.</>} />
          <Story label="Late bloomers" color="var(--blue)" items={d.lateBlooms} line={(it) => <>Proof it's never too late: {join(it, (m) => <>{nm(m)} ({m.age}) is still improving (+{m.delta})</>)}.</>} />
          <Story label="Stalling talent" color="var(--amber)" items={d.stalled} line={(it) => <>The hype that hasn't delivered: {join(it, (m) => <>{nm(m)}</>)} still waiting to click.</>} />
          <Story label="Fading" color="var(--mut)" items={d.fallers} line={(it) => <>Time catching up with {join(it.slice(0, 4), (m) => <>{nm(m)} ({m.delta})</>)}.</>} />
        </div>
      </div>
      <NextBtn on={doIntake}>Next: academy intake →</NextBtn>
    </Wrap>;
  }

  // STEP 4 — youth intake (reveal last year's previewed crop; pick who to sign; preview next year's)
  if (step === 4) {
    const ix = os.intake || {}; const rp = ix.revealedPreview, np = ix.nextPreview;
    const crop = (t.intakeCrop || []).map((lid) => state.riders[lid]).filter(Boolean);
    const slots = 6 - (t.devIds || []).length;
    const GRADE_COL = { exceptional: "var(--gold)", strong: "var(--green)", promising: "var(--green)", average: "var(--mut)", thin: "var(--amber)" };
    const Report = ({ r, lead }) => r ? (
      <div style={{ margin: "0 14px 12px", padding: "12px 14px", borderRadius: 10, background: (GRADE_COL[r.grade] || "#888") + "16", border: `1px solid ${(GRADE_COL[r.grade] || "#888")}44` }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".09em", color: "var(--mut)", fontWeight: 800 }}>{lead}</div>
        <div style={{ fontWeight: 800, color: GRADE_COL[r.grade] || "var(--ink)", margin: "3px 0 5px", fontSize: 14 }}>“{r.headline}”</div>
        {r.hints.map((h, i) => <div key={i} style={{ fontSize: 12, color: "var(--mut)", lineHeight: 1.5 }}>— {h}</div>)}
        <div style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 5, opacity: .7 }}>— Head of Youth Development</div>
      </div>
    ) : null;
    return <Wrap title="Academy intake">
      {msg && <div style={{ margin: "10px 14px 0", padding: "7px 11px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: msg.ok ? "color-mix(in srgb, var(--green) 12%, transparent)" : "color-mix(in srgb, var(--red) 13%, transparent)", color: msg.ok ? "var(--green)" : "var(--hot)" }}>{msg.text}</div>}
      <Report r={rp} lead="This year's intake — your head of youth's verdict" />
      <div style={{ padding: "0 14px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", fontWeight: 800, flex: 1 }}>The crop — sign who you want ({Math.max(0, slots)} slot{slots === 1 ? "" : "s"} free)</span>
        </div>
        {crop.length === 0 ? <div style={{ color: "var(--mut)", fontSize: 12.5, padding: "4px 0 10px" }}>You've signed all you can — the rest will move on.</div> : (
          <div style={{ maxHeight: 320, overflowY: "auto" }}><table className="tbl"><tbody>
            {crop.map((r) => { const ko = knownOverall(r), kp = knownPotential(r);
              return <tr key={r.id}>
                <td style={{ width: 28 }}><Face rider={r} size={26} /></td>
                <td style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setDetail(r)}>{r.short}</td>
                <td className="mono" style={{ fontSize: 11, color: "var(--mut)" }}>{r.nation}</td>
                <td className="num mono">{r.age}</td>
                <td><Tag a={r.archetype} /></td>
                <td className="num mono" style={{ fontSize: 11 }} title="known overall">{ko.exact ? ko.mid : `${ko.lo}–${ko.hi}`}</td>
                <td title="scouted potential"><StarRow cur={starOf(ko.mid)} pot={kp.unknown ? starOf(ko.mid) : starOf(kp.hi)} /></td>
                <td><button className="btn sm pri" disabled={slots <= 0} onClick={() => doSign(r.id)}>Sign</button></td>
              </tr>; })}
          </tbody></table></div>
        )}
      </div>
      <div style={{ margin: "4px 14px 12px", padding: "11px 13px", borderRadius: 10, background: "var(--card2)", border: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".09em", color: "var(--mut)", fontWeight: 800 }}>Youth academy</div>
          <div style={{ fontSize: 13, marginTop: 2 }}>Rating <b className="mono" style={{ color: (t.youthRating ?? 45) >= 75 ? "var(--green)" : (t.youthRating ?? 45) >= 55 ? "var(--amber)" : "var(--ink)" }}>{t.youthRating ?? 45}</b> · better facilities mean bigger, stronger future crops</div>
        </div>
        <button className="btn sm" onClick={doInvest}>Invest {money(youthUpgradeCost(t))} → +3</button>
      </div>
      <Report r={np} lead="Looking ahead — next year's crop" />
      <NextBtn on={doTransfers}>Next: transfers →</NextBtn>
    </Wrap>;
  }

  // STEP 5 — transfers & retirement tributes
  if (step === 5) {
  const tr = os.trans || { retired: [], tributes: [], moves: [] };
  const tributes = tr.tributes || [];
  const moves = tr.moves || [];
  const lead = { great: "A champion of the sport bows out", stalwart: "A dependable pro hangs up the wheels", journeyman: "Calling time" };
  const leadCol = { great: "var(--gold)", stalwart: "var(--blue)", journeyman: "var(--mut)" };
  const tribLine = (x) => {
    const bits = [`${x.seasons || "several"} season${x.seasons === 1 ? "" : "s"} as a pro`];
    if (x.wins) bits.push(`${x.wins} career win${x.wins !== 1 ? "s" : ""}`);
    if (x.best) bits.push(`crowned by victory at ${x.best}`);
    return `${bits.join(", ")}.`;
  };
  return <Wrap title="Transfers & farewells">
    <div style={{ padding: "12px 14px" }}>
      <div style={{ fontFamily: "var(--fTitle)", fontSize: 16, fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>The peloton says goodbye ({tributes.length})</div>
      {tributes.length === 0 ? <div style={{ color: "var(--mut)", fontSize: 12.5 }}>No notable retirements this winter.</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {tributes.slice(0, 10).map((x, i) => (
            <div key={i} style={{ padding: "9px 12px", borderRadius: 10, background: x.mine ? "color-mix(in srgb, var(--gold) 9%, transparent)" : "var(--card2)", border: `1px solid ${x.mine ? "color-mix(in srgb, var(--gold) 40%, var(--line))" : "var(--line)"}` }}>
              <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".1em", fontWeight: 800, color: leadCol[x.tier] }}>{lead[x.tier]}{x.mine ? " · one of yours" : ""}</div>
              <div style={{ fontWeight: 800, fontSize: 14, margin: "2px 0 2px" }}>{x.name} <span style={{ fontWeight: 400, fontSize: 11.5, color: "var(--mut)" }}>· {x.nation} · retires at {x.age}{x.team ? ` · ${x.team}` : ""}</span></div>
              <div style={{ fontSize: 12, color: "var(--mut)", lineHeight: 1.5 }}>{tribLine(x)}</div>
            </div>
          ))}
        </div>
      )}

      {moves.length > 0 && <>
        <div style={{ fontFamily: "var(--fTitle)", fontSize: 16, fontWeight: 700, textTransform: "uppercase", margin: "16px 0 6px" }}>Winter transfer market</div>
        <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>The winter's notable moves: {moves.map((m, i) => <span key={i}>{i > 0 ? ", " : ""}<b>{m.name}</b> → {m.to} <span style={{ color: "var(--mut)" }}>({m.overall})</span></span>)}.</div>
      </>}
      <div style={{ marginTop: 12, fontSize: 12, color: "var(--mut)" }}>Rivals have reshuffled their rosters and a fresh crop of neo-pros has turned professional. Next: square away your sponsors for the new season.</div>
    </div>
    <NextBtn on={doSponsors}>Next: sponsors →</NextBtn>
  </Wrap>;
  }

  // STEP 6 — sponsorship: renew/replace expiring deals, sign new ones (renames the team)
  const fin = teamFinances(state, state.userTeamId);
  const market = sponsorMarket(state, state.userTeamId);
  const TIERL = { title: "Title", co: "Co-sponsor", equipment: "Equipment" };
  const expiredSp = fin.sponsors.filter((s) => (s.years || 0) <= 0).length;
  return <Wrap title="Sponsorship">
    {msg && <div style={{ margin: "10px 14px 0", padding: "7px 11px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: `color-mix(in srgb, var(${msg.ok ? "--green" : "--red"}) 12%, transparent)`, color: msg.ok ? "var(--green)" : "var(--hot)" }}>{msg.text}<span style={{ float: "right", cursor: "pointer", color: "var(--mut)" }} onClick={() => setMsg(null)}>×</span></div>}
    <div style={{ padding: "12px 14px" }}>
      <div style={{ fontSize: 12.5, color: "var(--mut)", marginBottom: 10 }}>Your team is <b style={{ color: "var(--ink)" }}>{t.name}</b>. Co-sponsors pay far less than the title backer, and the team takes its name from the title (and lead co) sponsor — so signing a new headline backer renames the squad.{expiredSp ? ` ${expiredSp} contract${expiredSp > 1 ? "s have" : " has"} expired — renew or replace before the season opens.` : " All contracts are running."}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {fin.sponsors.map((sp) => { const exp = (sp.years || 0) <= 0; const vacant = !!sp.vacant;
          const atRisk = !vacant && !sp.prog.met && (sp.patience ?? 9) <= 1;
          return (
          <div key={sp.id} style={{ padding: 11, border: `1px solid ${vacant || atRisk ? "color-mix(in srgb, var(--red) 45%, var(--line))" : exp ? "color-mix(in srgb, var(--amber) 40%, var(--line))" : "var(--line)"}`, borderRadius: 9, background: "var(--card2)" }}>
            {vacant ? (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <b style={{ fontFamily: "var(--fTitle)", fontSize: 15, textTransform: "uppercase", color: "var(--red)" }}>Vacant {TIERL[sp.tier] || sp.tier} slot — sign a backer below</b>
              </div>
            ) : <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <span><b style={{ fontFamily: "var(--fTitle)", fontSize: 15, textTransform: "uppercase" }}>{sp.name}</b> <span style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--mut)" }}>{TIERL[sp.tier] || sp.tier}</span></span>
              <span className="mono">{money(sp.value)}/yr</span>
            </div>
            <div style={{ fontSize: 12, marginTop: 5 }}>{sp.askLabel} <span style={{ color: "var(--mut)" }}>· bonus {money(sp.bonus)}</span></div>
            {sp.ask?.text && <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 3, fontStyle: "italic" }}>“{sp.ask.text}”</div>}
            {atRisk && <div style={{ fontSize: 11, color: "var(--red)", fontWeight: 700, marginTop: 4 }}>⚠ Last warning — miss again and {sp.name} walks{sp.tier === "title" ? " (loses your title funding)" : ""}.</div>}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 7 }}>
              <span style={{ fontSize: 11, color: exp ? "var(--amber)" : "var(--mut)" }}>{exp ? "Expired" : `${sp.years}y left${sp.patience != null && !sp.prog.met ? ` · patience ${sp.patience}` : ""}`}</span>
              {exp ? <button className="btn sm pri" onClick={() => spRenew(sp.id)}>Renew</button>
                   : <button className="btn sm" onClick={() => spBuyout(sp.id, sp.name)}>Buy out {money(sp.value * Math.max(1, sp.years) * 0.5)}</button>}
            </div>
            </>}
          </div>); })}
      </div>
      <div style={{ fontFamily: "var(--fTitle)", fontSize: 15, fontWeight: 700, textTransform: "uppercase", margin: "16px 0 6px" }}>Sponsor market · {state.season + 1}</div>
      <div style={{ fontSize: 11.5, color: "var(--mut)", marginBottom: 8 }}>Sign into an open slot — buy out a current backer to free one. Bigger deals demand more.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px,1fr))", gap: 10 }}>
        {market.map((o) => (
          <div key={o.id} style={{ padding: 11, border: "1px solid var(--line)", borderRadius: 9, background: "var(--card2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><b style={{ fontFamily: "var(--fTitle)", fontSize: 14, textTransform: "uppercase" }}>{o.name}</b><span className="mono">{money(o.value)}/yr</span></div>
            <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--mut)", marginTop: 1 }}>{TIERL[o.tier] || o.tier} · {o.years}y</div>
            <div style={{ fontSize: 12, margin: "6px 0" }}>{labelAsk(o.ask)} <span style={{ color: "var(--mut)" }}>· bonus {money(o.bonus)}</span></div>
            <button className="btn sm pri" disabled={!fin.sponsors.some((s) => s.tier === o.tier && (s.years || 0) <= 0)} title={fin.sponsors.some((s) => s.tier === o.tier && (s.years || 0) <= 0) ? "" : `No open ${o.tier} slot — buy out your current ${o.tier} first`} onClick={() => spSign(o.id, o.name)}>Sign{o.tier === "title" ? " (renames team)" : ""}</button>
          </div>
        ))}
      </div>
    </div>
    <NextBtn on={doFinish}>Start {state.season + 1} →</NextBtn>
  </Wrap>;
}

// recompute a single team's wage bill after roster changes
function recountTeam(state) { for (const t of state.teams) t.salaryTotal = Math.round(t.riderIds.reduce((s, id) => s + (state.riders[id]?.salary || 0), 0) * 100) / 100; }

// ---- unified inbox model: decisions (state.inbox) + info news (state.news), FM-style ----
const inboxUnread = (state) => (state.inbox?.length || 0) + Math.max(0, (state.news?.length || 0) - (state.newsReadHigh || 0));
const markInboxRead = (state) => { state.newsReadHigh = (state.news || []).length; };
// icon + colour per info-message kind
const NEWS_ICON = { report: ["🏁", "var(--gold)"], result: ["🏁", "var(--mut)"], morale: ["◆", "var(--amber)"], injury: ["✚", "var(--red)"], breakthrough: ["★", "var(--green)"], scout: ["🔍", "var(--cyan)"], scouting: ["🔍", "var(--cyan)"], money: ["€", "var(--gold)"], retire: ["⚑", "var(--mut)"], season: ["»", "var(--blue)"], jersey: ["●", "var(--purple)"], choice: ["◆", "var(--amber)"], beat: ["·", "var(--mut)"] };
const NEWS_CAT = { report: "results", result: "results", stage: "results", oneday: "results", tour: "results", climb: "results", berg: "results", cobble: "results", gravel: "results", descent: "results", jersey: "results",
  morale: "squad", injury: "squad", breakthrough: "squad", scout: "squad", scouting: "squad", retire: "squad", beat: "squad", choice: "squad", money: "board", season: "board" };
// build the merged feed: decisions pinned at top (flagged), then info news newest-first
function inboxFeed(state, limit = 60) {
  const items = [];
  for (const e of (state.inbox || [])) items.push({ type: "decision", ev: e, unread: true });
  const news = state.news || [], readHigh = state.newsReadHigh || 0;
  for (let i = news.length - 1; i >= 0 && items.length < limit; i--) items.push({ type: "info", n: news[i], idx: i, unread: i >= readHigh });
  return items;
}
// what does clicking a feed item open? a race result, a rider profile, or a screen — else nothing
function resolveMsgTarget(state, item) {
  if (!item) return null;
  if (item.type === "decision") return { kind: "decision", ev: item.ev };
  const n = item.n; if (!n) return null;
  if (n.raceId && state.results[n.raceId]) return { kind: "result", rec: state.results[n.raceId] };
  let lid = n.riderLid;
  if (lid == null) { const ut = state.teams[state.userTeamId]; const ids = (ut.riderIds || []).concat(ut.devIds || []); for (const id of ids) { const r = state.riders[id]; if (r && r.short && (n.text || "").includes(r.short)) { lid = id; break; } } }
  if (lid != null && state.riders[lid]) return { kind: "rider", rider: state.riders[lid] };
  if (n.kind === "transfer") return { kind: "nav", to: "transfers" };
  if (n.kind === "money" || n.kind === "season" || n.kind === "sponsor") return { kind: "nav", to: "finance" };
  return null;
}
// focused decision overlay — the full text + choices, opened from the dashboard/inbox click or via Space
function DecisionModal({ state, ev, onResolve, onClose }) {
  if (!ev) return null;
  const r = state.riders[ev.riderLid];
  return (
    <div className="modal" onClick={onClose}><div className="sheet" onClick={(e) => e.stopPropagation()}>
      <div className="ph">Manager decision<span className="mono" style={{ letterSpacing: 0 }}>{ev.kind}</span></div>
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>{r && <Face rider={r} size={44} />}<b style={{ fontSize: 16 }}>{ev.riderShort}</b></div>
        <div style={{ fontSize: 14, lineHeight: 1.5 }}>{ev.text}</div>
        {ev.lines && ev.lines.length > 0 && <div style={{ marginTop: 9, paddingLeft: 10, borderLeft: "2px solid color-mix(in srgb, var(--cyan) 50%, transparent)", display: "flex", flexDirection: "column", gap: 3 }}>{ev.lines.map((ln, i) => <div key={i} style={{ fontSize: 12, color: "var(--mut)" }}>{ln}</div>)}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>{ev.options.map((o, i) => <button key={i} className="btn pri" onClick={() => onResolve(i)}>{o.label}</button>)}</div>
      </div>
    </div></div>
  );
}
function InboxDecision({ state, e, refresh }) {
  const r = state.riders[e.riderLid];
  return (
    <div className="ibx-msg ibx-decision">
      <span className="ibx-ic" style={{ color: "var(--amber)" }}>{r ? <Face rider={r} size={34} /> : "◆"}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ibx-head"><b>{e.riderShort}</b><span className="pill">{e.kind}</span><span className="ibx-flag">DECISION</span></div>
        <div style={{ fontSize: 13, marginTop: 3 }}>{e.text}</div>
        {e.lines && e.lines.length > 0 && <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 3, paddingLeft: 10, borderLeft: "2px solid color-mix(in srgb, var(--cyan) 50%, transparent)" }}>{e.lines.map((ln, i) => <div key={i} style={{ fontSize: 11.5, color: "var(--mut)" }}>{ln}</div>)}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 9 }}>
          {e.options.map((o, i) => <button key={i} className="btn sm" onClick={() => { resolveEvent(state, e.id, i); refresh(); }}>{o.label}</button>)}
        </div>
      </div>
    </div>
  );
}
function Inbox({ state, refresh, openMsg }) {
  const [cat, setCat] = React.useState("all");
  React.useEffect(() => { markInboxRead(state); refresh(); /* eslint-disable-next-line */ }, []);
  const feed = inboxFeed(state, 80);
  const cats = [["all", "All"], ["decisions", "Decisions"], ["results", "Results"], ["squad", "Squad"], ["board", "Board"]];
  const shown = feed.filter((it) => cat === "all" ? true : cat === "decisions" ? it.type === "decision" : it.type === "info" && NEWS_CAT[it.n.kind] === cat);
  const decisionN = state.inbox?.length || 0;
  return (
    <div className="card">
      <div className="ph">Inbox<span className="mono" style={{ letterSpacing: 0 }}>{decisionN ? decisionN + " to action" : "all clear"}</span></div>
      <div style={{ display: "flex", gap: 6, padding: "10px 12px", borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
        {cats.map(([k, l]) => <button key={k} className={"chip-btn" + (cat === k ? " on" : "")} onClick={() => setCat(k)}>{l}{k === "decisions" && decisionN ? ` (${decisionN})` : ""}</button>)}
      </div>
      <div style={{ padding: 8 }}>
        {shown.length === 0 ? <div style={{ padding: 26, color: "var(--mut)", fontSize: 13 }}>Nothing here. Messages and decisions arrive after races and through the season.</div>
          : shown.map((it, k) => it.type === "decision"
            ? <InboxDecision key={"d" + it.ev.id} state={state} e={it.ev} refresh={refresh} />
            : (() => { const ic = NEWS_ICON[it.n.kind] || ["·", "var(--mut)"]; const canOpen = !!resolveMsgTarget(state, it); return (
                <div key={"n" + it.idx} className={"ibx-msg" + (it.unread ? " ibx-unread" : "") + (canOpen ? " ibx-clik" : "")} onClick={canOpen && openMsg ? () => openMsg(it) : undefined}>
                  <span className="ibx-ic" style={{ color: ic[1] }}>{ic[0]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12.5, lineHeight: 1.4 }}>{it.n.text}</div></div>
                  {canOpen && <span style={{ color: "var(--mut)", fontSize: 11, flex: "none" }}>›</span>}
                  <span className="ibx-wk mono">{it.n.date ? "w" + it.n.date : "—"}</span>
                </div>); })())}
      </div>
    </div>
  );
}

// ============================================================================
//  ROOT
// ============================================================================
// ============================================================================
//  DEVELOPMENT — youth academy, young pros, scouting, training & programs
// ============================================================================
function Development({ state, refresh }) {
  const t = state.teams[state.userTeamId];
  const [view, setView] = React.useState("squad");
  const [detail, setDetail] = React.useState(null);
  const dev = devSquad(state, state.userTeamId);
  const pros = t.riderIds.map((id) => state.riders[id]).filter(Boolean);
  const youngPros = pros.filter((r) => r.age <= 25).sort((a, b) => b.potential - a.potential || b.overall - a.overall);
  const squad = pros.slice().sort((a, b) => b.overall - a.overall);

  const focusOf = (id) => (state.trainingFocus && state.trainingFocus[id]) || "auto";
  const setProg = (r, v) => { setProgram(state, r, v); refresh(); };
  const altRoster = altitudeRoster(state), slots = altitudeSlots(), cost = altitudeCost();

  const PotBar = ({ r }) => { const b = potentialBand(r); const cur = (r.overall / 99) * 100, hi = (b.high / 99) * 100;
    return <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{ position: "relative", width: 56, height: 7, background: "#262c36", borderRadius: 4, overflow: "hidden" }}>
        <span style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: hi + "%", background: "rgba(52,211,153,.3)" }} />
        <span style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: cur + "%", background: "#2b59c3" }} />
      </span>
      <span className="mono" style={{ fontSize: 11, color: "var(--mut)" }}>{r.overall}<b style={{ color: b.high > r.overall + 1 ? "var(--green)" : "var(--mut)" }}>→{b.high}</b></span>
    </span>; };
  const Delta = ({ r }) => <span className="mono" style={{ color: r.lastGrowth > 0 ? "var(--green)" : r.lastGrowth < 0 ? "#d6311f" : "var(--mut)", fontSize: 11 }}>{r.lastGrowth > 0 ? "+" : ""}{r.lastGrowth || 0}</span>;
  const FocusSel = ({ r }) => <select value={focusOf(r.id)} onChange={(e) => { state.trainingFocus = state.trainingFocus || {}; state.trainingFocus[r.id] = e.target.value; refresh(); }} style={{ fontSize: 11, padding: "2px 4px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--paper)", maxWidth: 140 }}>{TRAINING_FOCI.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>;
  const ProgSeg = ({ r }) => r.age <= 25 ? <div className="seg">{[["develop", "Dev"], ["balanced", "Bal"], ["race", "Race"]].map(([k, l]) => <button key={k} className={(r.program || "balanced") === k ? "on" : ""} title={k + " program"} onClick={() => setProg(r, k)}>{l}</button>)}</div> : <span style={{ color: "var(--mut)", fontSize: 11 }}>—</span>;
  const Wkg = ({ r }) => <span className="mono" style={{ fontSize: 11.5 }}>{(r.cp / r.weight).toFixed(2)}{r.lastWkg ? <b style={{ color: r.lastWkg > 0 ? "var(--green)" : "#d6311f", fontSize: 10 }}> {r.lastWkg > 0 ? "+" : ""}{r.lastWkg}</b> : null}</span>;
  const AltBtn = ({ r }) => { const on = altRoster.includes(r.id); const full = altRoster.length >= slots && !on;
    return <button className={"btn sm" + (on ? " pri" : "")} disabled={full} title={full ? "camp full" : "send to altitude camp"} onClick={() => { toggleAltitude(state, r.id); refresh(); }}>⛰{on ? "✓" : ""}</button>; };

  const promote = (r) => { promoteToPro(state, t, r); state.news.push({ season: state.season, date: 0, kind: "season", text: `${r.short} promoted from the academy to the pro roster.` }); refresh(); };
  const releaseD = (r) => { if (confirm(`Release prospect ${r.short}?`)) { releaseDev(state, t, r); refresh(); } };
  const demote = (r) => { demoteToDev(state, t, r); refresh(); };

  const baseRows = view === "academy" ? dev : view === "young" ? youngPros : squad;
  const { list: rows, toolbar, th } = useTableTools(baseRows, { tags: RIDER_TAGS, sorts: RIDER_SORTS, search: (r) => r.name + " " + (r.nation || ""), ctx: { state, week: state.calendar[state.calIndex]?.week || 0 }, defaultSort: 1 });
  const setFocusAll = (v) => { if (!v) return; state.trainingFocus = state.trainingFocus || {}; rows.forEach((r) => { state.trainingFocus[r.id] = v; }); refresh(); };

  // --- dashboard-derived data (Figma: Training & Development) ---
  const cal = state.calendar || [];
  const nextRace = cal[state.calIndex] || null;
  const week = nextRace?.week ?? (cal.length ? cal[cal.length - 1].week : 0);
  const confCol = (c) => c < 42 ? "var(--red)" : c < 56 ? "var(--amber)" : c >= 74 ? "var(--green)" : "var(--ink)";
  // coach recommendations — synthesized from load, injury, confidence and the breakout tracker
  const recs = [];
  for (const r of squad.concat(dev)) {
    if (r.out > 0) recs.push({ sev: 3, ic: "⛔", col: "var(--red)", text: `${r.short} out ${r.out} race${r.out > 1 ? "s" : ""} injured — will lose training this block.` });
    else if ((r.fatigue || 0) >= 80) recs.push({ sev: 3, ic: "⛔", col: "var(--red)", text: `${r.short} fatigue CRITICAL ${Math.round(r.fatigue)}% — mandatory rest before the next block.` });
    else if ((r.fatigue || 0) >= 64) recs.push({ sev: 2, ic: "⚠️", col: "var(--amber)", text: `${r.short} fatigue at ${Math.round(r.fatigue)}% — reduce load.` });
    if ((r.confidence ?? 60) < 42) recs.push({ sev: 2, ic: "⚠️", col: "var(--amber)", text: `${r.short}'s confidence has cratered (${Math.round(r.confidence ?? 60)}) — needs a lift.` });
  }
  const ripe = breakoutWatch(state).filter((x) => x.band === "cusp" || x.band === "rising");
  for (const x of ripe.slice(0, 3)) recs.push({ sev: 1, ic: "✅", col: "var(--green)", text: `${x.short} ${String(x.label || "developing well").toLowerCase()}.` });
  recs.sort((a, b) => b.sev - a.sev);
  const recsTop = recs.slice(0, 6);
  // performance matrix — freshness (100-fatigue) × fitness (form)
  const matrix = squad.slice(0, 14).map((r) => ({ r, fresh: 100 - (r.fatigue || 0), fit: r.form ?? 60 }));
  // U23 forecast — the pipeline, projected growth to potential ceiling
  const u23 = youngPros.concat(dev).sort((a, b) => (potentialBand(b).high - b.overall) - (potentialBand(a).high - a.overall) || b.potential - a.potential).slice(0, 6);
  // development feed — the season's living story beats
  const feed = (state.news || []).filter((n) => ["breakthrough", "morale", "injury"].includes(n.kind)).slice(-7).reverse();
  const feedIc = { breakthrough: ["★", "var(--green)"], morale: ["◆", "var(--amber)"], injury: ["✚", "var(--red)"] };
  const MW = 320, MH = 188, mpL = 12, mpR = 12, mpT = 12, mpB = 22;
  const mx = (v) => mpL + (v / 100) * (MW - mpL - mpR), my = (v) => MH - mpB - (v / 100) * (MH - mpT - mpB);

  return (
    <div className="dev-dash">
      <div className="dev-hdr">
        <div>
          <h1 className="dev-title">Training &amp; Development</h1>
          <div className="dev-sub">SEASON {state.season} · {(t.name || "").toUpperCase()} · ACADEMY {dev.length} · WEEK {week}</div>
        </div>
        {nextRace && <span className="nextrace-pill">NEXT: {String(nextRace.name || "RACE").toUpperCase()}</span>}
      </div>

      <div className="dev-grid">
        {/* ---- main column ---- */}
        <div className="dev-col">
          <div className="card">
            {/* altitude camp */}
            <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)", background: "rgba(52,211,153,.08)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <b style={{ color: "var(--green)" }}>⛰ Altitude camp</b>
                <span className="mono" style={{ fontSize: 12 }}>{altRoster.length}/{slots} riders</span>
                <span style={{ fontSize: 11.5, color: "var(--mut)" }}>{money(cost)} per rider · winter block · extra threshold + endurance, diminishing if repeated</span>
                {altRoster.length > 0 && <span className="pill">{money(cost * altRoster.length)} this winter</span>}
              </div>
              {altRoster.length > 0 && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                {altRoster.map((id) => { const r = state.riders[id]; return <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "rgba(52,211,153,.14)", border: "1px solid rgba(52,211,153,.3)", borderRadius: 999, padding: "2px 6px 2px 8px", fontSize: 11.5 }}>{r?.short}{r?.altYears ? <span className="mono" style={{ color: "var(--green)" }}>·{r.altYears}×</span> : ""}<button className="btn sm" style={{ padding: "0 5px" }} onClick={() => { toggleAltitude(state, id); refresh(); }}>×</button></span>; })}
              </div>}
            </div>
            <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div className="seg">{[["squad", `Squad (${squad.length})`], ["young", `Young (${youngPros.length})`], ["academy", `Academy (${dev.length})`]].map(([k, l]) => <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{l}</button>)}</div>
              <span style={{ fontSize: 11, color: "var(--mut)" }}>Set a focus + altitude riders, then advance. Click a rider for their profile.</span>
            </div>
            <div style={{ padding: "0 12px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {toolbar}
              <span style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 11.5, color: "var(--mut)" }}>focus for {rows.length}:
                <select defaultValue="" onChange={(e) => { setFocusAll(e.target.value); e.target.value = ""; }} style={{ fontSize: 12, padding: "4px 6px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--ink)" }}>
                  <option value="">— bulk apply —</option>
                  {TRAINING_FOCI.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="tbl">
                <thead><tr><th></th>{th("Rider")}{th("Type")}{th("Age", "Age", { className: "num" })}{th("OVR", "Overall", { className: "num" })}{th("POT", "Potential", { className: "num" })}<th className="num">Conf</th>{th("W/kg", "W/kg", { className: "num" })}{th("Δ", "Recent Δ", { className: "num" })}<th>Training focus</th><th>Alt</th>{view !== "squad" && <th>Program</th>}<th></th></tr></thead>
                <tbody>
                  {rows.map((r) => { const c = Math.round(r.confidence ?? 60); return (
                    <tr key={r.id}>
                      <td><Face rider={r} size={28} /></td>
                      <td style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setDetail(r)}>{r.short}</td>
                      <td><Tag a={r.archetype} /></td>
                      <td className="num mono">{r.age}</td>
                      <td className="num"><Ovr o={r.overall} /></td>
                      <td className="num mono" style={{ color: potentialBand(r).high > r.overall + 1 ? "var(--green)" : "var(--mut)" }}>{potentialBand(r).high}</td>
                      <td className="num"><span className="confpip"><span className="cbar"><span style={{ width: c + "%", background: confCol(c) }} /></span><b className="mono" style={{ fontSize: 11, color: confCol(c) }}>{c}</b></span></td>
                      <td className="num"><Wkg r={r} /></td>
                      <td className="num"><Delta r={r} /></td>
                      <td><FocusSel r={r} /></td>
                      <td><AltBtn r={r} /></td>
                      {view !== "squad" && <td><ProgSeg r={r} /></td>}
                      <td>{view === "academy" ? <span style={{ display: "flex", gap: 4 }}><button className="btn sm pri" onClick={() => promote(r)}>Promote</button><button className="btn sm" onClick={() => releaseD(r)}>Cut</button></span>
                        : r.age <= 25 && view === "young" ? <button className="btn sm" onClick={() => demote(r)}>→ Academy</button> : null}</td>
                    </tr>
                  ); })}
                </tbody>
              </table>
              {rows.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "var(--mut)", fontSize: 13 }}>{view === "academy" ? "Your academy is empty — sign prospects from the Scouting tab." : "No riders here."}</div>}
            </div>
          </div>

          {/* coach recommendations */}
          <div className="card">
            <div className="ph">Coach recommendations<span className="mono" style={{ letterSpacing: 0 }}>{recsTop.length}</span></div>
            <div style={{ padding: "4px 14px 12px" }}>
              {recsTop.length === 0 ? <div style={{ padding: 14, color: "var(--mut)", fontSize: 12.5 }}>All riders on track. No load or morale flags this block.</div>
                : recsTop.map((x, i) => <div key={i} className="recrow"><span className="ri" style={{ color: x.col }}>{x.ic}</span><span>{x.text}</span></div>)}
            </div>
          </div>
        </div>

        {/* ---- side column ---- */}
        <div className="dev-col">
          {/* performance matrix */}
          <div className="card">
            <div className="ph">Performance matrix</div>
            <div style={{ padding: "10px 12px 6px" }}>
              <svg viewBox={`0 0 ${MW} ${MH}`} width="100%" style={{ display: "block" }}>
                <rect x={mpL} y={mpT} width={MW - mpL - mpR} height={MH - mpT - mpB} fill="none" stroke="var(--line)" />
                <line x1={mx(50)} y1={mpT} x2={mx(50)} y2={MH - mpB} stroke="var(--line)" strokeDasharray="2 3" opacity=".5" />
                <line x1={mpL} y1={my(55)} x2={MW - mpR} y2={my(55)} stroke="var(--line)" strokeDasharray="2 3" opacity=".5" />
                <text x={mx(78)} y={my(88) - 4} textAnchor="middle" fontSize="8.5" fontWeight="800" fill="var(--green)" className="mono">PEAK</text>
                {matrix.map(({ r, fresh, fit }, i) => { const peak = fresh > 55 && fit > 62, crit = fresh < 32; const col = crit ? "var(--red)" : peak ? "var(--green)" : "var(--blue)"; return (
                  <g key={i}><circle cx={mx(fresh)} cy={my(fit)} r={crit || peak ? 4 : 3} fill={col} />
                    {(peak || crit) && <text x={mx(fresh)} y={my(fit) - 6} textAnchor="middle" fontSize="7.5" fill={col} className="mono">{r.short.split(" ").pop()}</text>}</g>); })}
                <text x={mpL} y={MH - 6} fontSize="8" fill="var(--mut)" className="mono">LOW FRESHNESS</text>
                <text x={MW - mpR} y={MH - 6} textAnchor="end" fontSize="8" fill="var(--mut)" className="mono">HIGH FRESHNESS</text>
              </svg>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--mut)", fontFamily: "var(--fMono)", padding: "0 2px" }}><span>← more fatigued</span><span>fitter ↑</span></div>
            </div>
          </div>

          {/* U23 season forecast */}
          <div className="card">
            <div className="ph">U23 season forecast<span className="mono" style={{ letterSpacing: 0 }}>{u23.length}</span></div>
            <div style={{ padding: "2px 14px 10px" }}>
              {u23.length === 0 ? <div style={{ padding: 12, color: "var(--mut)", fontSize: 12.5 }}>No U23 riders in the system yet.</div>
                : u23.map((r) => { const grow = potentialBand(r).high - r.overall; const d = r.lastGrowth || 0; return (
                  <div key={r.id} className="u23row" style={{ cursor: "pointer" }} onClick={() => setDetail(r)}>
                    <span className="u-name">{r.short}</span>
                    <span className="u-ovr">{r.overall} OVR · {r.age}y</span>
                    <span className="u-grow" style={{ color: grow >= 6 ? "var(--green)" : grow >= 2 ? "var(--amber)" : "var(--mut)" }}>+{grow}</span>
                    <span style={{ fontSize: 12, color: d > 0 ? "var(--green)" : d < 0 ? "var(--red)" : "var(--mut)", width: 14, textAlign: "center" }}>{d > 0 ? "↗" : d < 0 ? "↘" : "—"}</span>
                  </div>); })}
            </div>
          </div>

          {/* development feed — living story beats */}
          <div className="card">
            <div className="ph">Development feed</div>
            <div style={{ padding: "2px 14px 12px" }}>
              {feed.length === 0 ? <div style={{ padding: 12, color: "var(--mut)", fontSize: 12.5 }}>Story beats from your young riders will appear here as the season unfolds.</div>
                : feed.map((n, i) => { const ic = feedIc[n.kind] || ["•", "var(--mut)"]; return (
                  <div key={i} className="recrow"><span className="ri" style={{ color: ic[1] }}>{ic[0]}</span><span>{n.text}</span></div>); })}
            </div>
          </div>
        </div>
      </div>
      {detail && <RiderModal state={state} rider={detail} onClose={() => setDetail(null)} godMode={false} refresh={refresh} />}
    </div>
  );
}

// ============================================================================
//  ACADEMY — the talent pipeline hub: facilities, coaching staff, youth calendar,
//  scouting network, and the prospect roster (potential fogged until scouted).
// ============================================================================
function Academy({ state, refresh, go }) {
  const t = state.teams[state.userTeamId];
  const [detail, setDetail] = React.useState(null);
  const [msg, setMsg] = React.useState(null);
  const dev = devSquad(state, state.userTeamId);
  const tier = academyTier(t.youthRating);
  const coaches = userCoaches(state);
  const market = coachMarket(state);
  const races = youthRaces();
  const cal = new Set(t.youthCalendar ?? races.map((r) => r.name));
  const scouts = t.scouts || [];
  const netPow = scouts.reduce((s, sc) => s + (sc.jpp || 0), 0);
  const upgCost = youthUpgradeCost(t);
  const confCol = (c) => c < 42 ? "var(--red)" : c < 56 ? "var(--amber)" : c >= 74 ? "var(--green)" : "var(--ink)";
  const flash = (ok, text) => setMsg({ ok, text });
  const upgrade = () => { const r = investYouth(state, t); flash(r.ok, r.ok ? `Facilities upgraded to ${academyTier(r.youthRating).name} (−${money(r.spent)}).` : r.reason); refresh(); };
  const hire = (id) => { const r = hireCoach(state, t, id); flash(r.ok, r.ok ? `Hired ${r.coach.label} ${r.coach.name}.` : r.reason); refresh(); };
  const fire = (id, nm) => { if (confirm(`Release ${nm}?`)) { fireCoach(state, t, id); refresh(); } };
  const toggleRace = (nm) => { toggleYouthRace(state, t, nm); refresh(); };
  const promote = (r) => { promoteToPro(state, t, r); state.news.push({ season: state.season, date: 0, kind: "season", text: `${r.short} promoted from the academy to the pro roster.` }); refresh(); };
  const cut = (r) => { if (confirm(`Release prospect ${r.short}?`)) { releaseDev(state, t, r); refresh(); } };
  const setPath = (r, key) => { if (!key) return; const res = setDevPath(state, r, key); if (res.switching) flash(true, `${r.short} re-tooled as ${res.path.label} — a season of adjustment.`); else if (res.poor) flash(true, `${r.short} will develop slower on the ${res.path.label.toLowerCase()} path — against their grain.`); refresh(); };
  const setExp = (r, key) => { setExpectation(state, r, key); flash(true, `You've backed ${r.short}: ${EXPECTATION_TYPES.find((e) => e.key === key).label.toLowerCase()}.`); refresh(); };
  const clearExp = (r) => { clearExpectation(state, r); refresh(); };
  return (
    <div className="dev-dash">
      <div className="dev-hdr">
        <div><h1 className="dev-title">The Academy</h1>
          <div className="dev-sub">{tier.name.toUpperCase()} · {dev.length} PROSPECT{dev.length !== 1 ? "S" : ""} · {coaches.length} COACH{coaches.length !== 1 ? "ES" : ""} · NETWORK {netPow}</div></div>
        <span className="nextrace-pill" style={{ background: "var(--purple)" }}>TIER {tier.lvl}/5</span>
      </div>
      {msg && <div className="card" style={{ padding: "9px 13px", borderColor: msg.ok ? "var(--green)" : "var(--red)", color: msg.ok ? "var(--green)" : "var(--red)", fontSize: 12.5 }}>{msg.text}</div>}
      <div className="dev-grid">
        <div className="dev-col">
          <div className="card">
            <div className="ph">Talent pipeline<span className="mono" style={{ letterSpacing: 0 }}>{dev.length}/10</span></div>
            <div style={{ padding: "8px 12px 12px", display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(208px,1fr))", gap: 10 }}>
              {dev.length === 0 && <div style={{ gridColumn: "1/-1", padding: 20, textAlign: "center", color: "var(--mut)", fontSize: 13 }}>Your academy is empty. Sign prospects from the off-season intake, or head-hunt on the Scouting tab.</div>}
              {dev.map((r) => { const know = Math.round(r.know ?? 0); const foggy = know < 55; const c = Math.round(r.confidence ?? 60); const band = potentialBand(r);
                const rd = promotionReadiness(r); const rcol = rd.score >= 0.8 ? "var(--green)" : rd.score >= 0.58 ? "var(--amber)" : "var(--red)";
                const pathObj = DEV_PATHS.find((dp) => dp.key === r.devPath); return (
                <div key={r.id} className="prospect" onClick={() => setDetail(r)}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <Face rider={r} size={34} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.short}</div>
                      <div style={{ fontSize: 10.5, color: "var(--mut)", display: "flex", gap: 4, alignItems: "center" }}>{r.nation} · {r.age}y <Tag a={r.archetype} /></div>
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9 }}>
                    <span style={{ fontSize: 9.5, color: "var(--mut)", letterSpacing: ".06em" }}>POTENTIAL</span>
                    {foggy ? <span style={{ fontSize: 11, color: "var(--mut)" }}>🔒 scouting…</span> : <StarRow cur={r.overall / 19.8} pot={band.high / 19.8} />}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, marginTop: 5 }}>
                    <span className="mono" style={{ color: "var(--mut)" }}>OVR {foggy ? "??" : r.overall}{!foggy && band.high > r.overall + 1 ? <b style={{ color: "var(--green)" }}> →{band.high}</b> : ""}</span>
                    <span className="confpip"><span className="cbar"><span style={{ width: c + "%", background: confCol(c) }} /></span><b className="mono" style={{ fontSize: 10.5, color: confCol(c) }}>{c}</b></span>
                  </div>
                  <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                    <select value={r.devPath || ""} onChange={(e) => setPath(r, e.target.value)} style={{ width: "100%", fontSize: 11, padding: "3px 5px", borderRadius: 6, border: "1px solid " + (pathObj ? "var(--blue)" : "var(--line)"), background: "var(--bg)", color: pathObj ? "var(--ink)" : "var(--mut)" }}>
                      <option value="">◇ Set development path…</option>
                      {DEV_PATHS.map((dp) => { const fit = pathFitOf(r, dp.key); return <option key={dp.key} value={dp.key}>{dp.label} {fit > 1 ? "— natural fit" : "— against grain"}</option>; })}
                    </select>
                  </div>
                  <div style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
                    {r._expectation ? <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10.5, color: "var(--gold)" }}>◆ backed: {r._expectation === "breakthrough" ? "breakthrough" : "promotion"}<button className="btn sm" style={{ padding: "0 5px" }} onClick={() => clearExp(r)}>×</button></span>
                      : <div style={{ display: "flex", gap: 4 }}>{EXPECTATION_TYPES.map((e) => <button key={e.key} className="btn sm" style={{ flex: 1, fontSize: 9.5 }} title={e.blurb} onClick={() => setExp(r, e.key)}>{e.key === "breakthrough" ? "◆ back breakout" : "↑ promise pro"}</button>)}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 5, marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn sm pri" style={{ flex: 1 }} title={"Promotion readiness: " + rd.label} onClick={() => promote(r)}>Promote</button>
                    <button className="btn sm" onClick={() => cut(r)}>Cut</button>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--mut)", marginTop: 7, fontFamily: "var(--fMono)", letterSpacing: ".05em" }}><span>SCOUTED {know}%</span><span style={{ color: rcol }}>{rd.label.toUpperCase()}</span></div>
                </div>); })}
            </div>
          </div>
          <div className="card">
            <div className="ph">Facilities<span className="mono" style={{ letterSpacing: 0 }}>rating {t.youthRating ?? 45}</span></div>
            <div style={{ padding: "10px 14px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <b style={{ fontFamily: "var(--fTitle)", fontSize: 19, textTransform: "uppercase", color: "var(--purple)" }}>{tier.name}</b>
                <span style={{ display: "inline-flex", gap: 3 }}>{[1, 2, 3, 4, 5].map((i) => <span key={i} style={{ width: 16, height: 6, borderRadius: 2, background: i <= tier.lvl ? "var(--purple)" : "var(--card2)" }} />)}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--mut)", margin: "8px 0 12px", lineHeight: 1.45 }}>Better facilities produce bigger, stronger intake crops and develop your prospects faster in-house.</div>
              <button className="btn pri" disabled={(t.youthRating ?? 45) >= 95 || (t.budget ?? 0) < upgCost} onClick={upgrade}>{(t.youthRating ?? 45) >= 95 ? "Fully upgraded" : `Upgrade facilities · ${money(upgCost)}`}</button>
            </div>
          </div>
        </div>
        <div className="dev-col">
          <div className="card">
            <div className="ph">Coaching staff<span className="mono" style={{ letterSpacing: 0 }}>{coaches.length}/{COACH_CAP}</span></div>
            <div style={{ padding: "4px 14px 10px" }}>
              {coaches.length === 0 && <div style={{ padding: "8px 0", color: "var(--mut)", fontSize: 12 }}>No coaches on staff.</div>}
              {coaches.map((c) => (
                <div key={c.id} className="u23row">
                  <span style={{ flex: 1, minWidth: 0 }}><b style={{ fontSize: 12.5 }}>{c.name}</b><div style={{ fontSize: 10.5, color: "var(--mut)" }}>{c.label}</div></span>
                  <span className="mono" style={{ fontSize: 11, color: c.rating >= 75 ? "var(--green)" : c.rating >= 55 ? "var(--amber)" : "var(--mut)" }}>{c.rating}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--mut)" }}>{money(c.salary)}</span>
                  <button className="btn sm" onClick={() => fire(c.id, c.name)}>✕</button>
                </div>))}
              {coaches.length < COACH_CAP && market.length > 0 && <>
                <div style={{ fontSize: 10, color: "var(--mut)", letterSpacing: ".08em", margin: "10px 0 4px" }}>AVAILABLE TO HIRE</div>
                {market.slice(0, 4).map((c) => (
                  <div key={c.id} className="u23row">
                    <span style={{ flex: 1, minWidth: 0 }}><b style={{ fontSize: 12.5 }}>{c.name}</b><div style={{ fontSize: 10.5, color: "var(--mut)" }}>{c.label} · {money(c.salary)}/yr</div></span>
                    <span className="mono" style={{ fontSize: 11, color: c.rating >= 75 ? "var(--green)" : c.rating >= 55 ? "var(--amber)" : "var(--mut)" }}>{c.rating}</span>
                    <button className="btn sm pri" onClick={() => hire(c.id)}>Hire</button>
                  </div>))}
              </>}
            </div>
          </div>
          <div className="card">
            <div className="ph">Youth race calendar<span className="mono" style={{ letterSpacing: 0 }}>{cal.size}/{races.length}</span></div>
            <div style={{ padding: "6px 14px 12px" }}>
              <div style={{ fontSize: 11.5, color: "var(--mut)", marginBottom: 8, lineHeight: 1.4 }}>Pick which U23 races your prospects contest. Racing builds experience &amp; can spark a breakthrough — but every start risks a knock.</div>
              {races.map((rc) => { const on = cal.has(rc.name); return (
                <div key={rc.name} className="u23row" style={{ cursor: "pointer" }} onClick={() => toggleRace(rc.name)}>
                  <span style={{ width: 16, color: on ? "var(--green)" : "var(--mut)" }}>{on ? "☑" : "☐"}</span>
                  <span style={{ flex: 1, fontSize: 12.5, color: on ? "var(--ink)" : "var(--mut)" }}>{rc.name}</span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--mut)" }}>{rc.ft} · {rc.prestige}</span>
                </div>); })}
            </div>
          </div>
          <div className="card">
            <div className="ph">Scouting network</div>
            <div style={{ padding: "10px 14px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}><span>Scouts on staff</span><b className="mono">{scouts.length}</b></div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginTop: 5 }}><span>Network reach</span><b className="mono" style={{ color: netPow >= 140 ? "var(--green)" : netPow >= 80 ? "var(--amber)" : "var(--mut)" }}>{netPow}</b></div>
              <div style={{ fontSize: 11.5, color: "var(--mut)", margin: "9px 0 11px", lineHeight: 1.4 }}>A stronger network clears the fog on your prospects' true potential faster.</div>
              <button className="btn" onClick={() => go && go("scouting")}>Manage scouts →</button>
            </div>
          </div>
        </div>
      </div>
      {detail && <RiderModal state={state} rider={detail} onClose={() => setDetail(null)} godMode={false} refresh={refresh} />}
    </div>
  );
}

// ============================================================================
//  SCOUTING — staff, assignments (region / youth / rider), fog-of-war reports
// ============================================================================
function StarRow({ cur, pot }) {
  return <span style={{ display: "inline-flex", gap: 1, verticalAlign: "middle" }}>{[0, 1, 2, 3, 4].map((i) => {
    const fill = Math.max(0, Math.min(1, (cur || 0) - i)), out = Math.max(0, Math.min(1, (pot || 0) - i));
    return <span key={i} style={{ position: "relative", width: 12, height: 12, display: "inline-block", fontSize: 12, lineHeight: "12px" }}>
      <span style={{ position: "absolute", left: 0, top: 0, color: out > 0 ? "var(--starDim)" : "var(--starOff)" }}>★</span>
      <span style={{ position: "absolute", left: 0, top: 0, overflow: "hidden", width: (fill * 100) + "%", color: "var(--gold)" }}>★</span>
    </span>;
  })}</span>;
}
// season-fatigue bar: green (fresh) → amber → red (exhausted)
function FatBar({ f = 0, w = 46 }) {
  const v = Math.round(f);
  const col = v < 25 ? "var(--green)" : v < 45 ? "var(--cyan)" : v < 65 ? "var(--amber)" : v < 80 ? "var(--hot)" : "var(--red)";
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, verticalAlign: "middle" }} title={`${fatigueLabel(v)} · fatigue ${v}/100`}>
    <span style={{ width: w, height: 6, background: "var(--line)", borderRadius: 4, overflow: "hidden", display: "inline-block" }}><span style={{ display: "block", width: v + "%", height: "100%", background: col }} /></span>
    <span className="mono" style={{ fontSize: 10.5, color: col, minWidth: 18 }}>{v}</span>
  </span>;
}
function Scouting({ state, refresh }) {
  const t = state.teams[state.userTeamId];
  const [view, setView] = React.useState("map");
  const [selRegion, setSelRegion] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const scouts = userScouts(state);
  const market = scoutMarket(state);
  const reports = scoutReports(state, 40);
  const sl = new Set(state.shortlist || []);

  const setAssign = (sc, a) => { assignScout(state, sc.id, a); refresh(); };
  const focusRider = (lid) => { const idle = scouts.find((s) => !s.assign) || scouts.slice().sort((a, b) => b.jpp - a.jpp)[0]; if (idle) { assignScout(state, idle.id, { type: "rider", lid }); refresh(); } };
  const [msg, setMsg] = React.useState(null);
  const odds = (r) => Math.max(0.05, Math.min(0.95, 0.46 + (t.prestige - (r.prominence || 0) * 0.7) / 70 + ((r.know || 0) - 40) / 220));
  const headhunt = (r) => {
    const res = recruitProspect(state, t, r);
    if (res.ok) setMsg({ ok: true, text: `${r.short} signs for your academy! 🎉` });
    else if (res.reason === "academy full") setMsg({ ok: false, text: `Academy is full (6) — promote or release someone first.` });
    else if (res.sniped) setMsg({ ok: false, text: `${r.short} snubbed you and signed for ${res.sniped}.` });
    else setMsg({ ok: false, text: `${r.short} turned down your approach — come back stronger.` });
    refresh();
  };
  const Prom = ({ r }) => <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: (r.prominence || 0) >= 55 ? "var(--hot)" : (r.prominence || 0) >= 35 ? "var(--amber)" : "var(--mut)" }}>{(r.prominence || 0) >= 55 ? "🔥" : ""}{Math.round(r.prominence || 0)}</span>;
  const opps = regionOpportunities(state);
  const oppByKey = Object.fromEntries(opps.map((o) => [o.key, o]));
  const idleCount = scouts.filter((s) => !s.assign).length;
  const doAutoAssign = () => {
    const rep = autoAssignScouts(state);
    if (!rep.length) setMsg({ ok: false, text: idleCount === 0 ? "No idle scouts to assign — everyone's already out." : "No open opportunities right now — your scouts already cover the best regions." });
    else setMsg({ ok: true, text: `Deployed ${rep.length} scout${rep.length > 1 ? "s" : ""}: ${rep.map((r) => `${r.scoutName} → ${r.regionName} (${r.reason})`).join(" · ")}` });
    refresh();
  };
  const doSendBest = (regionKey, regionName) => {
    const sc = sendBestIdleScout(state, regionKey);
    if (!sc) setMsg({ ok: false, text: "No idle scout available — hire one or free someone up first." });
    else setMsg({ ok: true, text: `${sc.name} dispatched to ${regionName}.` });
    refresh();
  };
  const youthMarket = prospectPool(state, 40).filter((r) => r.teamId == null);
  const youthRes = state.youthResults || [];
  const discoveries = (state.news || []).filter((n) => n.kind === "scout").slice(-6).reverse();
  const watchers = (r) => {
    if (r.teamId != null || r.age > 23) return 0;
    const kp = knownPotential(r); const pot = kp.unknown ? (r.potential || r.overall) : kp.mid;
    return Math.max(0, Math.min(6, Math.round((pot - 70) / 3.5) + ((r.prominence || 0) >= 45 ? 1 : 0) + (sl.has(r.id) ? 1 : 0)));
  };

  const starOfKnown = (r) => { const k = Math.max(r.know || 0, r._regionKnow || 0); if (k < 14) return 0; const kp = knownPotential(r); return kp.unknown ? 0 : starOf(kp.hi); };
  const regionData = scoutRegions().map((rg) => {
    const ridersIn = Object.values(state.riders).filter((r) => regionOfNation(r.nation) === rg.key && r.teamId !== t.id);
    const knownCount = ridersIn.filter((r) => Math.max(r.know || 0, r._regionKnow || 0) >= 30).length;
    const prospects = ridersIn.filter((r) => r.age <= 23 && Math.max(r.know || 0, r._regionKnow || 0) >= 22).map((r) => ({ r, star: starOfKnown(r) })).filter((x) => x.star >= 3).sort((a, b) => b.star - a.star);
    const scoutsHere = scouts.filter((s) => s.assign && s.assign.type === "region" && s.assign.region === rg.key);
    const opp = oppByKey[rg.key] || {};
    return { ...rg, know: Math.round((state.regionKnow || {})[rg.key] || 0), knownCount, prospects, scoutsHere, recommended: !!opp.recommended, reason: opp.reason || "", score: opp.score || 0 };
  });
  // knowledge tiers ride the design accent ramp (none -> cyan -> blue -> green), tinted via color-mix off the theme tokens
  const knowTint = (k) => {
    const v = k >= 65 ? "--green" : k >= 45 ? "--blue" : k >= 28 ? "--cyan" : k >= 10 ? "--mut" : "--know0";
    const strong = k >= 65, mid = k >= 28;
    return { tx: `var(${v})`,
      bd: `color-mix(in srgb, var(${v}) ${strong ? 55 : mid ? 42 : 26}%, transparent)`,
      bg: `color-mix(in srgb, var(${v}) ${strong ? 18 : mid ? 12 : 6}%, transparent)` };
  };

  const Est = ({ r }) => { const ko = knownOverall(r), kp = knownPotential(r);
    return <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <StarRow cur={starOf(ko.mid)} pot={kp.unknown ? starOf(ko.mid) : starOf(kp.hi)} />
      <span className="mono" style={{ fontSize: 11, color: "var(--mut)" }}>{ko.exact ? ko.mid : `${ko.lo}-${ko.hi}`} → {kp.unknown ? "?" : `${kp.lo}-${kp.hi}`}</span>
    </span>; };
  const EstO = ({ r }) => { const ko = knownOverall(r); return <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><StarRow cur={starOf(ko.mid)} pot={starOf(ko.mid)} /><span className="mono" style={{ fontSize: 11, color: "var(--mut)" }}>{ko.exact ? ko.mid : `${ko.lo}-${ko.hi}`}</span></span>; };
  const EstP = ({ r }) => { const kp = knownPotential(r); return <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><StarRow cur={kp.unknown ? 0 : starOf(kp.hi)} pot={kp.unknown ? 0 : starOf(kp.hi)} /><span className="mono" style={{ fontSize: 11, color: kp.unknown ? "var(--mut)" : "var(--green)" }}>{kp.unknown ? "?" : `${kp.lo}-${kp.hi}`}</span></span>; };
  const Conf = ({ r }) => { const k = Math.round(r.know || 0); return <span className="mono" style={{ fontSize: 10.5, color: k >= 80 ? "var(--green)" : k >= 45 ? "var(--amber)" : "var(--red)" }}>{k}%</span>; };

  const reportRiders = reports.map((x) => x.r);
  const repTools = useTableTools(reportRiders, { tags: RIDER_TAGS, sorts: RIDER_SORTS, search: (r) => r.name + " " + (r.nation || ""), ctx: { state } });
  const youthTools = useTableTools(youthMarket, { tags: RIDER_TAGS, sorts: RIDER_SORTS, search: (r) => r.name + " " + (r.nation || ""), ctx: { state }, defaultSort: 1 });

  return (
    <div className="card">
      <div className="ph">Scouting · {t.name}<span className="mono" style={{ letterSpacing: 0 }}>{scouts.length} scouts · €{(t.scoutCost != null ? t.scoutCost : scouts.reduce((s, x) => s + x.salary, 0)).toFixed(2)}M/yr</span></div>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div className="seg">{[["map", "Map"], ["reports", `Reports (${reports.length})`], ["youth", `Youth market (${youthMarket.length})`], ["scouts", `My scouts (${scouts.length})`], ["hire", `Hire (${market.length})`]].map(([k, l]) => <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{l}</button>)}</div>
        <span style={{ fontSize: 11, color: "var(--mut)" }}>Send scouts to regions on the map. The longer they stay, the deeper your knowledge — and the more you know about everyone there, even off-assignment.</span>
      </div>
      {msg && <div style={{ margin: "10px 12px 0", padding: "8px 12px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, background: `color-mix(in srgb, var(${msg.ok ? "--green" : "--red"}) 13%, transparent)`, color: msg.ok ? "var(--green)" : "var(--hot)", border: `1px solid color-mix(in srgb, var(${msg.ok ? "--green" : "--red"}) 30%, transparent)` }}>{msg.text} <span style={{ float: "right", cursor: "pointer", color: "var(--mut)" }} onClick={() => setMsg(null)}>×</span></div>}

      {discoveries.length > 0 && (
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)", background: "color-mix(in srgb, var(--cyan) 7%, transparent)" }}>
          <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".12em", color: "var(--cyan)", fontWeight: 800, marginBottom: 6 }}>Latest from your scouts</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {discoveries.map((n, i) => <div key={i} style={{ fontSize: 12, color: "var(--ink)" }}>{n.text}</div>)}
          </div>
        </div>
      )}

      {view === "map" && (() => {
        const sel = regionData.find((r) => r.key === selRegion);
        return <div style={{ padding: 14 }}>
          <div style={{ display: "flex", gap: 13, flexWrap: "wrap", alignItems: "center", marginBottom: 12, fontSize: 11, color: "var(--mut)" }}>
            <span style={{ fontWeight: 700, color: "var(--ink)" }}>World knowledge</span>
            {[["None", 6], ["Awkward", 18], ["Basic", 36], ["Good", 55], ["Strong", 72], ["Exceptional", 90]].map(([lab, k]) => { const c = knowTint(k); return <span key={lab} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 11, height: 11, borderRadius: 3, background: c.bg, border: `1px solid ${c.bd}` }} />{lab}</span>; })}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--bg)", background: "var(--gold)", borderRadius: 5, padding: "1px 5px" }}>Rec</span>high-opportunity</span>
            <button className="btn sm pri" style={{ marginLeft: "auto" }} disabled={idleCount === 0} title={idleCount === 0 ? "No idle scouts" : `Distribute ${idleCount} idle scout${idleCount > 1 ? "s" : ""} to the best regions`} onClick={doAutoAssign}>Auto-assign{idleCount > 0 ? ` (${idleCount} idle)` : ""}</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gridTemplateRows: "repeat(4,auto)", gap: 8 }}>
            {regionData.map((rg) => { const c = knowTint(rg.know); const isSel = rg.key === selRegion;
              return <div key={rg.key} onClick={() => setSelRegion(rg.key)} role="button" tabIndex={0} style={{ gridColumn: rg.col + 1, gridRow: rg.row + 1, textAlign: "left", cursor: "pointer", background: c.bg, border: `1.5px solid ${isSel ? "var(--rouge)" : rg.recommended ? "var(--gold)" : c.bd}`, borderRadius: 11, padding: "10px 11px", color: "var(--ink)", minHeight: 80, display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{rg.name}{rg.recommended && <span title="Recommended — high-opportunity region" style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--bg)", background: "var(--gold)", borderRadius: 5, padding: "1px 5px", marginLeft: 6, verticalAlign: "middle" }}>Rec</span>}</span>
                  {rg.scoutsHere.length > 0 && <span style={{ display: "flex", gap: 2 }}>{rg.scoutsHere.map((s) => <span key={s.id} title={s.name + " scouting here"} style={{ fontSize: 9, fontWeight: 800, background: "var(--rouge)", color: "#fff", borderRadius: 999, width: 17, height: 17, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{s.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}</span>)}</span>}
                </div>
                <div style={{ fontSize: 9.5, color: "var(--mut)", margin: "1px 0 7px" }}>{rg.nats.join(" · ")}</div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 3 }}><span style={{ color: c.tx, fontWeight: 700 }}>{knowLabel(rg.know)}</span><span className="mono" style={{ color: "var(--mut)" }}>{rg.know}%</span></div>
                <div style={{ height: 5, background: "rgba(255,255,255,.07)", borderRadius: 3, overflow: "hidden" }}><div style={{ width: rg.know + "%", height: "100%", background: c.tx }} /></div>
                <div style={{ fontSize: 10, color: "var(--mut)", marginTop: 6 }}>{rg.knownCount} known · {rg.prospects.length} prospect{rg.prospects.length !== 1 ? "s" : ""}</div>
                {rg.recommended && <>
                  <div style={{ fontSize: 9.5, color: "var(--gold)", marginTop: 5, lineHeight: 1.3 }}>{rg.reason}</div>
                  <button className="btn sm" style={{ marginTop: 6, alignSelf: "flex-start" }} disabled={idleCount === 0} title={idleCount === 0 ? "No idle scouts" : "Send your best idle scout here"} onClick={(e) => { e.stopPropagation(); doSendBest(rg.key, rg.name); }}>Send best idle scout</button>
                </>}
              </div>;
            })}
          </div>
          {sel ? <div style={{ marginTop: 14, border: "1px solid var(--line)", borderRadius: 11, overflow: "hidden" }}>
            <div style={{ padding: "10px 13px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--card2)" }}>
              <div><b style={{ fontSize: 14 }}>{sel.name}</b> <span style={{ fontSize: 11, color: "var(--mut)" }}>· {sel.nats.join(", ")}</span>{sel.recommended && <span title="Recommended — high-opportunity region" style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--bg)", background: "var(--gold)", borderRadius: 5, padding: "1px 5px", marginLeft: 7, verticalAlign: "middle" }}>Rec</span>}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>{sel.recommended && idleCount > 0 && <button className="btn sm pri" onClick={() => doSendBest(sel.key, sel.name)}>Send best idle scout</button>}<span style={{ fontSize: 11.5, color: knowTint(sel.know).tx, fontWeight: 700 }}>{knowLabel(sel.know)} ({sel.know}%)</span></div>
            </div>
            <div style={{ padding: 13 }}>
              <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", fontWeight: 800, marginBottom: 7 }}>Assign a scout</div>
              {scouts.length === 0 ? <div style={{ fontSize: 12, color: "var(--mut)" }}>No scouts yet — hire one from the Hire tab.</div> :
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                  {scouts.map((sc) => { const here = sc.assign && sc.assign.type === "region" && sc.assign.region === sel.key; const fam = Math.round((sc.regionFam || {})[sel.key] || 0);
                    const whereElse = sc.assign ? (sc.assign.type === "region" ? scoutRegions().find((r) => r.key === sc.assign.region)?.name : sc.assign.type === "rider" ? "focus: " + (state.riders[sc.assign.lid]?.short || "—") : "") : "idle";
                    return <div key={sc.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 8px", borderRadius: 8, background: here ? "color-mix(in srgb, var(--green) 11%, transparent)" : "rgba(255,255,255,.02)", border: `1px solid ${here ? "color-mix(in srgb, var(--green) 35%, transparent)" : "var(--line)"}` }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{sc.name}</div>
                        <div style={{ fontSize: 10.5, color: "var(--mut)" }}>JPA {sc.jpa} · JPP {sc.jpp} · familiarity here: <b style={{ color: knowTint(fam).tx }}>{knowLabel(fam)}</b></div>
                      </div>
                      <span style={{ fontSize: 10.5, color: "var(--mut)" }}>{here ? "" : whereElse}</span>
                      <button className={"btn sm" + (here ? " pri" : "")} disabled={here} onClick={() => setAssign(sc, { type: "region", region: sel.key })}>{here ? "Here ✓" : "Send here"}</button>
                    </div>;
                  })}
                </div>
              }
              <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", fontWeight: 800, marginBottom: 7 }}>Known prospects in this region</div>
              {sel.prospects.length === 0 ? <div style={{ fontSize: 12, color: "var(--mut)" }}>Nothing identified yet. Send a scout and play on — names surface as knowledge grows.</div> :
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {sel.prospects.slice(0, 8).map(({ r, star }) => (
                    <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <Face rider={r} size={26} />
                      <span style={{ fontWeight: 600, fontSize: 12.5, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }} onClick={() => setDetail(r)}>{r.short}</span>
                      <Tag a={r.archetype} />
                      <span style={{ fontSize: 11, color: "var(--mut)" }}>{r.age}y</span>
                      <StarRow cur={star} pot={star} />
                      {watchers(r) > 0 && <span title={watchers(r) + " clubs scouting"} style={{ fontSize: 11, fontWeight: 700, color: watchers(r) >= 3 ? "var(--hot)" : "var(--mut)" }}>👁{watchers(r)}</span>}
                      {r.teamId == null && r.age <= 23 && <button className="btn sm pri" disabled={(t.devIds || []).length >= 6} title={`~${Math.round(odds(r) * 100)}%`} onClick={() => headhunt(r)}>Headhunt</button>}
                      {r.teamId != null && <button className="btn sm" title="shortlist" onClick={() => { toggleShortlist(state, r.id); refresh(); }}>{sl.has(r.id) ? "★" : "☆"}</button>}
                    </div>
                  ))}
                </div>
              }
            </div>
          </div> : <div style={{ marginTop: 14, padding: 18, textAlign: "center", color: "var(--mut)", fontSize: 12.5, border: "1px dashed var(--line)", borderRadius: 11 }}>Click a region to assign scouts and see who they've found.</div>}
        </div>;
      })()}

      {view === "reports" && (
        <div style={{ overflowX: "auto" }}>
          <div style={{ padding: "0 12px" }}>{repTools.toolbar}</div>
          <table className="tbl">
            <thead><tr><th></th>{repTools.th("Rider")}{repTools.th("Nat")}{repTools.th("Age", "Age", { className: "num" })}{repTools.th("Type")}{repTools.th("OVR", "Overall")}{repTools.th("POT", "Potential")}<th className="num">Hot</th><th className="num">Conf</th><th></th></tr></thead>
            <tbody>{repTools.list.map((r) => (
              <tr key={r.id}>
                <td style={{ cursor: "pointer", color: sl.has(r.id) ? "var(--gold)" : "var(--starOff)" }} onClick={() => { toggleShortlist(state, r.id); refresh(); }}>★</td>
                <td style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setDetail(r)}>{r.short}</td>
                <td className="mono" style={{ fontSize: 11, color: "var(--mut)" }}>{r.nation}</td>
                <td className="num mono">{r.age}</td>
                <td><Tag a={r.archetype} /></td>
                <td><EstO r={r} /></td><td><EstP r={r} /></td>
                <td className="num">{r.age <= 23 ? <Prom r={r} /> : <span style={{ color: "var(--mut)" }}>—</span>}</td>
                <td className="num"><Conf r={r} /></td>
                <td><span style={{ display: "flex", gap: 5, alignItems: "center" }}>{(() => { const wn = watchers(r); return wn > 0 ? <span title={wn + " rival club" + (wn > 1 ? "s" : "") + " scouting him — act before they do"} style={{ display: "inline-flex", alignItems: "center", fontSize: 11, fontWeight: 700, color: wn >= 3 ? "var(--hot)" : "var(--mut)" }}>👁{wn}</span> : null; })()}<button className="btn sm" onClick={() => focusRider(r.id)}>Focus</button>{r.teamId == null && r.age <= 23 && <button className="btn sm pri" disabled={(t.devIds || []).length >= 6} title={`~${Math.round(odds(r) * 100)}% chance`} onClick={() => headhunt(r)}>Headhunt</button>}{r.teamId == null && r.age > 23 && <button className="btn sm pri" disabled={(t.devIds || []).length >= 6} onClick={() => { signToDev(state, t, r); refresh(); }}>Sign</button>}</span></td>
              </tr>))}</tbody>
          </table>
          {repTools.list.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "var(--mut)", fontSize: 13 }}>No reports yet. Assign scouts to a region or the youth market and play on — intel builds race by race.</div>}
        </div>
      )}

      {view === "youth" && (
        <div>
          {youthRes.length > 0 && (
            <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)" }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--mut)", fontWeight: 800, marginBottom: 6 }}>Last season's U23 races</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
                {youthRes.map((yr, i) => (
                  <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "7px 9px", background: "var(--card2)" }}>
                    <div style={{ fontWeight: 700, fontSize: 12 }}>{yr.name}</div>
                    <div style={{ fontSize: 10, color: "var(--mut)", marginBottom: 3 }}>{yr.ft.replace("_", " ")}</div>
                    {yr.top.slice(0, 3).map((p) => { const r = state.riders[p.lid]; return <div key={p.lid} style={{ display: "flex", gap: 6, fontSize: 11.5, cursor: "pointer" }} onClick={() => r && setDetail(r)}><span className="mono" style={{ width: 16, color: p.place === 1 ? "var(--gold)" : "var(--mut)" }}>{p.place}</span><span style={{ flex: 1 }}>{r?.short || "?"}</span><span style={{ color: r?.teamId == null ? "var(--green)" : "var(--mut)", fontSize: 10 }}>{r?.teamId == null ? "free" : (state.teams[r?.teamId]?.name || "")}</span></div>; })}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ overflowX: "auto" }}>
            <div style={{ padding: "0 12px" }}>{youthTools.toolbar}</div>
            <table className="tbl">
              <thead><tr><th></th>{youthTools.th("Prospect")}{youthTools.th("Nat")}{youthTools.th("Age", "Age", { className: "num" })}{youthTools.th("Type")}{youthTools.th("OVR", "Overall")}{youthTools.th("POT", "Potential")}<th className="num">Hot</th><th className="num">Odds</th><th></th></tr></thead>
              <tbody>{youthTools.list.map((r) => (
                <tr key={r.id}>
                  <td style={{ cursor: "pointer", color: sl.has(r.id) ? "var(--gold)" : "var(--starOff)" }} onClick={() => { toggleShortlist(state, r.id); refresh(); }}>★</td>
                  <td style={{ cursor: "pointer", fontWeight: 600 }} onClick={() => setDetail(r)}>{r.short}</td>
                  <td className="mono" style={{ fontSize: 11, color: "var(--mut)" }}>{r.nation}</td>
                  <td className="num mono">{r.age}</td>
                  <td><Tag a={r.archetype} /></td>
                  <td><EstO r={r} /></td><td><EstP r={r} /></td>
                  <td className="num"><Prom r={r} /></td>
                  <td className="num mono" style={{ fontSize: 11, color: odds(r) >= 0.6 ? "var(--green)" : odds(r) >= 0.35 ? "var(--amber)" : "var(--red)" }}>{Math.round(odds(r) * 100)}%</td>
                  <td><button className="btn sm pri" disabled={(t.devIds || []).length >= 6} onClick={() => headhunt(r)}>Headhunt</button></td>
                </tr>))}</tbody>
            </table>
            {youthTools.list.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "var(--mut)", fontSize: 13 }}>No free youth on the market yet — a fresh crop turns pro each off-season. Scout the youth market to sharpen estimates.</div>}
          </div>
        </div>
      )}

      {view === "scouts" && (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead><tr><th>Scout</th><th>Judge ability</th><th>Judge potential</th><th>Specialty</th><th className="num">Salary</th><th>Assignment</th><th></th></tr></thead>
            <tbody>{scouts.map((sc) => { const type = !sc.assign ? "none" : sc.assign.type;
              const spec = Object.entries(sc.regionFam || {}).sort((a, b) => b[1] - a[1])[0];
              const specName = spec ? (scoutRegions().find((r) => r.key === spec[0])?.name || "—") : "—";
              return <tr key={sc.id}>
                <td style={{ fontWeight: 600 }}>{sc.name}</td>
                <td><StarRow cur={starOf(sc.jpa)} pot={starOf(sc.jpa)} /></td>
                <td><StarRow cur={starOf(sc.jpp)} pot={starOf(sc.jpp)} /></td>
                <td style={{ fontSize: 11 }}>{specName}{spec ? <span style={{ color: "var(--mut)" }}> · {knowLabel(Math.round(spec[1]))}</span> : null}</td>
                <td className="num mono">€{sc.salary.toFixed(2)}M</td>
                <td><span style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                  <select value={type === "rider" ? "rider" : type} onChange={(e) => { const v = e.target.value; if (v === "none") setAssign(sc, null); else if (v === "region") setAssign(sc, { type: "region", region: (sc.assign && sc.assign.region) || (spec && spec[0]) || "central" }); }}
                    style={{ fontSize: 11, padding: "2px 4px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--paper)", color: "var(--ink)" }}>
                    <option value="none">Unassigned</option><option value="region">Region</option>{type === "rider" && <option value="rider">Focus rider</option>}
                  </select>
                  {sc.assign && sc.assign.type === "region" && <select value={sc.assign.region} onChange={(e) => setAssign(sc, { type: "region", region: e.target.value })} style={{ fontSize: 11, padding: "2px 4px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--paper)", color: "var(--ink)" }}>{scoutRegions().map((rg) => <option key={rg.key} value={rg.key}>{rg.name}</option>)}</select>}
                  {sc.assign && sc.assign.type === "rider" && <span style={{ fontSize: 11, color: "var(--mut)" }}>→ {state.riders[sc.assign.lid]?.short || "—"}</span>}
                </span></td>
                <td><button className="btn sm" onClick={() => { if (confirm(`Release scout ${sc.name}?`)) { fireScout(state, sc.id); refresh(); } }}>Release</button></td>
              </tr>; })}</tbody>
          </table>
          {scouts.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "var(--mut)", fontSize: 13 }}>No scouts on staff — hire from the Hire tab.</div>}
        </div>
      )}

      {view === "hire" && (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead><tr><th>Scout</th><th>Judge ability</th><th>Judge potential</th><th>Region</th><th className="num">Salary</th><th></th></tr></thead>
            <tbody>{market.map((sc) => (
              <tr key={sc.id}>
                <td style={{ fontWeight: 600 }}>{sc.name}</td>
                <td><StarRow cur={starOf(sc.jpa)} pot={starOf(sc.jpa)} /></td>
                <td><StarRow cur={starOf(sc.jpp)} pot={starOf(sc.jpp)} /></td>
                <td className="mono" style={{ fontSize: 11 }}>{sc.region}</td>
                <td className="num mono">€{sc.salary.toFixed(2)}M</td>
                <td><button className="btn sm pri" onClick={() => { hireScout(state, sc.id); refresh(); }}>Hire</button></td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      {detail && <RiderModal state={state} rider={detail} onClose={() => setDetail(null)} godMode={false} refresh={refresh} />}
    </div>
  );
}

function CycleGM() {
  const [screen, setScreen] = React.useState("menu");      // menu | game
  const [leagues, setLeagues] = React.useState([]);
  const [state, setState] = React.useState(null);
  // make the sponsor dataset available for any loaded save (market/renewal), not just new leagues
  React.useEffect(() => { fetch(`${import.meta.env.BASE_URL}sponsors.json`).then((r) => r.ok && r.json()).then((j) => j && j.sponsors && setSponsorDB(j)).catch(() => {}); }, []);
  const [leagueId, setLeagueId] = React.useState(null);
  const [tab, setTab] = React.useState("dashboard");
  const [raceMode, setRaceMode] = React.useState(false);
  const [playOpen, setPlayOpen] = React.useState(false);
  const [msgModal, setMsgModal] = React.useState(null);   // root overlay: {type:result|rider|decision, ...}
  const [godMode, setGodMode] = React.useState(false);
  const [, force] = React.useReducer((x) => x + 1, 0);
  const refresh = () => { recountTeam(state); force(); save(); };

  React.useEffect(() => { if (screen === "menu") dbList().then((l) => setLeagues(l.sort((a, b) => b.updated - a.updated))); }, [screen]);

  const saveTimer = React.useRef(null);
  const save = React.useCallback(() => {
    if (!state || !leagueId) return;
    clearTimeout(saveTimer.current);                       // trailing debounce — every click used to serialize the whole league
    saveTimer.current = setTimeout(() => {
      const t = state.teams[state.userTeamId];
      dbPut({ id: leagueId, name: `${t.name} · ${state.season}`, updated: Date.now(), state });
    }, 800);
  }, [state, leagueId]);

  const startNew = (name, teamId, seed, db, sponsorDB) => {
    const st = newLeague({ seed: seed >>> 0, userTeamId: teamId, real: db ? false : undefined, sponsorDB });
    if (db) { try { applyRiderTeamDatabase(st, db, { sponsorDB }); } catch (e) { alert("Database import failed; starting with the built-in roster."); } }
    if (name && name.trim() && name.trim() !== "My Pro Team") { const ut = st.teams[st.userTeamId]; ut.name = name.trim(); ut.shortName = name.trim(); }   // the field used to be ignored
    const id = "lg_" + Date.now();
    setState(st); setLeagueId(id); setScreen("game"); setTab("dashboard");
    const rec = { id, name: `${st.teams[teamId].name} · ${st.season}`, updated: Date.now(), state: st };
    dbPut(rec); setLeagues((ls) => [{ ...rec }, ...ls]);   // same-session leagues used to vanish from the menu
  };
  const continueLeague = async (id) => { const rec = await dbGet(id); if (rec) { migrateState(rec.state); setState(rec.state); setLeagueId(id); setScreen("game"); setTab("dashboard"); } };
  const del = async (id) => { await dbDel(id); setLeagues((await dbList()).sort((a, b) => b.updated - a.updated)); };

  const exportSave = () => {
    const nm = state ? `${state.teams[state.userTeamId].name} · ${state.season}` : "CycleGM save";
    const blob = new Blob([JSON.stringify({ name: nm, state })], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "cyclegm-save.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const importSave = (file) => { const r = new FileReader(); r.onload = () => { try { const j = JSON.parse(r.result); if (!j?.state?.teams || !j.state.riders || !j.state.calendar) throw 0; const id = "lg_" + Date.now(); migrateState(j.state); const rec = { id, name: j.name || "Imported", updated: Date.now(), state: j.state }; dbPut(rec); setLeagues((ls) => [{ ...rec }, ...ls]); setState(j.state); setLeagueId(id); setScreen("game"); setTab("dashboard"); } catch (e) { alert("Could not read save file."); } }; r.readAsText(file); };

  // ---- actions ----
  const quickSim = () => { resolveRace(state); refresh(); };
  const skipTo = (i) => { skipToRace(state, i); refresh(); };
  const simToOffseason = () => { fastSimSeason(state); refresh(); };
  const finalizeOffseason = () => { setTab("dashboard"); refresh(); };
  const onRaceDone = () => { setRaceMode(false); setTab("dashboard"); refresh(); };
  // open a feed item as a focused overlay (result/rider/decision) or navigate (board/transfer)
  const openMsg = (item) => { const tgt = resolveMsgTarget(state, item); if (!tgt) return;
    if (tgt.kind === "nav") { setRaceMode(false); setTab(tgt.to); }
    else if (tgt.kind === "result") setMsgModal({ type: "result", rec: tgt.rec });
    else if (tgt.kind === "rider") setMsgModal({ type: "rider", rider: tgt.rider });
    else if (tgt.kind === "decision") setMsgModal({ type: "decision", ev: tgt.ev });
  };
  const openDecision = (ev) => setMsgModal({ type: "decision", ev });
  // the persistent "continue" loop: pop pending decisions one at a time, else open the next race, else head to the off-season
  const smartContinue = () => {
    setPlayOpen(false);
    const decisions = state.inbox || [];
    if (decisions.length > 0) { openDecision(decisions[0]); return; }
    const nr = state.calendar[state.calIndex];
    if (state.phase === "racing" && nr) { setRaceMode(true); return; }
    setRaceMode(false); setTab("offseason");
  };
  // Spacebar = Continue (only in-game, outside the race viewer which owns Space, and not while typing)
  React.useEffect(() => {
    if (screen !== "game" || raceMode || msgModal) return;   // a modal is open → its buttons drive; Space resumes once it closes
    const h = (e) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const el = document.activeElement, tag = el && el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el && el.isContentEditable)) return;
      e.preventDefault(); smartContinue();
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line
  }, [screen, raceMode, msgModal]);

  if (screen === "menu") {
    return <div className="gm"><style>{GCSS}</style><MenuScreen leagues={leagues} onNew={startNew} onContinue={continueLeague} onDelete={del} onImport={importSave} /></div>;
  }
  if (!state) return <div className="gm"><style>{GCSS}</style><div style={{ padding: 40 }}>Loading…</div></div>;

  const tabs = [["dashboard", "Dashboard", HomeIcon], ["inbox", "Inbox", ArchiveIcon], ["roster", "Roster", UsersIcon], ["plan", "Plan", ClipboardCheckIcon], ["development", "Development", TrendingUpIcon], ["academy", "Academy", UsersIcon], ["scouting", "Scouting", SearchIcon], ["finance", "Finances", DollarSignIcon], ["transfers", "Transfers", GitCompareArrowsIcon], ["calendar", "Calendar", CalendarDaysIcon], ["standings", "Standings", LayersIcon], ["history", "History", FileTextIcon]];
  const ut = state.teams[state.userTeamId];
  const nextRace = state.calendar[state.calIndex];
  const tierColor = ut.tier === "WorldTour" ? "var(--blue)" : ut.tier === "ProTeam" ? "var(--purple)" : "var(--mut)";
  const conf = state.boardConfidence ?? 62;
  const confColor = conf >= 66 ? "var(--green)" : conf >= 45 ? "var(--amber)" : "var(--red)";
  const inboxN = (state.inbox || []).length;
  return (
    <div className="gm"><style>{GCSS}</style>
      <div className="shell">
        <div className="side">
          <div className="logo"><span className="logomark" />Cycle<span>GM</span></div>
          <div className="navv">
            {tabs.map(([k, l, Ico]) => <NavTab key={k} icon={Ico} label={l} active={!raceMode && tab === k} onClick={() => { setRaceMode(false); setTab(k); }} badge={k === "inbox" && inboxN > 0 ? <span className="badge">{inboxN}</span> : null} />)}
          </div>
          <div style={{ marginTop: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 4, borderTop: "1px solid var(--line)" }}>
            <button className="btn sm" onClick={() => setGodMode((g) => !g)} title="Edit ratings">{godMode ? "God mode: on" : "God mode"}</button>
            <button className="btn sm" onClick={exportSave}>Export save</button>
            <button className="btn sm" onClick={() => setScreen("menu")}>Switch league</button>
          </div>
        </div>
        <div className="main">
          <div className="topbar">
            <span className="tdot" style={{ background: ut.jersey }} />
            <span className="tt">{ut.name}</span>
            <span className="tierpill" style={{ background: tierColor }}>{ut.tier}</span>
            <span className="tmeta">{state.season}{nextRace ? ` · week ${nextRace.week}` : " · season over"}</span>
            <div className="spacer" />
            <span className="mono" style={{ fontSize: 11, color: "var(--mut)" }}><b style={{ color: "var(--ink)", fontWeight: 700 }}>{money(ut.budget)}</b> budget</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--mut)" }}><b style={{ color: confColor, fontWeight: 700 }}>{conf}%</b> board</span>
            <div className="play">
              {state.phase === "racing" ? (
                <div className="splitbtn">
                  <button className="playbtn sb-main" onClick={smartContinue} title="Continue (Space)">{inboxN > 0 ? `▶ ${inboxN} decision${inboxN > 1 ? "s" : ""}` : "▶ Continue"}</button>
                  <button className="playbtn sb-caret" onClick={() => setPlayOpen((o) => !o)} title="More options">▾</button>
                </div>
              ) : (
                <button className="playbtn" onClick={smartContinue}>Off-season →</button>
              )}
              {playOpen && state.phase === "racing" && <div className="playmenu" onMouseLeave={() => setPlayOpen(false)}>
                <button onClick={() => { setPlayOpen(false); setRaceMode(true); }}>Open next race weekend</button>
                <button onClick={() => { setPlayOpen(false); quickSim(); }}>Quick-sim next race</button>
                <button onClick={() => { setPlayOpen(false); simToOffseason(); }}>Sim to end of season</button>
              </div>}
            </div>
          </div>

          <div className="gm-wrap" style={{ paddingTop: 16 }}>
        {raceMode ? <RaceWeekend state={state} onDone={onRaceDone} />
          : tab === "dashboard" ? <Dashboard state={state} go={(t) => setTab(t)} openRace={() => setRaceMode(true)} doSim={quickSim} openMsg={openMsg} />
          : tab === "inbox" ? <Inbox state={state} refresh={refresh} openMsg={openMsg} />
          : tab === "development" ? <Development state={state} refresh={refresh} />
          : tab === "academy" ? <Academy state={state} refresh={refresh} go={(t) => setTab(t)} />
          : tab === "scouting" ? <Scouting state={state} refresh={refresh} />
          : tab === "roster" ? <Roster state={state} refresh={refresh} godMode={godMode} />
          : tab === "plan" ? <SeasonPlan state={state} refresh={refresh} />
          : tab === "finance" ? <Finance state={state} refresh={refresh} />
          : tab === "transfers" ? <Transfers state={state} refresh={refresh} />
          : tab === "calendar" ? <Calendar state={state} skipTo={skipTo} />
          : tab === "standings" ? <Standings state={state} />
          : tab === "history" ? <History state={state} />
          : tab === "offseason" ? <OffSeason state={state} refresh={refresh} finalize={finalizeOffseason} />
          : null}
        {state.phase === "offseason" && !raceMode && tab !== "offseason" && (
          <div style={{ marginTop: 14, textAlign: "center" }}><button className="btn red" onClick={() => setTab("offseason")}>Season over — go to off-season →</button></div>
        )}
        </div>
        </div>
      </div>
      {msgModal && msgModal.type === "result" && <ResultModal state={state} rec={msgModal.rec} onClose={() => setMsgModal(null)} onRider={(r) => setMsgModal({ type: "rider", rider: r })} />}
      {msgModal && msgModal.type === "rider" && <RiderModal state={state} rider={msgModal.rider} onClose={() => setMsgModal(null)} godMode={false} refresh={refresh} />}
      {msgModal && msgModal.type === "decision" && <DecisionModal state={state} ev={msgModal.ev} onClose={() => setMsgModal(null)} onResolve={(i) => { resolveEvent(state, msgModal.ev.id, i); setMsgModal(null); refresh(); }} />}
    </div>
  );
}

function MenuScreen({ leagues, onNew, onContinue, onDelete, onImport }) {
  const [mode, setMode] = React.useState(leagues.length ? "home" : "new");
  const [name, setName] = React.useState("My Pro Team");
  const [seed, setSeed] = React.useState(Math.floor(Math.random() * 99999));
  const [teamId, setTeamId] = React.useState(0);
  const [ptier, setPtier] = React.useState("WorldTour");
  const [dbData, setDbData] = React.useState(null);
  const [dbStd, setDbStd] = React.useState(false);   // true = the bundled standard DB (not a manual import)
  const [sponsorDB, setSponsorDB] = React.useState(null);
  // load the bundled standard rider/team DB + sponsor dataset by default; a manual import overrides the rider DB.
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}riderdb.json`);
        if (res.ok) { const j = await res.json(); if (alive && j && Array.isArray(j.teams) && Array.isArray(j.riders)) { let applied = false; setDbData((cur) => { applied = !cur; return cur || j; }); if (applied) setDbStd(true); } }
      } catch (e) { /* offline / missing file → fall back to the built-in roster */ }
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}sponsors.json`);
        if (res.ok) { const j = await res.json(); if (alive && j && Array.isArray(j.sponsors)) setSponsorDB(j); }
      } catch (e) { /* offline → procedural sponsor names */ }
    })();
    return () => { alive = false; };
  }, []);
  const dSeed = React.useDeferredValue(seed);   // world-gen is heavy — don't rebuild 60 teams on every keystroke
  const preview = React.useMemo(() => { const st = newLeague({ seed: dSeed >>> 0, userTeamId: 0, real: dbData ? false : undefined, sponsorDB }); if (dbData) { try { applyRiderTeamDatabase(st, dbData, { sponsorDB }); } catch (e) {} } return st; }, [dSeed, dbData, sponsorDB]);
  const loadDb = (file) => { const r = new FileReader(); r.onload = () => { try { const j = JSON.parse(r.result); if (!j || !Array.isArray(j.teams) || !Array.isArray(j.riders)) throw 0; setDbData(j); setDbStd(false); setTeamId(0); } catch (e) { alert("Could not read this rider/team database JSON."); } }; r.readAsText(file); };
  React.useEffect(() => { if (!leagues.length) setMode("new"); }, [leagues.length]);
  return (
    <div className="menu">
      <h1>CYCLE<span>GM</span></h1>
      <div className="sub">A cycling manager — race a season of classics &amp; grand tours across a three-tier pyramid. Start in the WorldTour, or take a Continental minnow and climb.</div>

      {mode === "home" && (
        <div className="card">
          <div className="ph">Your leagues<button className="btn sm" onClick={() => setMode("new")}>+ New</button></div>
          {leagues.map((l) => (
            <div className="lg" key={l.id}>
              <div style={{ flex: 1 }}><b>{l.name}</b><div style={{ fontSize: 11, color: "var(--mut)" }}>saved {new Date(l.updated).toLocaleString()}</div></div>
              <button className="btn pri sm" onClick={() => onContinue(l.id)}>Continue</button>
              <button className="btn sm" onClick={() => { if (confirm("Delete this league?")) onDelete(l.id); }}>Delete</button>
            </div>
          ))}
          {leagues.length === 0 && <div style={{ padding: 18, color: "var(--mut)" }}>No saved leagues.</div>}
          <div className="lg"><label className="btn sm" style={{ cursor: "pointer" }}>Import save…<input type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => e.target.files[0] && onImport(e.target.files[0])} /></label></div>
        </div>
      )}

      {mode === "new" && (
        <div className="card" style={{ padding: 16 }}>
          <div className="field"><label>Team name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label>World seed</label><div style={{ display: "flex", gap: 8 }}><input className="mono" type="number" value={seed} onChange={(e) => setSeed(+e.target.value || 0)} style={{ flex: 1 }} /><button className="btn" onClick={() => setSeed(Math.floor(Math.random() * 99999))}>⟳</button></div></div>
          <div className="field"><label>Rider/team database</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label className="btn sm" style={{ cursor: "pointer" }}>Import custom DB…<input type="file" accept="application/json,.json" style={{ display: "none" }} onChange={(e) => e.target.files[0] && loadDb(e.target.files[0])} /></label>
              <span style={{ fontSize: 11, color: dbData ? "var(--green)" : "var(--mut)" }} className="mono">{dbData ? `${dbStd ? "standard DB" : "custom DB"} · ${dbData.teams.length} teams · ${dbData.riders.length} riders` : "loading standard DB…"}</span>
            </div>
          </div>
          <div className="field"><label>Choose your division &amp; team</label>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              {TIERS.map((tr) => { const n = preview.teams.filter((t) => t.tier === tr).length; return <button key={tr} className={"btn sm" + (ptier === tr ? " pri" : "")} onClick={() => setPtier(tr)}>{tr} <span style={{ opacity: 0.7 }}>({n})</span></button>; })}
            </div>
            <div className="teamgrid">
              {preview.teams.filter((t) => t.tier === ptier).map((t) => { const best = t.riderIds.length ? Math.max(...t.riderIds.map((id) => preview.riders[id]?.overall || 0)) : 0; return (
                <div key={t.id} className={"teamopt" + (teamId === t.id ? " on" : "")} onClick={() => setTeamId(t.id)}>
                  <span className="chip" style={{ background: t.jersey, width: 14, height: 14 }} />
                  <div style={{ flex: 1, overflow: "hidden" }}><div style={{ fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div><div style={{ fontSize: 10.5, color: "var(--mut)" }} className="mono">prestige {t.prestige} · top {best}</div></div>
                </div>
              ); })}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn red" style={{ flex: 1 }} onClick={() => onNew(name, teamId, seed, dbData, sponsorDB)}>Start career →</button>
            {leagues.length > 0 && <button className="btn" onClick={() => setMode("home")}>Cancel</button>}
          </div>
          <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 10, textAlign: "center" }}>Tip: lower-prestige teams = the harder, more rebuilding-focused game.</div>
        </div>
      )}
    </div>
  );
}

export default CycleGM;

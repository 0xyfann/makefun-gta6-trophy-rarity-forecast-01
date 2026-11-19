/** Offline, deterministic trophy forecasts. Node 22; no packages or network.
 * Fit refreshes, not repeated polls. Separate pre-release holders from adoption.
 * All percentages below use 0..100, and all durations use hours.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

type Trophy = { id: number; name: string; description: string; tier: string };
type Reading = { slot: string; at: string; players_tracked: number; rates: (number | null)[] };
export type Case = {
  schema?: string;
  id: string; at: string; target: string; horizon_minutes: number; levels: number[];
  game: { release_date: string }; trophies: Trophy[]; history: Reading[];
};
type State = { time: number; players: number; rates: (number | null)[] };
type Point = { x: number; y: number; weight: number };
type Line = { slope: number; error: number; information: number };
type Profile = { family: string; slope: number; ceiling: number; delay: number };
export type Forecast = { trophies: { id: number; q: number[] }[] };

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const NORMAL = [-1.644853626951, -0.674489750196, 0, 0.674489750196, 1.644853626951];
const bound = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const average = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const hour = (iso: string) => Date.parse(iso) / 3600000;
const logOdds = (pct: number) => {
  const p = bound(pct, 0.01, 99.99) / 100;
  return Math.log(p) - Math.log1p(-p);
};
const percent = (logit: number) => 100 / (1 + Math.exp(-bound(logit, -40, 40)));
const median = (values: number[]) => {
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length ? (v[m] + v[v.length - 1 - m]) / 2 : 0;
};

/** Weak gameplay priors; rates and observed changes dominate once available. */
function profile(t: Trophy): Profile {
  const text = `${t.name} ${t.description}`.toLowerCase();
  if (t.tier === 'platinum' || /100% completion/.test(text)) {
    return { family: 'completion', slope: 2.3, ceiling: 8, delay: 50 };
  }
  if (/chapter\s*1\b/.test(text)) return { family: 'story', slope: 1.2, ceiling: 92, delay: 7 };
  if (/chapter\s*2\b/.test(text)) return { family: 'story', slope: 1.6, ceiling: 83, delay: 15 };
  if (/chapter\s*3\b/.test(text)) return { family: 'story', slope: 1.9, ceiling: 72, delay: 25 };
  if (/chapter\s*4\b|complete the final mission\./.test(text)) {
    return { family: 'story', slope: 2.1, ceiling: 65, delay: 38 };
  }
  if (/complete (gone fishing|breakfast run|the cartel heist|child's play|headliners|vcia takedown|operation savage glory)/.test(text)) {
    return { family: 'story', slope: 1.7, ceiling: 80, delay: 20 };
  }
  if (/\ball\b|\bevery\b|250 stunts|100 locations|50 challenges|100 vehicles|collectible/.test(text)) {
    return { family: 'collection', slope: 1.9, ceiling: 25, delay: 32 };
  }
  if (/final mission for|mission strands|20 different races|bank vaults/.test(text)) {
    return { family: 'side', slope: 1.6, ceiling: 40, delay: 22 };
  }
  return { family: 'activity', slope: 1.1, ceiling: 60, delay: 8 };
}

/** Ridge slope around a prior, then one Huber reweighting pass. */
function fit(points: Point[], prior: number, penalty: number): Line {
  if (points.length < 2) return { slope: prior, error: 0, information: 0 };
  let weights = points.map(p => p.weight);
  let slope = prior;
  let error = 0;
  let information = 0;
  for (let pass = 0; pass < 2; pass++) {
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const mx = points.reduce((s, p, i) => s + weights[i] * p.x, 0) / total;
    const my = points.reduce((s, p, i) => s + weights[i] * p.y, 0) / total;
    const xx = points.reduce((s, p, i) => s + weights[i] * (p.x - mx) ** 2, 0);
    const xy = points.reduce((s, p, i) => s + weights[i] * (p.x - mx) * (p.y - my), 0);
    slope = (xy + penalty * prior) / (xx + penalty);
    const residuals = points.map(p => p.y - my - slope * (p.x - mx));
    error = Math.sqrt(residuals.reduce((s, r, i) => s + weights[i] * r * r, 0) / total);
    information = xx / (xx + penalty);
    const scale = Math.max(0.12, 1.5 * median(residuals.map(Math.abs)));
    weights = points.map((p, i) => p.weight * Math.min(1, scale / Math.max(1e-9, Math.abs(residuals[i]))));
  }
  return { slope, error, information };
}

/** A plateau of identical polls contributes a single observation. */
function refreshes(c: Case): State[] {
  const release = hour(`${c.game.release_date.slice(0, 10)}T00:00:00Z`);
  const cutoff = hour(c.at);
  const states: State[] = [];
  const reads = [...c.history].filter(r => hour(r.slot || r.at) < cutoff)
    .sort((a, b) => hour(a.slot || a.at) - hour(b.slot || b.at));
  let signature = '';
  let previousRates: (number | null)[] = c.trophies.map(() => null);
  for (const r of reads) {
    if (!Number.isFinite(r.players_tracked) || r.players_tracked <= 0) continue;
    const rates = c.trophies.map((_, i) => {
      const v = r.rates[i];
      return typeof v === 'number' && Number.isFinite(v) ? bound(v, 0, 100) : null;
    });
    // Missing values are unavailable observations, not changes in the page.
    const effectiveRates = rates.map((v, i) => v === null ? previousRates[i] : v);
    const next = JSON.stringify([r.players_tracked, effectiveRates]);
    previousRates = effectiveRates;
    const restoredObservation = states.length > 0 && rates.some((v, i) =>
      v !== null && states[states.length - 1].rates[i] === null);
    if (next !== signature || restoredObservation) {
      states.push({ time: hour(r.slot || r.at) - release, players: r.players_tracked, rates });
      signature = next;
    }
  }
  if (!states.length) throw new Error('Case has no usable pre-checkpoint readings');
  return states;
}

function lastKnown(states: State[], i: number): { rate: number; state: State } {
  for (let j = states.length - 1; j >= 0; j--) {
    const r = states[j].rates[i];
    if (r !== null) return { rate: r, state: states[j] };
  }
  return { rate: 0, state: states[states.length - 1] };
}

/** Population power curve, learned only at distinct count updates. */
function population(states: State[], target: number): { ratio: number; spread: number } {
  const last = states[states.length - 1];
  const points: Point[] = [];
  let previousPlayers = -1;
  let populationTime = last.time;
  for (const s of states) {
    if (s.players !== previousPlayers) {
      points.push({ x: Math.log1p(Math.max(0, s.time) / 6), y: Math.log(s.players), weight: 1 });
      previousPlayers = s.players;
      populationTime = s.time;
    }
  }
  const line = fit(points.slice(-12), 0.9, 0.25);
  // A rate-only update does not make the cached population count newer.
  const dx = Math.log((Math.max(0, target) + 6) / (Math.max(0, populationTime) + 6));
  return { ratio: Math.exp(bound(line.slope, 0, 2) * Math.max(0, dx)),
    spread: Math.max(0.18, line.error) + 0.22 * Math.max(0, dx) };
}

/** Pre-release completions are a contamination floor, not launch-day progress. */
function seedHolders(states: State[], i: number): number {
  const first = states[0];
  const r = first.rates[i];
  if (first.time > 1 || r === null || r > 5) return 0;
  return Math.max(0, Math.round(first.players * r / 100));
}

/** No observed refresh: an explicit launch-cohort dilution prior. */
function coldStart(states: State[], i: number, p: Profile, target: number): number[] {
  const { rate, state } = lastKnown(states, i);
  if (rate === 100) return [100, 100, 100, 100, 100];
  // The population's age must not reset when an unrelated trophy changes.
  const age = Math.max(0, target - states[0].time);
  // Launch-night trackers are highly selected. A stale population is not a random walk.
  const dilution = 1 + 1.1 * Math.min(age, 12);
  const oldCount = rate * state.players / 100;
  const progress = 1 + 0.35 * (age / Math.max(6, p.delay)) ** 1.5;
  const centerRate = Math.min(99.99, rate * progress / dilution);
  const center = logOdds(centerRate);
  const uncertainty = 0.48 + 0.16 * Math.log1p(age) + 0.3 / Math.sqrt(oldCount + 1);
  return NORMAL.map(z => percent(center + z * uncertainty));
}

export function forecast(c: Case): Forecast {
  if (c.schema !== undefined && c.schema !== 'makefun/gta6-trophies-case/v1') {
    throw new Error('Unsupported case schema');
  }
  if (JSON.stringify(c.levels) !== JSON.stringify(LEVELS)) throw new Error('Unsupported quantiles');
  if (!c.trophies.length || !c.history.length) throw new Error('Empty case');
  const states = refreshes(c);
  const last = states[states.length - 1];
  const release = hour(`${c.game.release_date.slice(0, 10)}T00:00:00Z`);
  const target = hour(c.target) - release;
  if (!Number.isFinite(target) || target < hour(c.at) - release) throw new Error('Invalid target');
  const future = Math.max(0, target - last.time);
  const pop = population(states, target);
  const profiles = c.trophies.map(profile);
  const hasPopulationRefresh = new Set(states.map(s => s.players)).size > 1;
  const lines = c.trophies.map((_, i) => {
    const p = profiles[i];
    const floor = seedHolders(states, i);
    const points = states.filter(s => s.rates[i] !== null && s.time >= Math.max(1, last.time - 40))
      .map(s => {
        const count = s.players * (s.rates[i] as number) / 100;
        const organic = Math.max(0, count - floor);
        const reliability = organic / (organic + 5);
        return { x: Math.log1p(Math.max(0, s.time) / 6),
          y: logOdds(100 * (organic + 0.5) / (s.players + 1)),
          weight: reliability * Math.exp((s.time - last.time) / 36) };
      }).filter(p => p.weight > 0.02);
    return fit(points, p.slope, 0.18);
  });
  const groups = new Map<string, number[]>();
  lines.forEach((line, i) => {
    if (line.information < 0.15) return;
    const key = profiles[i].family;
    const list = groups.get(key) || [];
    list.push(bound(line.slope, -1, 4));
    groups.set(key, list);
  });
  const rows = c.trophies.map((t, i) => {
    const p = profiles[i];
    const known = lastKnown(states, i);
    let quantiles: number[];
    if (target <= known.state.time) {
      quantiles = LEVELS.map(() => known.rate);
    } else if (!hasPopulationRefresh && last.time < 12) {
      quantiles = coldStart(states, i, p, target);
    } else {
      const observed = states.filter(s => s.rates[i] !== null);
      if (known.rate === 100 && observed.every(s => s.rates[i] === 100)) {
        quantiles = [100, 100, 100, 100, 100];
      } else {
        const floor = seedHolders(states, i);
        const n = known.state.players;
        const count = known.rate * n / 100;
        const organic = Math.max(0, count - floor);
        const family = groups.get(p.family) || [];
        const shared = family.length >= 3 ? median(family) : p.slope;
        const info = lines[i].information;
        const slope = bound(info * lines[i].slope + (1 - info) * shared, -1.0, 4);
        const elapsed = Math.max(0, target - known.state.time);
        const dx = Math.log((Math.max(0, target) + 6) / (Math.max(0, known.state.time) + 6));
        const damping = 1 / (1 + 0.12 * Math.max(0, dx));
        // Do not let half-count smoothing manufacture organic progress from four reviewers.
        const organicRate = 100 * organic / n;
        const start = logOdds(Math.max(0.001, organicRate));
        let adopted = organic === 0 ? 0 : percent(start + slope * dx * damping);
        // Very weak delay-aware floor allows genuinely new completions over a long horizon.
        const priorMass = p.ceiling * (1 - Math.exp(-Math.max(0, target - p.delay) / 100)) ** 2;
        const priorWeight = 0.10 * (1 - info) * Math.min(1, elapsed / 72);
        adopted = (1 - priorWeight) * adopted + priorWeight * priorMass;
        const ceiling = Math.max(p.ceiling, organicRate);
        if (adopted > organicRate && ceiling < 99.9) {
          const room = Math.max(0.01, ceiling - organicRate);
          adopted = organicRate + room * (1 - Math.exp(-(adopted - organicRate) / room));
        }
        // Population is projected from the latest global refresh, even if this
        // particular trophy was missing there and its last known rate is older.
        const carried = 100 * Math.min(floor, count) / (last.players * pop.ratio);
        const adoptionCenter = logOdds(bound(adopted + carried, 0.001, 99.999));
        // A direct-rate view protects against over-subtracting an inaccurate seed floor.
        const direct = observed.slice(-10).map(s => ({
          x: Math.log1p(Math.max(0, s.time) / 6), y: logOdds(s.rates[i] as number),
          weight: Math.exp((s.time - last.time) / 24),
        }));
        const directLine = fit(direct, 0, 0.25);
        const directCenter = logOdds(known.rate) + bound(directLine.slope, -1.5, 3) * dx * damping;
        const directWeight = floor > 0 ? 0.15 * Math.min(1, organic / (floor + 1)) : 0.3;
        const center = (1 - directWeight) * adoptionCenter + directWeight * directCenter;
        const disagreement = Math.abs(adoptionCenter - directCenter);
        const stale = Math.max(0, last.time - known.state.time);
        const noise = 0.18 + 0.38 * Math.sqrt((future + stale) / 24);
        const slopeRisk = Math.abs(dx) * (0.25 + 0.5 * (1 - info));
        const countRisk = 0.7 / Math.sqrt(count + 1);
        const spread = Math.min(2.5, Math.sqrt(noise ** 2 + slopeRisk ** 2 + countRisk ** 2
          + lines[i].error ** 2 + (0.3 * disagreement) ** 2 + (0.2 * pop.spread) ** 2));
        quantiles = NORMAL.map(z => percent(center + z * spread));
      }
    }
    return { id: t.id, q: quantiles.map(v => Math.round(bound(v, 0, 100) * 1e6) / 1e6) };
  });
  return { trophies: rows };
}

export function run(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  fs.mkdirSync(outputDir, { recursive: true });
  const files = fs.readdirSync(inputDir).filter(name => name.endsWith('.in')).sort();
  for (const file of files) {
    const c = JSON.parse(fs.readFileSync(path.join(inputDir, file), 'utf8')) as Case;
    const result = JSON.stringify(forecast(c)) + '\n';
    if (Buffer.byteLength(result, 'utf8') > 65536) throw new Error('Output too large');
    fs.writeFileSync(path.join(outputDir, file.slice(0, -3) + '.out'), result, { encoding: 'utf8' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) run();

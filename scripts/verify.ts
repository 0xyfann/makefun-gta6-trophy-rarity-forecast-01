/** Independent contract checks and scorer. Run: node scripts/verify.ts --input DIR
 * Optional --answer reference/answer.json computes ACTUAL scores, never a proxy.
 * Without --answer, official metrics are explicitly null; stress tests are labeled.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { forecast, type Case, type Forecast } from '../main.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAUS = [0.05, 0.25, 0.5, 0.75, 0.95];
const ZS = [-1.645, -0.674, 0, 0.674, 1.645];
const clamp = (v: number) => Math.max(0.01, Math.min(99.99, v));
const lg = (v: number) => Math.log(clamp(v) / (100 - clamp(v)));
type RowScore = { loss: number; typical_miss_pp: number; coverage_90: number; trophies: number };

function metrics(f: Forecast, actual: Map<number, number>): RowScore {
  let loss = 0, miss = 0, covered = 0;
  for (const row of f.trophies) {
    const y = actual.get(row.id);
    assert.equal(typeof y, 'number', `No answer for trophy ${row.id}`);
    assert.ok(Number.isFinite(y) && y! >= 0 && y! <= 100, 'Invalid answer rate');
    row.q.forEach((q, j) => {
      const d = lg(y!) - lg(q);
      loss += 2 * Math.max(TAUS[j] * d, (TAUS[j] - 1) * d);
    });
    miss += Math.abs(y! - row.q[2]);
    if (row.q[0] <= y! && y! <= row.q[4]) covered++;
  }
  const n = f.trophies.length;
  return { loss: loss / (5 * n), typical_miss_pp: miss / n, coverage_90: covered / n, trophies: n };
}

/** Reimplement the published baseline equation, with its four-decimal rounding. */
function baseline(c: Case): Forecast {
  const last = c.history[c.history.length - 1];
  const sigma = 0.5 * Math.sqrt(c.horizon_minutes / 1440);
  return { trophies: c.trophies.map((t, i) => ({ id: t.id,
    q: ZS.map(z => Math.round(100 / (1 + Math.exp(-(lg(last.rates[i] ?? 0) + z * sigma))) * 10000) / 10000),
  })) };
}

function contract(c: Case, content: Buffer): Forecast {
  assert.ok(content.length <= 65536, 'Output exceeds size cap');
  const f = JSON.parse(content.toString('utf8')) as Forecast;
  assert.deepEqual(Object.keys(f), ['trophies']);
  assert.ok(Array.isArray(f.trophies));
  assert.equal(f.trophies.length, c.trophies.length);
  const expected = c.trophies.map(t => t.id).sort((a, b) => a - b);
  assert.deepEqual(f.trophies.map(t => t.id).sort((a, b) => a - b), expected, 'Wrong/duplicate trophy IDs');
  for (const row of f.trophies) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'q']);
    assert.ok(Array.isArray(row.q));
    assert.equal(row.q.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(typeof row.q[i], 'number');
      assert.ok(Number.isFinite(row.q[i]) && row.q[i] >= 0 && row.q[i] <= 100);
      if (i) assert.ok(row.q[i] >= row.q[i - 1], 'Crossing quantiles');
    }
  }
  return f;
}

function aggregate(rows: RowScore[]): RowScore | null {
  const trophies = rows.reduce((s, r) => s + r.trophies, 0);
  if (!trophies) return null;
  return { loss: rows.reduce((s, r) => s + r.loss * r.trophies, 0) / trophies,
    typical_miss_pp: rows.reduce((s, r) => s + r.typical_miss_pp * r.trophies, 0) / trophies,
    coverage_90: rows.reduce((s, r) => s + r.coverage_90 * r.trophies, 0) / trophies, trophies };
}

function answerFor(document: any, c: Case): Map<number, number> {
  assert.equal(document.schema, 'makefun/gta6-trophies-answer/v1', 'Wrong reference schema');
  const cases = Array.isArray(document.cases) ? document.cases : Object.values(document.cases || {});
  const found = cases.find((entry: any) => entry.id === c.id) as any;
  assert.ok(found, `Reference missing ${c.id}`);
  if (found.target) assert.equal(found.target, c.target, 'Reference target mismatch');
  const rows = found.trophies;
  assert.ok(Array.isArray(rows), 'Expected reference cases[].trophies[] with id/actual');
  const result = new Map<number, number>();
  for (const row of rows) {
    assert.ok(!result.has(row.id), 'Duplicate reference trophy');
    assert.equal(typeof row.actual, 'number', 'Reference actual is not a number');
    result.set(row.id, row.actual);
  }
  assert.deepEqual([...result.keys()].sort((a, b) => a - b), c.trophies.map(t => t.id).sort((a, b) => a - b));
  return result;
}

function scorerChecks(): void {
  const f = { trophies: [1, 2].map(id => ({ id, q: [10, 15, 20, 25, 35] })) };
  const m = metrics(f, new Map([[1, 22], [2, 8]]));
  assert.ok(Math.abs(m.loss - 0.403404) < 1e-6, 'Published scoring example failed');
  assert.equal(m.typical_miss_pp, 7);
  assert.equal(m.coverage_90, 0.5);
  const equal = { trophies: [{ id: 1, q: [20, 20, 20, 20, 20] }] };
  assert.ok(Math.abs(metrics(equal, new Map([[1, 8]])).loss - Math.abs(lg(8) - lg(20))) < 1e-12);
  assert.equal(metrics({ trophies: [{ id: 1, q: [0, 0, 0, 0, 0] }] }, new Map([[1, 0]])).loss, 0);
  const caseMetadata = { id: 'synthetic-parser', target: '2026-11-26T00:00:00Z',
    trophies: [{ id: 1 }] } as Case;
  const reference = { schema: 'makefun/gta6-trophies-answer/v1', cases: [{
    id: caseMetadata.id, target: caseMetadata.target, trophies: [{ id: 1, actual: 8 }],
  }] };
  assert.equal(answerFor(reference, caseMetadata).get(1), 8);
  reference.cases[0].target = '2026-11-25T00:00:00Z';
  assert.throws(() => answerFor(reference, caseMetadata), /target mismatch/);
}

function syntheticChecks(source: Case): { checks: string[]; final_adoption_test: { ours: RowScore; baseline: RowScore } } {
  const checks: string[] = [];
  const clone = (): Case => {
    const c = JSON.parse(JSON.stringify(source)) as Case;
    const rates = c.trophies.map((_, i) => i === 1 ? 100 : 1 + (i % 5) / 10);
    c.id = 'synthetic-launch';
    c.at = '2026-11-19T03:00:00Z'; c.target = '2026-11-19T04:30:00Z'; c.horizon_minutes = 90;
    c.history = ['2026-11-18T23:50:00Z', '2026-11-19T02:30:00Z'].map(slot =>
      ({ slot, at: slot, players_tracked: 638, rates: [...rates] }));
    return c;
  };
  let c = clone();
  c.history = [c.history[0]];
  c.history[0].rates = c.trophies.map((_, i) => i === 0 ? null : (i === 1 ? 100 : 0));
  contract(c, Buffer.from(JSON.stringify(forecast(c))));
  checks.push('null rates and exact 0/100');
  c = clone();
  const launchForecast = forecast(c);
  const lastLaunch = c.history[c.history.length - 1];
  lastLaunch.rates[4] = null;
  assert.deepEqual(forecast(c), launchForecast, 'Missing value fabricated a refresh');
  lastLaunch.rates[4] = (c.history[0].rates[4] ?? 0) + 0.01;
  const changedLaunch = forecast(c);
  assert.deepEqual(changedLaunch.trophies[0], launchForecast.trophies[0],
    'Unrelated rate-only change reset the population dilution prior');
  checks.push('missing/unrelated trophy cannot fabricate population refresh');
  const restoration: Case = {
    schema: 'makefun/gta6-trophies-case/v1', id: 'synthetic-restoration',
    at: '2026-11-20T02:00:00Z', target: '2026-11-21T00:00:00Z', horizon_minutes: 1320,
    levels: TAUS, game: { release_date: '2026-11-19' },
    trophies: [{ id: 1, name: 'Activity', description: 'Try an activity.', tier: 'bronze' }],
    history: [
      { slot: '2026-11-18T23:50:00Z', at: '2026-11-18T23:50:00Z', players_tracked: 638, rates: [1] },
      { slot: '2026-11-20T00:00:00Z', at: '2026-11-20T00:00:00Z', players_tracked: 10000, rates: [null] },
    ],
  };
  const withoutRestoration = forecast(restoration);
  restoration.history.push({ slot: '2026-11-20T01:00:00Z', at: '2026-11-20T01:00:00Z',
    players_tracked: 10000, rates: [1] });
  assert.notDeepEqual(forecast(restoration), withoutRestoration, 'Restored rate was ignored at new population');
  checks.push('restored rate after missing population refresh is retained');
  c = clone();
  c.history[0].players_tracked = 2500;
  c.history[0].slot = '2026-11-19T05:00:00Z';
  c.history[0].at = c.history[0].slot;
  c.at = '2026-11-21T11:30:00Z'; c.target = '2026-11-26T00:00:00Z'; c.horizon_minutes = 6510;
  c.history = [c.history[0]];
  // A deterministic adoption curve + seed contamination, evaluated at multiple refreshes.
  const initialRates = [...c.history[0].rates];
  for (const age of [12, 24, 36, 48, 58]) {
    const n = Math.round(2500 * Math.pow(1 + age / 6, 1.1));
    const rates = c.trophies.map((_, i) => {
      if (i === 1) return 100;
      const seed = 638 * (initialRates[i] ?? 0) / 100;
      const organic = 0.02 * Math.pow(age / 6, 1.5) * (1 + (i % 5) / 3);
      return Math.round((100 * seed / n + organic) * 100) / 100;
    });
    const slot = new Date(Date.parse('2026-11-19T00:00:00Z') + age * 3600000).toISOString();
    c.history.push({ slot, at: slot, players_tracked: n, rates });
  }
  const first = forecast(c);
  contract(c, Buffer.from(JSON.stringify(first)));
  assert.notDeepEqual(first, baseline(c), 'Final-horizon model collapsed to baseline');
  checks.push('multi-refresh 6510-minute final horizon');
  const targetAge = 168;
  const targetPlayers = Math.round(2500 * Math.pow(1 + targetAge / 6, 1.1));
  const syntheticTruth = new Map(c.trophies.map((t, i) => {
    const seed = 638 * (initialRates[i] ?? 0) / 100;
    const rate = i === 1 ? 100 : Math.round((100 * seed / targetPlayers
      + 0.02 * Math.pow(targetAge / 6, 1.5) * (1 + (i % 5) / 3)) * 100) / 100;
    return [t.id, rate] as [number, number];
  }));
  const finalComparison = { ours: metrics(first, syntheticTruth), baseline: metrics(baseline(c), syntheticTruth) };
  assert.ok(finalComparison.ours.loss < finalComparison.baseline.loss,
    'Adoption model should improve on persistence on a held-out synthetic adoption trajectory');
  checks.push('held-out synthetic adoption trajectory improves on persistence');
  const repeated = JSON.parse(JSON.stringify(c)) as Case;
  const last = repeated.history[repeated.history.length - 1];
  repeated.history.push({ ...last, slot: '2026-11-21T10:30:00Z', at: '2026-11-21T10:30:00Z' });
  assert.deepEqual(forecast(repeated), first, 'Duplicated plateau changed forecast');
  checks.push('plateau polling-frequency invariance');
  const withFuture = JSON.parse(JSON.stringify(c)) as Case;
  withFuture.history.push({ ...last, slot: c.target, at: c.target, rates: c.trophies.map(() => 98) });
  assert.deepEqual(forecast(withFuture), first, 'Post-checkpoint data leaked');
  checks.push('post-checkpoint reads excluded');
  const shuffled = JSON.parse(JSON.stringify(c)) as Case;
  shuffled.history.reverse();
  assert.deepEqual(forecast(shuffled), first, 'History sorting is not stable');
  checks.push('unsorted history');
  c.history[c.history.length - 1].rates[4] = null;
  contract(c, Buffer.from(JSON.stringify(forecast(c))));
  checks.push('latest missing trophy uses previous observation');
  return { checks, final_adoption_test: finalComparison };
}

function largeHistoryCheck(source: Case, executable: string, scratch: string): object {
  const c = JSON.parse(JSON.stringify(source)) as Case;
  c.id = 'synthetic-large-history';
  c.at = '2026-11-21T11:30:00Z'; c.target = '2026-11-26T00:00:00Z'; c.horizon_minutes = 6510;
  const release = Date.parse('2026-11-19T00:00:00Z');
  const initial = source.history[0].rates;
  c.history = Array.from({ length: 1000 }, (_, i) => {
    const slot = new Date(release + (-0.1 + 59.4 * i / 999) * 3600000).toISOString();
    return { slot, at: slot, players_tracked: 638 + 20 * i,
      rates: initial.map(r => r === null ? null : (r === 100 ? 100 : Math.min(90, r * (1 + 0.002 * i)))) };
  });
  const input = path.join(scratch, 'large-input');
  fs.mkdirSync(input); fs.writeFileSync(path.join(input, 'large.in'), JSON.stringify(c));
  const times: number[] = [];
  let previous: Buffer | undefined;
  for (let run = 0; run < 2; run++) {
    const output = path.join(scratch, `large-output-${run}`);
    const start = performance.now();
    const child = spawnSync(executable, [path.join(ROOT, 'main.ts')], { timeout: 8000, cwd: scratch,
      env: { ...process.env, MAKEFUN_INPUT_DIR: input, MAKEFUN_OUTPUT_DIR: output } });
    const elapsed = performance.now() - start;
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr?.toString());
    assert.ok(elapsed < 8000); times.push(elapsed);
    const content = fs.readFileSync(path.join(output, 'large.out'));
    contract(c, content);
    if (previous) assert.ok(content.equals(previous), 'Large history is nondeterministic');
    previous = content;
  }
  return { synthetic: true, unique_refreshes: 1000, trophies: c.trophies.length,
    milliseconds_two_runs: times, output_bytes: previous!.length, valid: true, deterministic: true };
}

function args(): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    assert.ok(['--input', '--answer', '--report', '--node'].includes(key), `Unknown argument ${key}`);
    assert.ok(process.argv[i + 1], `Missing value for ${key}`);
    result.set(key, process.argv[i + 1]);
  }
  assert.ok(result.has('--input'), 'Usage: node scripts/verify.ts --input DIR [--answer FILE] [--report FILE] [--node BINARY]');
  return result;
}

scorerChecks();
const options = args();
const input = path.resolve(options.get('--input')!);
const files = fs.readdirSync(input).filter(f => f.endsWith('.in')).sort();
assert.ok(files.length, 'No .in files');
const reference = options.has('--answer') ? JSON.parse(fs.readFileSync(options.get('--answer')!, 'utf8')) : null;
const executable = options.get('--node') || process.execPath;
const runtime = spawnSync(executable, ['--version'], { encoding: 'utf8' });
assert.equal(runtime.status, 0, runtime.stderr);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rarity-check-'));
const reports: any[] = [];
const ownScores: RowScore[] = [], houseScores: RowScore[] = [];
const stressRows = new Map<string, { ours: RowScore[]; baseline: RowScore[] }>();
const allInputs = path.join(scratch, 'all-inputs');
fs.mkdirSync(allInputs);
const contentByFile = new Map<string, Buffer>();
let example: Case | undefined;
try {
  for (const file of files) {
    const inputFile = path.join(input, file);
    const c = JSON.parse(fs.readFileSync(inputFile, 'utf8')) as Case;
    example = c;
    fs.copyFileSync(inputFile, path.join(allInputs, file));
    const single = path.join(scratch, file + '-input');
    fs.mkdirSync(single); fs.copyFileSync(inputFile, path.join(single, file));
    let previous: Buffer | undefined;
    let result: Forecast | undefined;
    const times: number[] = [];
    for (let run = 0; run < 2; run++) {
      const output = path.join(scratch, `${file}-${run}-out`);
      const started = performance.now();
      const child = spawnSync(executable, [path.join(ROOT, 'main.ts')], {
        cwd: scratch, timeout: 8000, maxBuffer: 1024 * 1024,
        env: { ...process.env, MAKEFUN_INPUT_DIR: single, MAKEFUN_OUTPUT_DIR: output },
      });
      const elapsed = performance.now() - started;
      assert.ifError(child.error); assert.equal(child.status, 0, child.stderr?.toString());
      assert.ok(elapsed < 8000, 'Time cap exceeded'); times.push(elapsed);
      assert.deepEqual(fs.readdirSync(output), [file.replace(/\.in$/, '.out')]);
      const outputFile = path.join(output, file.replace(/\.in$/, '.out'));
      assert.ok(fs.lstatSync(outputFile).isFile() && !fs.lstatSync(outputFile).isSymbolicLink());
      const bytes = fs.readFileSync(outputFile);
      result = contract(c, bytes);
      if (previous) assert.ok(previous.equals(bytes), 'Nondeterministic output');
      previous = bytes;
    }
    contentByFile.set(file, previous!);
    let official = null;
    if (reference) {
      const truth = answerFor(reference, c);
      const ours = metrics(result!, truth), house = metrics(baseline(c), truth);
      ownScores.push(ours); houseScores.push(house);
      official = { ours, baseline: house };
    }
    // Artificial truths test sensitivity to cohort dilution. These are NOT practice answers.
    for (const ratio of [1, 2, 4, 6, 10]) {
      const name = ratio === 1 ? 'no_refresh' : `hypothetical_population_x${ratio}_fixed_holders`;
      const truth = new Map(c.trophies.map((t, i) => {
        const r = c.history[c.history.length - 1].rates[i] ?? 0;
        return [t.id, r === 100 ? 100 : r / ratio] as [number, number];
      }));
      const group = stressRows.get(name) || { ours: [], baseline: [] };
      group.ours.push(metrics(result!, truth)); group.baseline.push(metrics(baseline(c), truth));
      stressRows.set(name, group);
    }
    reports.push({ case: c.id, trophies: c.trophies.length, output_bytes: previous!.length,
      milliseconds_two_runs: times, deterministic: true, valid: true, official });
  }
  const batchOutput = path.join(scratch, 'batch-out');
  const batch = spawnSync(executable, [path.join(ROOT, 'main.ts')], { timeout: 8000,
    env: { ...process.env, MAKEFUN_INPUT_DIR: allInputs, MAKEFUN_OUTPUT_DIR: batchOutput } });
  assert.ifError(batch.error); assert.equal(batch.status, 0, batch.stderr?.toString());
  for (const file of files) assert.ok(fs.readFileSync(path.join(batchOutput, file.replace(/\.in$/, '.out')))
    .equals(contentByFile.get(file)!), 'Batch output differs from isolated execution');
  const report = {
    node: runtime.stdout.trim(), main_bytes: fs.statSync(path.join(ROOT, 'main.ts')).size,
    practice_answer_available: Boolean(reference),
    score_status: reference ? 'computed_from_supplied_reference' : 'unavailable: official practice answers are not shipped in the kit',
    cases: reports,
    official_aggregate: reference ? { ours: aggregate(ownScores), baseline: aggregate(houseScores) } : null,
    scorer_checks: 'published example, equal-quantile absolute error, boundary clamp: PASS',
    synthetic_checks: syntheticChecks(example!), batch_matches_isolated: true,
    large_history_test: largeHistoryCheck(example!, executable, scratch),
    stress_tests_NOT_OFFICIAL_PRACTICE: Object.fromEntries([...stressRows].map(([k, v]) =>
      [k, { ours: aggregate(v.ours), baseline: aggregate(v.baseline) }])),
  };
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (options.has('--report')) fs.writeFileSync(options.get('--report')!, serialized);
  process.stdout.write(serialized);
} finally {
  // scratch is created by mkdtemp above; never remove caller-controlled directories.
  if (path.dirname(scratch) === os.tmpdir() && path.basename(scratch).startsWith('rarity-check-')) {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

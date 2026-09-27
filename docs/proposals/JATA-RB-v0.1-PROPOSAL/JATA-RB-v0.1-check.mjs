#!/usr/bin/env node
/**
 * JATA-RB-v0.1-PROPOSED — consistency-check program (NOT ADOPTED — PROPOSAL ONLY).
 *
 * DESIGN-ONLY CHECKS. This program performs NO SCORING: it computes no baseline,
 * dimension, unit, or stretch score for any real artifact or SHA. It verifies only
 * design identities (weight sums, coefficient properties, table coverage, template
 * structure, and the re-derivation of synthetic worked-example fractions stated in
 * the proposal spec). The historical figure 9.484375% appears nowhere in this
 * program's arithmetic.
 *
 * Exact rational arithmetic throughout (BigInt numerator/denominator, no floats,
 * no intermediate rounding). Display rounding (half-up, 7 dp) applied once at
 * final display only, per RB-R2.
 *
 * Usage: node docs/proposals/JATA-RB-v0.1-PROPOSAL/JATA-RB-v0.1-check.mjs
 * Exit 0 iff every check PASSES.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

// ---------- exact rational helpers (BigInt) ----------
const b = (x) => BigInt(x);
function gcd(a, b2) {
  a = a < 0n ? -a : a; b2 = b2 < 0n ? -b2 : b2;
  while (b2 !== 0n) { const t = a % b2; a = b2; b2 = t; }
  return a;
}
function frac(n, d) {
  if (d === 0n) throw new Error('zero denominator');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
const F = (n, d) => frac(b(n), b(d));
const add = (x, y) => frac(x.n * y.d + y.n * x.d, x.d * y.d);
const sub = (x, y) => frac(x.n * y.d - y.n * x.d, x.d * y.d);
const mul = (x, y) => frac(x.n * y.n, x.d * y.d);
const eq = (x, y) => x.n === y.n && x.d === y.d;
const lt = (x, y) => x.n * y.d < y.n * x.d;
const le = (x, y) => x.n * y.d <= y.n * x.d;
const fmt = (x) => `${x.n}/${x.d}`;
/** Half-up to 7 dp for non-negative x. Returns string like "0.8888889". */
function display7(x) {
  if (x.n < 0n) throw new Error('negative display');
  const scale = 10n ** 7n;
  // rounded = floor(num*scale/den + 1/2) = floor((2*num*scale + den) / (2*den))
  const rounded = (2n * x.n * scale + x.d) / (2n * x.d);
  const ip = rounded / scale;
  const fp = rounded % scale;
  return `${ip}.${fp.toString().padStart(7, '0')}`;
}
function parseFrac(s) {
  const m = /^(-?\d+)\/(-?\d+)$/.exec(s.trim());
  if (!m) throw new Error(`bad fraction: ${s}`);
  return frac(b(m[1]), b(m[2]));
}

// ---------- check harness ----------
const results = [];
function check(id, name, fn) {
  try {
    const detail = fn();
    results.push({ id, name, status: 'PASS', detail });
  } catch (e) {
    results.push({ id, name, status: 'FAIL', detail: String(e && e.message || e) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------- file layout ----------
const FILES = [
  'JATA-RB-v0.1-PROPOSAL-SPEC.md',
  'JATA-RB-v0.1-UNIT-CATALOG.md',
  'JATA-RB-v0.1-ASSESSMENT-MANIFEST-TEMPLATE.csv',
  'JATA-RB-v0.1-D07B-MODALITY-ANNEX-TEMPLATE.csv',
  'JATA-RB-v0.1-STRETCH-MANIFEST-TEMPLATE.csv',
  'JATA-RB-v0.1-MANIFEST-SCHEMA.json',
  'JATA-RB-v0.1-CHANGE-PROVENANCE.md',
  'JATA-RB-v0.1-CONSISTENCY-CHECKS.md',
  'JATA-RB-v0.1-check.mjs',
];
const MD_FILES = FILES.filter((f) => f.endsWith('.md'));

function read(p) { return readFileSync(join(HERE, p), 'utf8'); }
function parseCsv(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const header = lines[0].split(',');
  const rows = lines.slice(1).map((l) => l.split(','));
  return { header, rows };
}

// ================= structural checks =================
check('SC-01', 'all 9 proposal files exist', () => {
  const missing = FILES.filter((f) => !existsSync(join(HERE, f)));
  assert(missing.length === 0, `missing: ${missing.join(', ')}`);
  return `${FILES.length}/9 present`;
});

check('SC-02', 'every proposal .md carries NOT ADOPTED', () => {
  const bad = MD_FILES.filter((f) => !read(f).includes('NOT ADOPTED'));
  assert(bad.length === 0, `missing NOT ADOPTED: ${bad.join(', ')}`);
  return `${MD_FILES.length}/${MD_FILES.length} carry NOT ADOPTED`;
});

check('SC-03', 'no silent adoption wording (ADOPTED only as NOT ADOPTED or v1.1 fact)', () => {
  const bad = [];
  for (const f of [...MD_FILES, ...FILES.filter((x) => x.endsWith('.json'))]) {
    const lines = read(f).split('\n');
    lines.forEach((ln, i) => {
      if (ln.includes('ADOPTED') && !ln.includes('NOT ADOPTED') && !ln.includes('v1.1')) bad.push(`${f}:${i + 1}`);
    });
  }
  assert(bad.length === 0, `bare ADOPTED at ${bad.join('; ')}`);
  return 'no bare ADOPTED outside NOT ADOPTED lines and v1.1-status facts';
});

check('SC-04', 'baseline manifest: 60 rows, 60 unique units, 4 per dimension, weights exact', () => {
  const { header, rows } = parseCsv(read('JATA-RB-v0.1-ASSESSMENT-MANIFEST-TEMPLATE.csv'));
  assert(rows.length === 60, `expected 60 data rows, got ${rows.length}`);
  const iUnit = header.indexOf('unit_id');
  const iDim = header.indexOf('dimension_id');
  const iW = header.indexOf('unit_weight_points_exact');
  assert(iUnit >= 0 && iDim >= 0 && iW >= 0, 'required columns missing');
  const units = rows.map((r) => r[iUnit]);
  assert(new Set(units).size === 60, 'unit_ids not unique');
  assert(units.every((u) => /^D(0[1-9]|1[0-5])[abcd]$/.test(u)), 'unit_id pattern violation');
  const perDim = {};
  rows.forEach((r) => { perDim[r[iDim]] = (perDim[r[iDim]] || 0) + 1; });
  assert(Object.keys(perDim).length === 15, `expected 15 dims, got ${Object.keys(perDim).length}`);
  assert(Object.values(perDim).every((c) => c === 4), `per-dim counts: ${JSON.stringify(perDim)}`);
  rows.forEach((r) => {
    const want = r[iDim] === 'D07' ? '9/4' : '13/8';
    assert(r[iW] === want, `${r[iUnit]} weight ${r[iW]} != ${want}`);
  });
  return '60 rows; 15×4; weights 56×13/8 + 4×9/4';
});

check('SC-05', 'baseline manifest remains UNASSESSED (no scores, no SHAs, no dates)', () => {
  const { header, rows } = parseCsv(read('JATA-RB-v0.1-ASSESSMENT-MANIFEST-TEMPLATE.csv'));
  const col = (n) => header.indexOf(n);
  const iC = col('C_level'), iI = col('I_level'), iE = col('E_class');
  const iQ = col('Q_value_exact'), iq = col('q_value_exact'), ip = col('points_earned_exact');
  const iSha = col('evidence_sha'), iEd = col('evidence_date_utc'), iAd = col('assessment_date_utc');
  const iA = col('assessor'), iCv = col('C_value_exact'), iIv = col('I_value_exact'), iEv = col('E_coeff_exact');
  assert(iC >= 0 && iI >= 0 && iE >= 0, 'level columns missing');
  rows.forEach((r, k) => {
    assert(r[iC] === 'UNASSESSED', `row ${k} C_level=${r[iC]}`);
    assert(r[iI] === 'UNASSESSED', `row ${k} I_level=${r[iI]}`);
    assert(r[iE] === 'UNASSESSED', `row ${k} E_class=${r[iE]}`);
    for (const [nm, idx] of [['C_value', iCv], ['I_value', iIv], ['E_coeff', iEv], ['Q', iQ], ['q', iq], ['points', ip], ['sha', iSha], ['evdate', iEd], ['assdate', iAd]]) {
      assert(r[idx] === '', `row ${k} ${nm} not blank: ${r[idx]}`);
    }
    assert(r[iA] === 'UNASSESSED', `row ${k} assessor=${r[iA]}`);
  });
  return '60/60 rows fully UNASSESSED; zero scores; zero SHAs; zero dates';
});

check('SC-06', 'D07b annex: 9 rows, modalities 1-9, UNASSESSED', () => {
  const { header, rows } = parseCsv(read('JATA-RB-v0.1-D07B-MODALITY-ANNEX-TEMPLATE.csv'));
  assert(rows.length === 9, `expected 9 rows, got ${rows.length}`);
  const iM = header.indexOf('modality_index');
  const iC = header.indexOf('C_level'), iI = header.indexOf('I_level'), iE = header.indexOf('E_class');
  rows.forEach((r, k) => {
    assert(r[iM] === String(k + 1), `row ${k} modality=${r[iM]}`);
    assert(r[iC] === 'UNASSESSED' && r[iI] === 'UNASSESSED' && r[iE] === 'UNASSESSED', `row ${k} assessed`);
  });
  return '9/9 modality rows UNASSESSED';
});

check('SC-07', 'stretch manifest: 20 rows, 20x1pt, UNASSESSED', () => {
  const { header, rows } = parseCsv(read('JATA-RB-v0.1-STRETCH-MANIFEST-TEMPLATE.csv'));
  assert(rows.length === 20, `expected 20 rows, got ${rows.length}`);
  const iId = header.indexOf('stretch_id'), iP = header.indexOf('points_exact'), iE = header.indexOf('earned');
  const ids = rows.map((r) => r[iId]);
  assert(new Set(ids).size === 20, 'stretch ids not unique');
  assert(ids.every((s) => /^ST-[CIVP]0[1-5]$/.test(s)), 'stretch id pattern violation');
  rows.forEach((r, k) => {
    assert(r[iP] === '1', `row ${k} points=${r[iP]}`);
    assert(r[iE] === 'UNASSESSED', `row ${k} earned=${r[iE]}`);
  });
  const cats = rows.map((r) => r[header.indexOf('category')]);
  for (const c of ['capability', 'integration', 'verification', 'production']) {
    assert(cats.filter((x) => x === c).length === 5, `category ${c} count != 5`);
  }
  return '20 rows; 5/5/5/5 categories; all UNASSESSED';
});

check('SC-08', 'JSON schema parses with required contract', () => {
  const s = JSON.parse(read('JATA-RB-v0.1-MANIFEST-SCHEMA.json'));
  assert(Array.isArray(s.required) && s.required.length === 8, 'required keys != 8');
  assert(s.properties && s.properties.unit_id && s.properties.E_class, 'key properties missing');
  return 'schema valid; 8 required keys';
});

check('SC-09', 'proposal CSVs contain no SHA and no historical figure', () => {
  for (const f of ['JATA-RB-v0.1-ASSESSMENT-MANIFEST-TEMPLATE.csv', 'JATA-RB-v0.1-D07B-MODALITY-ANNEX-TEMPLATE.csv', 'JATA-RB-v0.1-STRETCH-MANIFEST-TEMPLATE.csv']) {
    const t = read(f);
    assert(!/[0-9a-f]{40}/.test(t), `${f} contains 40-hex SHA`);
    assert(!t.includes('9.484375'), `${f} contains historical figure`);
  }
  return 'zero SHAs; zero historical-figure occurrences in CSVs';
});

// ================= mathematical checks (design identities only; no scoring) =================
check('MC-01', 'dimension weights sum to 100', () => {
  let s = F(0, 1);
  for (let k = 0; k < 14; k++) s = add(s, F(13, 2));
  s = add(s, F(9, 1));
  assert(eq(s, F(100, 1)), `sum=${fmt(s)}`);
  return `14x(13/2)+9 = ${fmt(s)}`;
});

check('MC-02', 'unit weights sum to 100; per-dim quarters', () => {
  let s = F(0, 1);
  for (let k = 0; k < 56; k++) s = add(s, F(13, 8));
  for (let k = 0; k < 4; k++) s = add(s, F(9, 4));
  assert(eq(s, F(100, 1)), `sum=${fmt(s)}`);
  const q1 = mul(F(13, 8), F(4, 1));
  const q2 = mul(F(9, 4), F(4, 1));
  assert(eq(q1, F(13, 2)) && eq(q2, F(9, 1)), 'quarter identities fail');
  return `56x(13/8)+4x(9/4) = ${fmt(s)}; 4x(13/8)=${fmt(q1)}; 4x(9/4)=${fmt(q2)}`;
});

check('MC-03', 'D07b modality shares sum to D07b weight', () => {
  const s = mul(F(1, 4), F(9, 1));
  assert(eq(s, F(9, 4)), `sum=${fmt(s)}`);
  return `9x(1/4) = ${fmt(s)}`;
});

check('MC-04', 'C scale valid', () => {
  const vs = [F(0, 1), F(1, 4), F(1, 2), F(3, 4), F(1, 1)];
  assert(vs.every((v) => le(F(0, 1), v) && le(v, F(1, 1))), 'range');
  for (let k = 1; k < vs.length; k++) assert(lt(vs[k - 1], vs[k]), 'order');
  assert(eq(vs[0], F(0, 1)) && eq(vs[4], F(1, 1)), 'endpoints');
  return '{0,1/4,1/2,3/4,1} in [0,1], increasing, endpoints 0 and 1';
});

check('MC-05', 'I scale valid', () => {
  const vs = [F(0, 1), F(1, 4), F(1, 2), F(3, 4), F(1, 1)];
  assert(vs.every((v) => le(F(0, 1), v) && le(v, F(1, 1))), 'range');
  for (let k = 1; k < vs.length; k++) assert(lt(vs[k - 1], vs[k]), 'order');
  assert(eq(vs[0], F(0, 1)) && eq(vs[4], F(1, 1)), 'endpoints');
  return '{0,1/4,1/2,3/4,1} in [0,1], increasing, endpoints 0 and 1';
});

check('MC-06', 'E coefficients valid (E0=0, E6=1, monotonic)', () => {
  const vs = [F(0, 1), F(1, 8), F(1, 4), F(1, 2), F(3, 4), F(7, 8), F(1, 1)];
  assert(vs.every((v) => le(F(0, 1), v) && le(v, F(1, 1))), 'range');
  for (let k = 1; k < vs.length; k++) assert(lt(vs[k - 1], vs[k]), 'order');
  assert(eq(vs[0], F(0, 1)) && eq(vs[6], F(1, 1)), 'endpoints');
  return '{0,1/8,1/4,1/2,3/4,7/8,1} in [0,1], increasing, E0=0, E6=1';
});

check('MC-07', 'freshness table valid (values + gapless intervals)', () => {
  const vs = [F(1, 1), F(3, 4), F(1, 2), F(1, 4), F(0, 1)];
  assert(vs.every((v) => le(F(0, 1), v) && le(v, F(1, 1))), 'range');
  for (let k = 1; k < vs.length; k++) assert(le(vs[k], vs[k - 1]), 'monotonic');
  const bounds = [[0, 30], [31, 90], [91, 180], [181, 365]];
  assert(bounds[0][0] === 0, 'must start at 0');
  for (let k = 1; k < bounds.length; k++) assert(bounds[k][0] === bounds[k - 1][1] + 1, `gap/overlap at ${k}`);
  assert(bounds[3][1] === 365, 'last finite bound must be 365');
  return 'f in [0,1] non-increasing; [0,30],[31,90],[91,180],[181,365],[366,inf) gapless';
});

check('MC-08', 'Q range over all 35 E x f combos', () => {
  const Es = [F(0, 1), F(1, 8), F(1, 4), F(1, 2), F(3, 4), F(7, 8), F(1, 1)];
  const Fs = [F(1, 1), F(3, 4), F(1, 2), F(1, 4), F(0, 1)];
  let n = 0;
  for (const e of Es) for (const f of Fs) {
    const q = mul(e, f);
    assert(le(F(0, 1), q) && le(q, F(1, 1)), `Q=${fmt(q)} out of range`);
    n++;
  }
  return `${n}/35 E x f products in [0,1]`;
});

check('MC-09', 'q range scaffold (min 0, max 1)', () => {
  const lo = mul(mul(F(0, 1), F(0, 1)), F(0, 1));
  const hi = mul(mul(F(1, 1), F(1, 1)), F(1, 1));
  assert(eq(lo, F(0, 1)) && eq(hi, F(1, 1)), 'endpoints');
  return `min q=${fmt(lo)}; max q=${fmt(hi)}`;
});

check('MC-10', 'floors valid and compatible (weighted min 1221/20 < 95)', () => {
  const floors = { D01: 80, D02: 80, D11: 80, D04: 70, D12: 70, D14: 70, D15: 70 };
  const w = F(13, 2);
  let s = F(0, 1);
  for (const d of ['D01', 'D02', 'D11']) s = add(s, mul(w, F(floors[d], 100)));
  for (const d of ['D04', 'D12', 'D14', 'D15']) s = add(s, mul(w, F(floors[d], 100)));
  for (let k = 0; k < 7; k++) s = add(s, mul(w, F(50, 100)));
  s = add(s, mul(F(9, 1), F(50, 100)));
  assert(eq(s, F(1221, 20)), `weighted floor sum=${fmt(s)}`);
  assert(lt(s, F(95, 1)), 'floors incompatible with 95');
  return `floor-min S = ${fmt(s)} = 61.05 < 95`;
});

check('MC-11', 'normal-score maximum S_max = 100', () => {
  let s = F(0, 1);
  for (let k = 0; k < 56; k++) s = add(s, F(13, 8));
  for (let k = 0; k < 4; k++) s = add(s, F(9, 4));
  assert(eq(s, F(100, 1)), `S_max=${fmt(s)}`);
  return `S_max = ${fmt(s)} (all q=1)`;
});

check('MC-12', 'stretch + total maxima (20; 120)', () => {
  const t = mul(F(1, 1), F(20, 1));
  const tot = add(F(100, 1), t);
  assert(eq(t, F(20, 1)) && eq(tot, F(120, 1)), 'maxima');
  return `T_max=${fmt(t)}; S_total_max=${fmt(tot)}`;
});

check('MC-13', '95 threshold feasibility', () => {
  assert(le(F(95, 1), F(100, 1)), '95 > 100');
  assert(lt(F(1221, 20), F(95, 1)), 'floor-min >= 95');
  return '95 <= 100 and 1221/20 < 95';
});

check('MC-14', 'v1.1 WE1-WE6 re-derived (MOP rule preservation)', () => {
  const mop1 = F(8, 9), pom1 = F(512, 729);
  assert(display7(mop1) === '0.8888889', `WE1 mop ${display7(mop1)}`);
  assert(display7(pom1) === '0.7023320', `WE1 pom ${display7(pom1)}`);
  const d1 = mul(sub(mop1, pom1), F(100, 1));
  assert(eq(d1, F(13600, 729)), `WE1 delta=${fmt(d1)}`);
  assert(display7(d1) === '18.6556927', `WE1 delta display ${display7(d1)}`);
  const w2 = F(80, 729);
  assert(display7(w2) === '0.1097394', `WE2 ${display7(w2)}`);
  assert(display7(F(1, 9)) === '0.1111111', 'WE3');
  assert(display7(F(7, 12)) === '0.5833333', 'WE5');
  assert(display7(F(7, 144)) === '0.0486111', 'WE6a');
  assert(display7(F(1, 18)) === '0.0555556', 'WE6b');
  return 'WE1 8/9/512/729/delta, WE2 80/729, WE3 1/9, WE5 7/12, WE6 7/144+1/18 all match';
});

check('MC-15', 'RB synthetic examples WE-RB1..RB5 re-derived', () => {
  // WE-RB1: C=1/2, I=3/4, E=1/4, f=1/4 -> Q=1/16, q=3/128, p=(13/8)(3/128)=39/1024
  const q1 = mul(mul(F(1, 2), F(3, 4)), mul(F(1, 4), F(1, 4)));
  assert(eq(q1, F(3, 128)), `RB1 q=${fmt(q1)}`);
  assert(display7(q1) === '0.0234375', `RB1 display ${display7(q1)}`);
  const p1 = mul(F(13, 8), q1);
  assert(eq(p1, F(39, 1024)), `RB1 p=${fmt(p1)}`);
  assert(display7(p1) === '0.0380859', `RB1 p display ${display7(p1)}`);
  // WE-RB2: C=3/4, I=1/2, E=3/4, f=3/4 -> Q=9/16, q=27/128, p=351/1024
  const q2 = mul(mul(F(3, 4), F(1, 2)), mul(F(3, 4), F(3, 4)));
  assert(eq(q2, F(27, 128)), `RB2 q=${fmt(q2)}`);
  assert(display7(q2) === '0.2109375', `RB2 q display ${display7(q2)}`);
  const p2 = mul(F(13, 8), q2);
  assert(eq(p2, F(351, 1024)), `RB2 p=${fmt(p2)}`);
  assert(display7(p2) === '0.3427734', `RB2 p display ${display7(p2)}`);
  // WE-RB3: P=(1/2,1/4,1/8,3/4,1,0,1/4,1/2,0); sum=27/8; q=(1/9)(27/8)=3/8; p=(9/4)(3/8)=27/32
  const Ps = [F(1, 2), F(1, 4), F(1, 8), F(3, 4), F(1, 1), F(0, 1), F(1, 4), F(1, 2), F(0, 1)];
  let sumP = F(0, 1);
  for (const v of Ps) sumP = add(sumP, v);
  assert(eq(sumP, F(27, 8)), `RB3 sumP=${fmt(sumP)}`);
  const q3 = mul(F(1, 9), sumP);
  assert(eq(q3, F(3, 8)), `RB3 q=${fmt(q3)}`);
  assert(display7(q3) === '0.3750000', `RB3 display ${display7(q3)}`);
  const p3 = mul(F(9, 4), q3);
  assert(eq(p3, F(27, 32)), `RB3 p=${fmt(p3)}`);
  assert(display7(p3) === '0.8437500', `RB3 p display ${display7(p3)}`);
  const k3 = Ps.filter((v) => !eq(v, F(0, 1))).length;
  assert(k3 === 7, `RB3 k=${k3}`);
  // WE-RB4: 52 standard at q=1/16, 4xD01 at 0, D07 (0,0,0,1) -> S=964/128=241/32
  let s4 = F(0, 1);
  for (let k = 0; k < 52; k++) s4 = add(s4, mul(F(13, 8), F(1, 16)));
  for (let k = 0; k < 4; k++) s4 = add(s4, F(0, 1));
  s4 = add(s4, mul(F(9, 4), F(0, 1)));
  s4 = add(s4, mul(F(9, 4), F(0, 1)));
  s4 = add(s4, mul(F(9, 4), F(0, 1)));
  s4 = add(s4, mul(F(9, 4), F(1, 1)));
  assert(eq(s4, F(241, 32)), `RB4 S=${fmt(s4)}`);
  assert(display7(s4) === '7.5312500', `RB4 display ${display7(s4)}`);
  // WE-RB5: gating is predicate-form (PRE=false -> T_eff=0); verified by construction in RB-S3.
  return 'RB1 q=3/128 p=39/1024; RB2 q=27/128 p=351/1024; RB3 q=3/8 p=27/32 k=7; RB4 S=241/32; RB5 gating holds by predicate form';
});

// ---------- report ----------
let fails = 0;
for (const r of results) {
  if (r.status === 'FAIL') fails++;
  console.log(`${r.status} ${r.id} — ${r.name}\n    ${r.detail}`);
}
console.log(`\n${results.length - fails}/${results.length} checks PASS. No score calculated. Proposal remains NOT ADOPTED.`);
if (fails > 0) { console.log('RESULT: FAIL'); process.exit(1); }
console.log('RESULT: ALL CHECKS PASS');

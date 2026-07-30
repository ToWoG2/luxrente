// Regenerates the 27-scenario `roiData` JSON embedded in
// marketing/roi-analyse-vollstaendig.html (voluntary CCSS top-up vs. ETF investing).
//
// WHY THIS SCRIPT EXISTS
// The dataset was originally hand-computed once and pasted into the HTML — no
// generator existed, so nobody could re-run it when a constant changed. That's
// how a stale ceiling value went undetected. Run this script instead, every
// time pensionConstants.js or the tax brackets below change.
//
// HOW TO RUN
//   node marketing/scripts/generate-roi-data.mjs
// Prints the new <script id="roiData"> JSON to stdout AND writes it to
// marketing/scripts/roi-data.generated.json for inspection before pasting it
// into roi-analyse-vollstaendig.html.
//
// SOURCE OF TRUTH FOR PENSION CONSTANTS
// Imports directly from the LuxRente app's pensionConstants.js (sibling repo)
// so this can never drift from the real app. If that path doesn't resolve,
// this script fails loudly rather than silently falling back to stale copies.
//
// WHY THE PENSION MATH IS RE-IMPLEMENTED HERE INSTEAD OF IMPORTED
// pensionEngine.js's public calcPension() is not usable standalone: it
// imports runtimeConfig.js, which imports supabaseClient.js, which reads
// `import.meta.env.VITE_SUPABASE_URL` — a Vite-only construct that throws
// under plain Node. So the pure math (engine/projFactor/projIndex/conv1) is
// ported here verbatim from pensionEngine.js (last synced 2026-07-30). If you
// change the formula in pensionEngine.js, mirror the change here too.
//
// MODEL ASSUMPTIONS (see roi-analyse-vollstaendig.html methodology footer for
// the prose version of these)
//   - Salary(y) = multiple × SSM-qualifié(y). SSM-qualifié and SSM-non-qualifié
//     both grow via the same statutory index-tranche mechanism (idxPct/trMon)
//     used throughout pensionEngine.js — so salary and both ceilings move in
//     lockstep, and the ratio between them is constant over a career. This
//     also means: if salary already exceeds the voluntary ceiling in year 1,
//     it stays over it for the whole career (the gap never "grows back").
//   - Mandatory contribution base is capped at BBG_MONTHLY (index-tranche
//     ceiling, unaffected by this fix) — 13 payments/year (LU 13th month).
//   - Voluntary top-up base = max(0, VOL_CEIL_MONTHLY(y) − cappedMonthlySalary(y)),
//     using the January-frozen ceiling (Art. L.211-4 CSS: CCSS freezes this
//     for the calendar year; mid-year tranches don't raise it without a
//     written request) — 12 payments/year, no 13th-month component (matches
//     PensionResults.jsx's own volPersonalCeilContrib formula).
//   - Tax: LU Class 1 (single), 2026 scale (identical to 2025 — no bracket
//     indexation this year per kalkulo.eu/impotsdirects.public.lu), plus
//     Fonds pour l'emploi (7%, or 9% flat on the whole tax bill if taxable
//     income > €150,000 — impotsdirects.public.lu, confirmed 2026-07-30).
//     Brackets indexed forward at the same rate as salary/ceilings.
//   - IRR solved by bisection on yearly cash flows; ETF path adds terminal
//     pot value as a final inflow when the pot survives, else irrEtf = null
//     (matches the existing dataset's convention on depleted scenarios).

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { writeFileSync } from 'fs'

const __dir = dirname(fileURLToPath(import.meta.url))
const CONSTANTS_PATH = join(
  __dir,
  '../../../RetirementPlanner/retirement-vite/src/constants/pensionConstants.js'
)

let PARAM, MR, FACTOR, AVGIDX, FACT_BASE, FACT_BASE_YR, CURRENT_IDX, BBG_ANNUAL, VOL_CEIL_MONTHLY, VOL_RATE
try {
  ;({ PARAM, MR, FACTOR, AVGIDX, FACT_BASE, FACT_BASE_YR, CURRENT_IDX, BBG_ANNUAL, VOL_CEIL_MONTHLY, VOL_RATE } =
    await import(CONSTANTS_PATH))
} catch (e) {
  console.error(`Could not import pensionConstants.js from:\n  ${CONSTANTS_PATH}`)
  console.error('Fix the relative path at the top of this script if the repos moved.')
  throw e
}

const BBG_MONTHLY = BBG_ANNUAL / 12
// SSM non-qualifié: back out of BBG_ANNUAL (= 5 × SSM non-qualifié × 12), which is already
// tracked as a remote-config value — avoids a second hardcoded literal that could drift from it.
const SSM_MONTHLY_2026 = BBG_ANNUAL / 12 / 5
// SSM qualifié = SSM non-qualifié × 120% — a fixed statutory ratio (Art. 217 CT), not something
// that changes independently. Verified across three tranche years (2024/2025/2026 SSM pairs all
// resolve to exactly ×1.2), so deriving it here can't drift the way a second literal would.
const SSM_QUALIFIE_MONTHLY_2026 = SSM_MONTHLY_2026 * 1.2

// ── Pension math — ported verbatim from pensionEngine.js (last synced 2026-07-30) ──

function clampYear(y) {
  const n = Math.min(2052, Math.max(2024, y))
  const s = String(n)
  return PARAM[s] ? s : '2024'
}

function projFactor(y, facG = 0.01) {
  if (FACTOR[y] != null) return FACTOR[y]
  return FACT_BASE * Math.pow(1 + facG, y - FACT_BASE_YR)
}

function idxTranches(y, asof, trMon = 18) {
  if (y <= asof) return 0
  return Math.floor(((y - asof) * 12) / trMon)
}

function projIndex(y, curIdx, asof, idxPct = 2.5, trMon = 18) {
  if (AVGIDX[y] != null && y <= 2025) return AVGIDX[y]
  return curIdx * Math.pow(1 + idxPct / 100, idxTranches(y, asof, trMon))
}

function conv1(y, v, facG, curIdx, asof, idxPct, trMon) {
  if (!y || !v) return 0
  const f = projFactor(y, facG)
  const idx = projIndex(y, curIdx, asof, idxPct, trMon)
  return v / (f * (idx / 100))
}

function engine(year, age, insM, complM, S, RF, II) {
  const P = PARAM[clampYear(year)]
  const yrsForfait = Math.min(40, Math.ceil((insM + complM) / 12))
  const MF = (yrsForfait / 40) * (P.f / 100) * MR
  const obligY = Math.floor(insM / 12)
  const steps = Math.max(0, Math.floor(age) + obligY - P.seuil)
  const effRaw = P.p / 100 + steps * (P.e / 100)
  const eff = Math.min(effRaw, 0.0205)
  const capped = effRaw > 0.0205
  const MP = eff * S
  const base = MF + MP
  let monthly = (base * RF * (II / 100)) / 12
  const minMonthly =
    (insM + complM) / 12 >= 20 ? ((yrsForfait / 40) * 0.9 * MR * RF * (II / 100)) / 12 : 0
  const maxMonthly = ((5 / 6) * 5 * MR * RF * (II / 100)) / 12
  let floored = false, cappedMax = false
  if (minMonthly > 0 && monthly < minMonthly) { monthly = minMonthly; floored = true }
  if (monthly > maxMonthly) { monthly = maxMonthly; cappedMax = true }
  return { monthly, floored, cappedMax, capped }
}

// Simplified calcPension: no acquired-rights column (career always starts
// exactly at asof with insM=0), full explicit years[] coverage (no internal
// sal0-growth projection branch needed — every year is supplied by the caller).
function calcPensionSimple({ dobYear, asof, curIdx, years, yTarget, facG = 0.01, idxPct = 2.5, trMon = 18 }) {
  const inc = {}
  for (const row of years) inc[row.year] = row.income

  let STarget = 0
  for (let y = asof; y < yTarget; y++) {
    STarget += conv1(y, inc[y] ?? 0, facG, curIdx, asof, idxPct, trMon)
  }
  // Partial retirement year: person born Jan 1 of (yTarget - 65 + startAge),
  // turns 65 on Jan 1 of yTarget, so only January of yTarget is credited.
  const partMonths = 1
  const yTargetIncome = (inc[yTarget] ?? 0) * (partMonths / 12)
  STarget += conv1(yTarget, yTargetIncome, facG, curIdx, asof, idxPct, trMon)

  const insMTarget = (yTarget - asof) * 12 + partMonths
  const RFTarget = projFactor(yTarget - 4, facG)
  const IITarget = projIndex(yTarget, curIdx, asof, idxPct, trMon)
  const age = 65
  return engine(yTarget, age, insMTarget, 0, STarget, RFTarget, IITarget)
}

// ── Growth ratio shared by salary, both ceilings, and tax brackets ──────────
// All four are modeled as moving with the same statutory index tranches.
function growthRatio(y, asof, curIdx, idxPct, trMon) {
  return projIndex(y, curIdx, asof, idxPct, trMon) / curIdx
}

// ── LU Class 1 tax, 2026 scale ───────────────────────────────────────────────
// Verified 2026-07-30 against taxx.lu, impotsdirects.public.lu, kalkulo.eu,
// CSL "Les salariés et leur déclaration d'impôt 2026". 2026 scale = 2025 scale
// (no bracket indexation this year).
const LU_BRACKETS_2026 = [
  { upTo: 13230, rate: 0.00 },
  { upTo: 15435, rate: 0.08 },
  { upTo: 17640, rate: 0.09 },
  { upTo: 19845, rate: 0.10 },
  { upTo: 22050, rate: 0.11 },
  { upTo: 24255, rate: 0.12 },
  { upTo: 26550, rate: 0.14 },
  { upTo: 28845, rate: 0.16 },
  { upTo: 31140, rate: 0.18 },
  { upTo: 33435, rate: 0.20 },
  { upTo: 35730, rate: 0.22 },
  { upTo: 38025, rate: 0.24 },
  { upTo: 40320, rate: 0.26 },
  { upTo: 42615, rate: 0.28 },
  { upTo: 44910, rate: 0.30 },
  { upTo: 47205, rate: 0.32 },
  { upTo: 49500, rate: 0.34 },
  { upTo: 51795, rate: 0.36 },
  { upTo: 54090, rate: 0.38 },
  { upTo: 117450, rate: 0.39 },
  { upTo: 176160, rate: 0.40 },
  { upTo: 234870, rate: 0.41 },
  { upTo: Infinity, rate: 0.42 },
]
const FONDS_EMPLOI_THRESHOLD = 150000
const FONDS_EMPLOI_NORMAL = 0.07
const FONDS_EMPLOI_HIGH = 0.09

function baseTax(taxableIncome, brackets) {
  let tax = 0
  let prev = 0
  for (const b of brackets) {
    if (taxableIncome <= prev) break
    const taxedInThisBracket = Math.min(taxableIncome, b.upTo) - prev
    tax += taxedInThisBracket * b.rate
    prev = b.upTo
  }
  return tax
}

function taxLU(taxableIncome, yearGrowthRatio) {
  const brackets = LU_BRACKETS_2026.map(b => ({ upTo: b.upTo * yearGrowthRatio, rate: b.rate }))
  const thresholdIndexed = FONDS_EMPLOI_THRESHOLD * yearGrowthRatio
  const t = baseTax(taxableIncome, brackets)
  const surcharge = taxableIncome > thresholdIndexed ? FONDS_EMPLOI_HIGH : FONDS_EMPLOI_NORMAL
  return t * (1 + surcharge)
}

// ── IRR via bisection ────────────────────────────────────────────────────────
function npv(rate, cashflows) {
  return cashflows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + rate, t), 0)
}
function solveIRR(cashflows) {
  if (cashflows.every(cf => cf === 0)) return null // degenerate: nothing invested, nothing returned
  let lo = -0.5, hi = 1.0
  const fLo = npv(lo, cashflows), fHi = npv(hi, cashflows)
  if (fLo * fHi > 0) return null // no sign change — no real root in range
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    const fMid = npv(mid, cashflows)
    if (Math.abs(fMid) < 1e-6) return mid
    if (fLo * fMid < 0) hi = mid; else lo = mid
  }
  return (lo + hi) / 2
}

// ── Scenario computation ─────────────────────────────────────────────────────
const ASOF = 2026
const IDX_PCT = 2.5
const TR_MON = 18
const FAC_G = 0.01
const INFLATION = 0.022
const ETF_RETURN = 0.07
const RETIRE_AGE = 65

function computeScenario({ startAge, careerLength, multiple, payoutYears }) {
  const dobYear = ASOF - startAge
  const yTarget = dobYear + RETIRE_AGE // = ASOF + careerLength

  const baseRows = []
  const enhRows = []
  const yearData = [] // per-working-year cash-flow inputs

  for (let y = ASOF; y <= yTarget; y++) {
    const gr = growthRatio(y, ASOF, CURRENT_IDX, IDX_PCT, TR_MON)
    const monthlySalary = multiple * SSM_QUALIFIE_MONTHLY_2026 * gr
    const bbgMonthly = BBG_MONTHLY * gr
    const volCeilMonthly = VOL_CEIL_MONTHLY * gr
    const cappedMonthlySalary = Math.min(monthlySalary, bbgMonthly)
    const topUpMonthly = Math.max(0, volCeilMonthly - cappedMonthlySalary)
    const cappedBase = monthlySalary > bbgMonthly

    const annualSalaryBase = cappedMonthlySalary * 13   // mandatory: 13 payments/yr
    const annualVolBase = topUpMonthly * 12              // voluntary: 12 payments/yr, no 13th month

    baseRows.push({ year: y, income: annualSalaryBase })
    enhRows.push({ year: y, income: annualSalaryBase + annualVolBase })

    if (y < yTarget) {
      const volContribAnnual = topUpMonthly * VOL_RATE * 12
      yearData.push({ year: y, volContribAnnual, cappedBase, gr })
    }
  }

  const base = calcPensionSimple({ dobYear, asof: ASOF, curIdx: CURRENT_IDX, years: baseRows, yTarget, facG: FAC_G, idxPct: IDX_PCT, trMon: TR_MON })
  const enh = calcPensionSimple({ dobYear, asof: ASOF, curIdx: CURRENT_IDX, years: enhRows, yTarget, facG: FAC_G, idxPct: IDX_PCT, trMon: TR_MON })

  const baseM = Math.round(base.monthly)
  const enhM = Math.round(enh.monthly)
  const diffM = enhM - baseM
  const y65 = yTarget

  // Deflate a nominal year-`y` euro figure to today's (ASOF) euros.
  const deflate = y => Math.pow(1 + INFLATION, -(y - ASOF))
  const diffMReal = Math.round(diffM * deflate(yTarget))

  // ── Working-years cash flows: after-tax opportunity cost of the top-up ──
  let totalContribNom = 0, totalContribReal = 0
  let totalInvestedNom = 0, totalInvestedReal = 0
  let totalTaxSaved = 0
  const pensionOutflows = [] // { year, afterTaxCost }
  let firstYrContrib = null, lastYrContrib = null, firstYrInvestable = null

  for (const yd of yearData) {
    const salaryTaxableIncome = (multiple * SSM_QUALIFIE_MONTHLY_2026 * yd.gr) * 13
    const grBrackets = yd.gr
    const taxWithout = taxLU(salaryTaxableIncome, grBrackets)
    const taxWith = taxLU(Math.max(0, salaryTaxableIncome - yd.volContribAnnual), grBrackets)
    const taxSaved = taxWithout - taxWith
    const afterTaxCost = yd.volContribAnnual - taxSaved

    pensionOutflows.push({ year: yd.year, afterTaxCost })

    totalContribNom += yd.volContribAnnual
    totalContribReal += yd.volContribAnnual * deflate(yd.year)
    totalInvestedNom += afterTaxCost
    totalInvestedReal += afterTaxCost * deflate(yd.year)
    totalTaxSaved += taxSaved

    if (firstYrContrib === null) { firstYrContrib = Math.round(yd.volContribAnnual); firstYrInvestable = Math.round(afterTaxCost) }
    lastYrContrib = Math.round(yd.volContribAnnual)
  }

  // ── Payout-years cash flows: after-tax pension differential ─────────────
  const pensionInflows = []
  let totalNetDiffNom = 0, totalNetDiffReal = 0
  for (let i = 0; i < payoutYears; i++) {
    const y = yTarget + i
    const gr = growthRatio(y, ASOF, CURRENT_IDX, IDX_PCT, TR_MON)
    const baseAnnual = baseM * 12 * (gr / growthRatio(yTarget, ASOF, CURRENT_IDX, IDX_PCT, TR_MON))
    const enhAnnual = enhM * 12 * (gr / growthRatio(yTarget, ASOF, CURRENT_IDX, IDX_PCT, TR_MON))
    const netBase = baseAnnual - taxLU(baseAnnual, gr)
    const netEnh = enhAnnual - taxLU(enhAnnual, gr)
    const netDiff = netEnh - netBase
    pensionInflows.push({ year: y, netDiff })
    totalNetDiffNom += netDiff
    totalNetDiffReal += netDiff * deflate(y)
  }

  // ── IRR — pension path ───────────────────────────────────────────────────
  const firstOutflowYear = pensionOutflows[0]?.year ?? yTarget
  const lastYear = yTarget + payoutYears - 1
  const pensionCF = []
  for (let y = firstOutflowYear; y <= lastYear; y++) {
    const out = pensionOutflows.find(o => o.year === y)
    const inn = pensionInflows.find(o => o.year === y)
    pensionCF.push((out ? -out.afterTaxCost : 0) + (inn ? inn.netDiff : 0))
  }
  const irrPension = solveIRR(pensionCF)

  // ── ETF path: invest the identical after-tax outlay, withdraw matching amounts ──
  let pot = 0
  for (const o of pensionOutflows) pot = pot * (1 + ETF_RETURN) + o.afterTaxCost
  const potAtRetNom = pot
  const potAtRetReal = pot * deflate(yTarget)

  let running = potAtRetNom
  let depletedAtYear = null
  const etfCF = []
  for (let y = firstOutflowYear; y < yTarget; y++) {
    const out = pensionOutflows.find(o => o.year === y)
    etfCF.push(out ? -out.afterTaxCost : 0)
  }
  for (let i = 0; i < payoutYears; i++) {
    const y = yTarget + i
    const withdrawal = pensionInflows[i].netDiff
    if (i > 0) running = running * (1 + ETF_RETURN)
    if (running < withdrawal) {
      if (depletedAtYear === null) depletedAtYear = i + 1
      etfCF.push(Math.max(0, running))
      running = 0
    } else {
      running -= withdrawal
      etfCF.push(withdrawal)
    }
  }
  const potEndNom = running
  const potEndReal = running * deflate(lastYear)
  if (depletedAtYear === null && potEndNom > 0) {
    etfCF[etfCF.length - 1] += potEndNom // terminal value as final inflow
  }
  const irrEtf = depletedAtYear === null ? solveIRR(etfCF) : null

  return {
    startAge, multiple, careerLength, payoutYears, y65,
    baseM, enhM, diffM, diffMReal,
    flooredBase: base.floored, flooredEnh: enh.floored,
    cappedBase: base.cappedMax, // pension-formula max-pension cap (see engine())
    cappedEnh: enh.cappedMax,
    totalContribNom: Math.round(totalContribNom), totalContribReal: Math.round(totalContribReal),
    totalInvestedNom: Math.round(totalInvestedNom), totalInvestedReal: Math.round(totalInvestedReal),
    totalTaxSaved: Math.round(totalTaxSaved),
    totalNetDiffNom: Math.round(totalNetDiffNom), totalNetDiffReal: Math.round(totalNetDiffReal),
    potAtRetNom: Math.round(potAtRetNom), potAtRetReal: Math.round(potAtRetReal),
    potEndNom: Math.round(potEndNom), potEndReal: Math.round(potEndReal),
    depletedAtYear,
    irrPension: irrPension === null ? null : Math.round(irrPension * 10000) / 10000,
    irrEtf: irrEtf === null ? null : Math.round(irrEtf * 10000) / 10000,
    firstYrContrib, lastYrContrib, firstYrInvestable,
  }
}

// ── Run all 27 scenarios ─────────────────────────────────────────────────────
const careers = [
  { startAge: 35, careerLength: 30 },
  { startAge: 45, careerLength: 20 },
  { startAge: 55, careerLength: 10 },
]
const multiples = [2, 3, 4]
const payoutHorizons = [20, 30, 40]

const results = []
for (const c of careers) {
  for (const m of multiples) {
    for (const p of payoutHorizons) {
      results.push(computeScenario({ startAge: c.startAge, careerLength: c.careerLength, multiple: m, payoutYears: p }))
    }
  }
}

const output = {
  meta: {
    ASOF, SSM_MONTHLY_2026, SSM_QUALIFIE_MONTHLY_2026, CURRENT_IDX,
    MR, VOL_RATE, IDX_PCT, TR_MON, FAC_G, INFLATION, ETF_RETURN, RETIRE_AGE,
    VOL_CEIL_MONTHLY_2026: VOL_CEIL_MONTHLY,
    note: "IRR cash flows: outflow = after-tax opportunity cost of voluntary contribution; inflow = after-tax pension differential (pension path) or matching ETF withdrawal + terminal pot value (ETF path). Salary multiples apply to SSM qualifié; the voluntary-contribution ceiling is the January-frozen VOL_CEIL_MONTHLY (Art. L.211-4 CSS), distinct from and lower than the general BBG that caps mandatory contributions.",
  },
  results,
}

const outPath = join(__dir, 'roi-data.generated.json')
writeFileSync(outPath, JSON.stringify(output))
console.log(`Written to ${outPath}`)
console.log(JSON.stringify(output))

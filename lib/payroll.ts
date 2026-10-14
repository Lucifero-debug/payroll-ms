import { percent } from "./money";

/*
  The payroll engine.

  One pure function, `calculatePay`, with no database and no framework in
  it, so it can be tested in isolation and read by an accountant. Every
  screen in the product is scaffolding around this file.

  IMPORTANT, and the reason the rates are arguments rather than
  constants: PF, ESI and professional tax change by government
  notification. The numbers in the seed are the rates as of 2026 and must
  be verified against the current notification before any real company is
  paid with them. A payroll product that needs a deployment to follow a
  gazette goes wrong in March.

  What this file does NOT do: income tax. TDS here is a declared monthly
  amount, with a rough new-regime estimator below for guidance only.
  Proper tax means investment declarations, proof verification, perquisite
  valuation and Form 16, and a wrong number there is the employee's
  problem at filing time. The honest design is to let the operator's
  accountant give the figure, and to say so on screen.
*/

export type Rates = {
  pfEnabled: boolean;
  pfEmployeeRate: number; // basis points
  pfEmployerRate: number;
  pfPensionRate: number;
  pfWageCeiling: number; // paise
  pfCapAtCeiling: boolean;
  pfAdminRate: number;
  pfAdminMinimum: number;

  esiEnabled: boolean;
  esiEmployeeRate: number;
  esiEmployerRate: number;
  esiWageCeiling: number;

  ptEnabled: boolean;
};

export type PtSlab = {
  state: string;
  fromPaise: number;
  toPaise: number | null;
  amountPaise: number;
  /** Some states charge a different amount in one month of the year. */
  month?: number | null;
};

export type ComponentInput = {
  code: string;
  label: string;
  kind: "EARNING" | "DEDUCTION" | "EMPLOYER_CONTRIBUTION";
  amountPaise: number;
  /** Counts towards PF wages: basic and dearness allowance normally do. */
  pfWage: boolean;
  /** Counts towards the ESI gross. */
  esiWage: boolean;
  /** Reduced for loss of pay. A fixed reimbursement usually is not. */
  prorated: boolean;
  position: number;
};

export type PayInput = {
  components: ComponentInput[];
  payableDays: number;
  lopDays: number;
  /** State the employee works in, for professional tax. */
  state: string;
  /** Month number 1-12, for states that charge extra in one month. */
  month: number;
  pfExempt: boolean;
  /** Recovered this month, already decided elsewhere. */
  loanPaise?: number;
  /** Paid with salary, outside gross, not subject to PF or ESI. */
  reimbursementPaise?: number;
  /** Back pay for earlier months. Attracts PF and ESI, not prorated. */
  arrearsPaise?: number;
  /** What the accountant says to deduct. See the note at the top. */
  tdsPaise?: number;
  rates: Rates;
  ptSlabs: PtSlab[];
};

export type PayLine = {
  label: string;
  kind: ComponentInput["kind"];
  amountPaise: number;
  position: number;
};

export type PayResult = {
  lines: PayLine[];
  grossPaise: number;
  deductionsPaise: number;
  netPaise: number;
  /** What the employer pays on top of gross. */
  employerCostPaise: number;
  pfWagePaise: number;
  pfEmployeePaise: number;
  pfEmployerPaise: number;
  pfPensionPaise: number;
  pfAdminPaise: number;
  esiGrossPaise: number;
  esiEmployeePaise: number;
  esiEmployerPaise: number;
  ptPaise: number;
  tdsPaise: number;
  loanPaise: number;
  reimbursementPaise: number;
};

/**
 * Loss of pay, as a fraction of the month.
 *
 * Indian practice divides by the days in the month rather than by working
 * days, which is why a day's absence costs less in a long month. It is
 * what employees expect and what every other payroll system does.
 */
export const lopFactor = (payableDays: number, lopDays: number) =>
  payableDays <= 0 ? 1 : Math.max(0, (payableDays - lopDays) / payableDays);

/** The professional tax for a gross, in a state, in a month. */
export function professionalTax(
  grossPaise: number,
  state: string,
  month: number,
  slabs: PtSlab[],
): number {
  const forState = slabs.filter((s) => s.state.toLowerCase() === state.toLowerCase());
  if (!forState.length) return 0; // Delhi and several others have none

  const matching = forState.filter(
    (s) => grossPaise >= s.fromPaise && (s.toPaise === null || grossPaise <= s.toPaise),
  );
  if (!matching.length) return 0;

  // A slab for this specific month wins over the year-round one: this is
  // how Maharashtra's February works.
  return (matching.find((s) => s.month === month) ?? matching.find((s) => !s.month) ?? matching[0])
    .amountPaise;
}

export function calculatePay(input: PayInput): PayResult {
  const { rates, components } = input;
  const factor = lopFactor(input.payableDays, input.lopDays);
  const arrears = input.arrearsPaise ?? 0;
  const reimbursement = input.reimbursementPaise ?? 0;

  const lines: PayLine[] = [];
  let gross = 0;
  let pfWage = 0;
  let esiGross = 0;

  for (const component of components) {
    if (component.kind !== "EARNING") continue;
    // Loss of pay reduces the components that represent time worked.
    const amount = component.prorated
      ? Math.round(component.amountPaise * factor)
      : component.amountPaise;
    if (amount === 0) continue;

    gross += amount;
    if (component.pfWage) pfWage += amount;
    if (component.esiWage) esiGross += amount;
    lines.push({
      label: component.label,
      kind: "EARNING",
      amountPaise: amount,
      position: component.position,
    });
  }

  if (arrears) {
    // Arrears are wages for an earlier month, so they attract PF and ESI
    // in the month they are paid, and are never prorated.
    gross += arrears;
    pfWage += arrears;
    esiGross += arrears;
    lines.push({ label: "Arrears", kind: "EARNING", amountPaise: arrears, position: 900 });
  }

  /* ---------------- Provident fund ---------------- */

  let pfEmployee = 0;
  let pfEmployer = 0;
  let pfPension = 0;
  let pfAdmin = 0;

  if (rates.pfEnabled && !input.pfExempt && pfWage > 0) {
    // Most employers contribute on wages capped at the ceiling; some pay
    // on the full basic. The pension share is always capped.
    const contributionWage = rates.pfCapAtCeiling
      ? Math.min(pfWage, rates.pfWageCeiling)
      : pfWage;
    const pensionWage = Math.min(contributionWage, rates.pfWageCeiling);

    pfEmployee = percent(contributionWage, rates.pfEmployeeRate);
    const employerTotal = percent(contributionWage, rates.pfEmployerRate);
    // The employer's 12% splits: 8.33% to pension, the rest to PF.
    pfPension = percent(pensionWage, rates.pfPensionRate);
    pfEmployer = employerTotal - pfPension;
    pfAdmin = Math.max(percent(contributionWage, rates.pfAdminRate), rates.pfAdminMinimum);

    lines.push({ label: "Provident fund", kind: "DEDUCTION", amountPaise: pfEmployee, position: 1000 });
    lines.push({
      label: "Provident fund (employer)",
      kind: "EMPLOYER_CONTRIBUTION",
      amountPaise: pfEmployer + pfPension,
      position: 2000,
    });
  }

  /* ---------------- ESI ---------------- */

  let esiEmployee = 0;
  let esiEmployer = 0;

  if (rates.esiEnabled && esiGross > 0 && esiGross <= rates.esiWageCeiling) {
    esiEmployee = percent(esiGross, rates.esiEmployeeRate);
    esiEmployer = percent(esiGross, rates.esiEmployerRate);
    lines.push({ label: "ESI", kind: "DEDUCTION", amountPaise: esiEmployee, position: 1010 });
    lines.push({
      label: "ESI (employer)",
      kind: "EMPLOYER_CONTRIBUTION",
      amountPaise: esiEmployer,
      position: 2010,
    });
  }

  /* ---------------- Professional tax and TDS ---------------- */

  const pt = rates.ptEnabled
    ? professionalTax(gross, input.state, input.month, input.ptSlabs)
    : 0;
  if (pt) lines.push({ label: "Professional tax", kind: "DEDUCTION", amountPaise: pt, position: 1020 });

  const tds = input.tdsPaise ?? 0;
  if (tds) lines.push({ label: "TDS", kind: "DEDUCTION", amountPaise: tds, position: 1030 });

  /* ---------------- Anything else ---------------- */

  for (const component of components) {
    if (component.kind !== "DEDUCTION") continue;
    if (component.amountPaise === 0) continue;
    lines.push({
      label: component.label,
      kind: "DEDUCTION",
      amountPaise: component.amountPaise,
      position: component.position + 1100,
    });
  }

  const loan = input.loanPaise ?? 0;
  if (loan) lines.push({ label: "Loan recovery", kind: "DEDUCTION", amountPaise: loan, position: 1200 });

  if (reimbursement) {
    // Outside gross on purpose: a reimbursement is the employee's own
    // money coming back, so it attracts neither PF, ESI nor tax.
    lines.push({
      label: "Reimbursement",
      kind: "EARNING",
      amountPaise: reimbursement,
      position: 1300,
    });
  }

  const deductions = lines
    .filter((l) => l.kind === "DEDUCTION")
    .reduce((sum, l) => sum + l.amountPaise, 0);

  const employerContributions = lines
    .filter((l) => l.kind === "EMPLOYER_CONTRIBUTION")
    .reduce((sum, l) => sum + l.amountPaise, 0);

  return {
    lines: lines.sort((a, b) => a.position - b.position),
    grossPaise: gross,
    deductionsPaise: deductions,
    // The reimbursement is paid out but is not part of gross pay, which
    // is why it is added here rather than above.
    netPaise: gross - deductions + reimbursement,
    employerCostPaise: gross + employerContributions + pfAdmin,
    pfWagePaise: pfWage,
    pfEmployeePaise: pfEmployee,
    pfEmployerPaise: pfEmployer,
    pfPensionPaise: pfPension,
    pfAdminPaise: pfAdmin,
    esiGrossPaise: esiGross,
    esiEmployeePaise: esiEmployee,
    esiEmployerPaise: esiEmployer,
    ptPaise: pt,
    tdsPaise: tds,
    loanPaise: loan,
    reimbursementPaise: reimbursement,
  };
}

/* ------------------------------------------------------------------ */
/* Guidance only                                                       */
/* ------------------------------------------------------------------ */

/**
 * A rough monthly TDS figure under the new regime, for guidance.
 *
 * NOT a tax engine. It ignores other income, house property, chapter VI-A
 * deductions that survive in the new regime, perquisites, surcharge
 * nuances and any mid-year change. Show it as a suggestion next to a
 * field the operator can overwrite, and say on screen that their
 * accountant decides the number.
 *
 * VERIFY the slabs and the standard deduction against the current Finance
 * Act before relying on them; these are the FY 2026-27 figures as seeded.
 */
export function estimateMonthlyTdsNewRegime(
  annualTaxablePaise: number,
  {
    standardDeductionPaise = 7500000, // ₹75,000
    slabs = [
      { uptoPaise: 40000000, rate: 0 }, //    up to ₹4,00,000   nil
      { uptoPaise: 80000000, rate: 500 }, //  to  ₹8,00,000     5%
      { uptoPaise: 120000000, rate: 1000 }, // to ₹12,00,000   10%
      { uptoPaise: 160000000, rate: 1500 }, // to ₹16,00,000   15%
      { uptoPaise: 200000000, rate: 2000 }, // to ₹20,00,000   20%
      { uptoPaise: 240000000, rate: 2500 }, // to ₹24,00,000   25%
      { uptoPaise: null as number | null, rate: 3000 }, //      30%
    ],
    cessRate = 400, // 4% health and education cess
    rebateLimitPaise = 120000000, // income up to ₹12,00,000: rebate
  } = {},
): number {
  const taxable = Math.max(0, annualTaxablePaise - standardDeductionPaise);
  if (taxable <= rebateLimitPaise) return 0;

  let tax = 0;
  let previous = 0;
  for (const slab of slabs) {
    const ceiling = slab.uptoPaise ?? Infinity;
    if (taxable > previous) {
      tax += percent(Math.min(taxable, ceiling) - previous, slab.rate);
    }
    previous = ceiling;
    if (taxable <= ceiling) break;
  }

  const withCess = tax + percent(tax, cessRate);
  return Math.round(withCess / 12);
}

/**
 * Gratuity under the Payment of Gratuity Act: fifteen days' wages for
 * every completed year, on the last drawn basic plus dearness allowance,
 * counting a part-year over six months as a full year.
 */
export function gratuity(lastDrawnBasicPaise: number, years: number, minYears = 5): number {
  if (years < minYears) return 0;
  const counted = Math.floor(years) + (years % 1 > 0.5 ? 1 : 0);
  return Math.round((lastDrawnBasicPaise * 15 * counted) / 26);
}

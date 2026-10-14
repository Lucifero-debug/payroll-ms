import { test } from "node:test";
import assert from "node:assert/strict";
import { calculatePay, professionalTax, gratuity, lopFactor, type Rates, type PtSlab } from "../lib/payroll.ts";

/*
  Tests for the payroll engine.

    npm test

  These cover the cases that go wrong in real payroll, not the easy one:
  the PF ceiling, the ESI cut-off, loss of pay, a state's odd month, and
  arrears. Each number here is worked out by hand in the comment, so a
  failure tells you which rule changed rather than only that something
  moved.
*/

const R = (rupees: number) => rupees * 100;

const rates: Rates = {
  pfEnabled: true,
  pfEmployeeRate: 1200,
  pfEmployerRate: 1200,
  pfPensionRate: 833,
  pfWageCeiling: R(15000),
  pfCapAtCeiling: true,
  pfAdminRate: 50,
  pfAdminMinimum: R(500),
  esiEnabled: true,
  esiEmployeeRate: 75,
  esiEmployerRate: 325,
  esiWageCeiling: R(21000),
  ptEnabled: true,
};

const ptSlabs: PtSlab[] = [
  { state: "Maharashtra", fromPaise: 0, toPaise: R(7500), amountPaise: 0 },
  { state: "Maharashtra", fromPaise: R(7501), toPaise: R(10000), amountPaise: R(175) },
  { state: "Maharashtra", fromPaise: R(10001), toPaise: null, amountPaise: R(200) },
  { state: "Maharashtra", fromPaise: R(10001), toPaise: null, amountPaise: R(300), month: 2 },
];

const earning = (
  code: string,
  label: string,
  amountPaise: number,
  { pfWage = false, esiWage = true, prorated = true, position = 10 } = {},
) => ({ code, label, kind: "EARNING" as const, amountPaise, pfWage, esiWage, prorated, position });

const base = {
  payableDays: 30,
  lopDays: 0,
  state: "Delhi",
  month: 6,
  pfExempt: false,
  rates,
  ptSlabs,
};

test("PF is capped at the ceiling wage, and the pension share splits out", () => {
  // Basic ₹40,000, well above the ₹15,000 ceiling.
  //   employee PF  = 12% of 15,000 = 1,800
  //   pension      = 8.33% of 15,000 = 1,249.50 -> 124950 paise
  //   employer PF  = 12% of 15,000 - pension = 1,800 - 1,249.50 = 550.50
  const pay = calculatePay({
    ...base,
    components: [earning("BASIC", "Basic", R(40000), { pfWage: true })],
  });

  assert.equal(pay.pfEmployeePaise, R(1800));
  assert.equal(pay.pfPensionPaise, 124950);
  assert.equal(pay.pfEmployerPaise, R(1800) - 124950);
});

test("PF can be taken on full basic when the employer does not cap", () => {
  const pay = calculatePay({
    ...base,
    rates: { ...rates, pfCapAtCeiling: false },
    components: [earning("BASIC", "Basic", R(40000), { pfWage: true })],
  });

  // 12% of 40,000, while the pension share stays capped at the ceiling.
  assert.equal(pay.pfEmployeePaise, R(4800));
  assert.equal(pay.pfPensionPaise, 124950);
});

test("ESI applies at or below the ceiling and stops above it", () => {
  const covered = calculatePay({
    ...base,
    components: [earning("BASIC", "Basic", R(9000), { pfWage: true }), earning("HRA", "HRA", R(9000))],
  });
  // Gross 18,000: employee 0.75% = 135, employer 3.25% = 585.
  assert.equal(covered.esiEmployeePaise, R(135));
  assert.equal(covered.esiEmployerPaise, R(585));

  const above = calculatePay({
    ...base,
    components: [earning("BASIC", "Basic", R(12000), { pfWage: true }), earning("HRA", "HRA", R(10000))],
  });
  // Gross 22,000 is over the ₹21,000 ceiling: no ESI at all.
  assert.equal(above.esiEmployeePaise, 0);
  assert.equal(above.esiEmployerPaise, 0);
});

test("loss of pay reduces earnings by calendar days, not working days", () => {
  assert.equal(lopFactor(30, 3), 0.9);

  const pay = calculatePay({
    ...base,
    lopDays: 3,
    components: [earning("BASIC", "Basic", R(30000), { pfWage: true })],
  });

  // Three days off a 30-day month: 90% of 30,000 = 27,000.
  assert.equal(pay.grossPaise, R(27000));
  // PF follows the reduced wage, still capped at the ceiling.
  assert.equal(pay.pfEmployeePaise, R(1800));
});

test("a component marked not prorated survives loss of pay", () => {
  const pay = calculatePay({
    ...base,
    lopDays: 15,
    components: [
      earning("BASIC", "Basic", R(20000), { pfWage: true }),
      earning("FIXEDALLOW", "Fixed allowance", R(2000), { prorated: false }),
    ],
  });

  // Half of basic, all of the fixed allowance.
  assert.equal(pay.grossPaise, R(10000) + R(2000));
});

test("arrears attract PF and ESI and are never prorated", () => {
  const pay = calculatePay({
    ...base,
    lopDays: 10,
    arrearsPaise: R(5000),
    components: [earning("BASIC", "Basic", R(9000), { pfWage: true })],
  });

  // Basic reduced to two thirds (6,000), arrears paid in full.
  assert.equal(pay.grossPaise, R(6000) + R(5000));
  // PF wage is the reduced basic plus the arrears: 11,000, under the ceiling.
  assert.equal(pay.pfWagePaise, R(11000));
  assert.equal(pay.pfEmployeePaise, R(1320)); // 12% of 11,000
});

test("professional tax follows the state, and a state's special month", () => {
  assert.equal(professionalTax(R(50000), "Maharashtra", 6, ptSlabs), R(200));
  // February in Maharashtra is the higher amount.
  assert.equal(professionalTax(R(50000), "Maharashtra", 2, ptSlabs), R(300));
  // Below the threshold: nil.
  assert.equal(professionalTax(R(7000), "Maharashtra", 6, ptSlabs), 0);
  // A state with no slabs at all, such as Delhi.
  assert.equal(professionalTax(R(50000), "Delhi", 6, ptSlabs), 0);
});

test("a reimbursement is paid out but is not part of gross", () => {
  const pay = calculatePay({
    ...base,
    reimbursementPaise: R(4200),
    components: [earning("BASIC", "Basic", R(20000), { pfWage: true })],
  });

  assert.equal(pay.grossPaise, R(20000));
  // It reaches the bank account without touching PF, ESI or gross.
  assert.equal(pay.netPaise, R(20000) - pay.deductionsPaise + R(4200));
  assert.equal(pay.pfWagePaise, R(20000));
});

test("a PF-exempt employee has no PF, and the employer pays none either", () => {
  const pay = calculatePay({
    ...base,
    pfExempt: true,
    components: [earning("BASIC", "Basic", R(60000), { pfWage: true })],
  });

  assert.equal(pay.pfEmployeePaise, 0);
  assert.equal(pay.pfEmployerPaise, 0);
  assert.equal(pay.employerCostPaise, R(60000));
});

test("net pay equals gross minus every deduction, plus reimbursements", () => {
  const pay = calculatePay({
    ...base,
    state: "Maharashtra",
    loanPaise: R(5000),
    tdsPaise: R(2500),
    components: [
      earning("BASIC", "Basic", R(25000), { pfWage: true }),
      earning("HRA", "HRA", R(10000)),
      earning("SPECIAL", "Special allowance", R(15000)),
    ],
  });

  const deductions =
    pay.pfEmployeePaise + pay.esiEmployeePaise + pay.ptPaise + pay.tdsPaise + pay.loanPaise;

  assert.equal(pay.grossPaise, R(50000));
  assert.equal(pay.deductionsPaise, deductions);
  assert.equal(pay.netPaise, pay.grossPaise - deductions);
});

test("gratuity needs five years and rounds a part-year over six months up", () => {
  assert.equal(gratuity(R(30000), 4.9), 0);
  // 30,000 x 15 x 5 / 26
  assert.equal(gratuity(R(30000), 5), Math.round((R(30000) * 15 * 5) / 26));
  // 7 years 8 months counts as 8.
  assert.equal(gratuity(R(30000), 7.67), Math.round((R(30000) * 15 * 8) / 26));
});

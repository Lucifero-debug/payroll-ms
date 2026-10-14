import { db } from "./db";
import { calculatePay, type ComponentInput, type PayResult, type PtSlab, type Rates } from "./payroll";

/*
  The bridge between the database and the engine.

  lib/payroll.ts knows nothing about Prisma and never will: it takes
  numbers and returns numbers. This file is the only place that turns an
  employee, a structure, an attendance row, a loan and a set of rates
  into that call, and the only place that writes a processed run back.

  Two things here are easy to get wrong and are therefore spelled out:

  - A MID-MONTH JOINER is not the same as loss of pay, but it is paid the
    same way: by calendar days. Rather than teach the engine a second
    kind of proration, the days not employed are added to the LOP figure
    and the month is always its full length. One rule, one place.

  - A DRAFT IS RECALCULATED EVERY TIME IT IS LOOKED AT; a processed run
    is read from the payslips and never recalculated. That is the whole
    reason payslips copy their lines.
*/

export const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);
export const daysInMonth = (period: Date) =>
  new Date(period.getFullYear(), period.getMonth() + 1, 0).getDate();
export const periodLabel = (period: Date) =>
  period.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

/** The structure in force for a period: the latest one that had started. */
export function structureFor<T extends { effectiveFrom: Date }>(structures: T[], period: Date) {
  const end = new Date(period.getFullYear(), period.getMonth() + 1, 0, 23, 59, 59);
  return structures
    .filter((s) => s.effectiveFrom <= end)
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
}

/**
 * The monthly amount of one structure line.
 *
 * BALANCE is resolved last by the caller, because it is defined as
 * whatever is left of the monthly CTC once everything else is known.
 */
function componentAmount(
  calc: string,
  value: number,
  basis: { basicPaise: number; monthlyCtcPaise: number },
) {
  switch (calc) {
    case "PERCENT_BASIC":
      return Math.round((basis.basicPaise * value) / 10000);
    case "PERCENT_CTC":
      return Math.round((basis.monthlyCtcPaise * value) / 10000);
    case "FIXED":
    default:
      return value;
  }
}

type EmployeeWithEverything = Awaited<ReturnType<typeof loadEmployees>>[number];

/** Everything a run needs about every employee, in one query. */
export async function loadEmployees(companyId: string, period: Date) {
  const end = new Date(period.getFullYear(), period.getMonth() + 1, 0, 23, 59, 59);
  return db.employee.findMany({
    where: {
      companyId,
      // Someone who joined after this month, or left before it, is not on
      // this payroll. Someone who left DURING it still is, for their
      // final part-month.
      joinedOn: { lte: end },
      OR: [{ exitedOn: null }, { exitedOn: { gte: period } }],
      status: { not: "ON_LEAVE" },
    },
    include: {
      salaryStructures: { include: { components: { include: { component: true } } } },
      attendance: { where: { period } },
      loans: { where: { status: "ACTIVE" } },
      reimbursements: { where: { status: "APPROVED", period } },
    },
    orderBy: { code: "asc" },
  });
}

export type ComputedRow = {
  employeeId: string;
  code: string;
  name: string;
  designation: string | null;
  department: string | null;
  payableDays: number;
  lopDays: number;
  /** Null when the employee has no salary structure for this month. */
  pay: PayResult | null;
  problem?: string;
};

/**
 * Works out one month for every employee, without writing anything.
 *
 * This is what the review screen shows, and what `processRun` persists.
 * The same function for both, so what is approved is what is saved.
 */
export function computeRow(
  employee: EmployeeWithEverything,
  period: Date,
  rates: Rates,
  ptSlabs: PtSlab[],
): ComputedRow {
  const base = {
    employeeId: employee.id,
    code: employee.code,
    name: employee.fullName,
    designation: employee.designation,
    department: employee.department,
  };

  const structure = structureFor(employee.salaryStructures, period);
  if (!structure) {
    return { ...base, payableDays: 0, lopDays: 0, pay: null, problem: "No salary structure" };
  }

  const total = daysInMonth(period);
  const attendance = employee.attendance[0];

  /*
    Days this person was actually on the payroll this month. A joiner
    starts part way in; a leaver stops part way through. Both reduce the
    month exactly as loss of pay does, so they are folded into one
    figure and the engine keeps one rule.
  */
  const joined = employee.joinedOn;
  const startDay =
    joined.getFullYear() === period.getFullYear() && joined.getMonth() === period.getMonth()
      ? joined.getDate()
      : 1;
  const exited = employee.exitedOn;
  const endDay =
    exited && exited.getFullYear() === period.getFullYear() && exited.getMonth() === period.getMonth()
      ? exited.getDate()
      : total;
  const employedDays = Math.max(0, endDay - startDay + 1);

  const lopFromAttendance = attendance?.lopDays ?? 0;
  const lopDays = total - employedDays + lopFromAttendance;

  // Resolve the structure into monthly amounts.
  const basic =
    structure.components.find((c) => c.component.code === "BASIC")?.value ?? 0;
  const monthlyCtc = Math.round((structure.ctcAnnualPaise ?? 0) / 12);

  const resolved: ComponentInput[] = [];
  let allocated = 0;
  let balanceLine: (typeof structure.components)[number] | null = null;

  for (const line of structure.components) {
    if (line.calc === "BALANCE") {
      balanceLine = line;
      continue;
    }
    const amount = componentAmount(line.calc, line.value, {
      basicPaise: basic,
      monthlyCtcPaise: monthlyCtc,
    });
    allocated += line.component.kind === "EARNING" ? amount : 0;
    resolved.push({
      code: line.component.code,
      label: line.component.name,
      kind: line.component.kind,
      amountPaise: amount,
      pfWage: line.component.pfWage,
      esiWage: line.component.esiWage,
      prorated: line.component.prorated,
      position: line.component.position,
    });
  }

  if (balanceLine) {
    // Whatever is left of the month's CTC. Never negative: a structure
    // that over-allocates is the operator's mistake to see, not one to
    // paper over with a negative allowance.
    resolved.push({
      code: balanceLine.component.code,
      label: balanceLine.component.name,
      kind: balanceLine.component.kind,
      amountPaise: Math.max(0, monthlyCtc - allocated),
      pfWage: balanceLine.component.pfWage,
      esiWage: balanceLine.component.esiWage,
      prorated: balanceLine.component.prorated,
      position: balanceLine.component.position,
    });
  }

  // One instalment per active loan, never more than what is still owed.
  const loanPaise = employee.loans.reduce((sum, loan) => {
    const outstanding = loan.principalPaise - loan.recoveredPaise;
    return sum + Math.max(0, Math.min(loan.instalmentPaise, outstanding));
  }, 0);

  const reimbursementPaise = employee.reimbursements.reduce((s, r) => s + r.amountPaise, 0);

  const pay = calculatePay({
    components: resolved,
    payableDays: total,
    lopDays,
    state: employee.state ?? "",
    month: period.getMonth() + 1,
    pfExempt: employee.pfExempt,
    loanPaise,
    reimbursementPaise,
    rates,
    ptSlabs,
  });

  return {
    ...base,
    payableDays: total - lopDays,
    lopDays,
    pay,
    problem: attendance ? undefined : "No attendance recorded: treated as a full month",
  };
}

/** The rates and slabs for a company, shaped for the engine. */
export async function ratesFor(companyId: string) {
  const settings = await db.statutorySettings.findUnique({
    where: { companyId },
    include: { ptSlabs: true },
  });
  if (!settings) throw new Error("Statutory settings are not set up for this company");

  const rates: Rates = {
    pfEnabled: settings.pfEnabled,
    pfEmployeeRate: settings.pfEmployeeRate,
    pfEmployerRate: settings.pfEmployerRate,
    pfPensionRate: settings.pfPensionRate,
    pfWageCeiling: settings.pfWageCeiling,
    pfCapAtCeiling: settings.pfCapAtCeiling,
    pfAdminRate: settings.pfAdminRate,
    pfAdminMinimum: settings.pfAdminMinimum,
    esiEnabled: settings.esiEnabled,
    esiEmployeeRate: settings.esiEmployeeRate,
    esiEmployerRate: settings.esiEmployerRate,
    esiWageCeiling: settings.esiWageCeiling,
    ptEnabled: settings.ptEnabled,
  };

  const ptSlabs: PtSlab[] = settings.ptSlabs.map((s) => ({
    state: s.state,
    fromPaise: s.fromPaise,
    toPaise: s.toPaise,
    amountPaise: s.amountPaise,
    month: s.month,
  }));

  return { rates, ptSlabs, settings };
}

/** Every employee's month, computed fresh. Used by the review screen. */
export async function previewRun(companyId: string, period: Date) {
  const [{ rates, ptSlabs }, employees] = await Promise.all([
    ratesFor(companyId),
    loadEmployees(companyId, period),
  ]);
  return employees.map((employee) => computeRow(employee, period, rates, ptSlabs));
}

export const totalsOf = (rows: ComputedRow[]) =>
  rows.reduce(
    (sum, row) => ({
      gross: sum.gross + (row.pay?.grossPaise ?? 0),
      deductions: sum.deductions + (row.pay?.deductionsPaise ?? 0),
      net: sum.net + (row.pay?.netPaise ?? 0),
      employer: sum.employer + (row.pay ? row.pay.employerCostPaise - row.pay.grossPaise : 0),
      pf: sum.pf + (row.pay?.pfEmployeePaise ?? 0),
      esi: sum.esi + (row.pay?.esiEmployeePaise ?? 0),
      pt: sum.pt + (row.pay?.ptPaise ?? 0),
      tds: sum.tds + (row.pay?.tdsPaise ?? 0),
      count: sum.count + (row.pay ? 1 : 0),
    }),
    { gross: 0, deductions: 0, net: 0, employer: 0, pf: 0, esi: 0, pt: 0, tds: 0, count: 0 },
  );

/**
 * Freezes a run: writes a payslip per employee, with every line copied,
 * and moves the loans and reimbursements on.
 *
 * One transaction, because a half-processed payroll is worse than an
 * unprocessed one: it would pay some people and leave the loan balances
 * of others wrong, with no way to tell which from the outside.
 */
export async function processRun(runId: string) {
  const run = await db.payrollRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("Run not found");
  if (run.status !== "DRAFT") throw new Error("This run has already been processed");

  const [{ rates, ptSlabs }, employees] = await Promise.all([
    ratesFor(run.companyId),
    loadEmployees(run.companyId, run.period),
  ]);

  const rows = employees
    .map((employee) => ({ employee, computed: computeRow(employee, run.period, rates, ptSlabs) }))
    .filter((r) => r.computed.pay);

  const totals = totalsOf(rows.map((r) => r.computed));

  await db.$transaction(async (tx) => {
    for (const { employee, computed } of rows) {
      const pay = computed.pay!;
      await tx.payslip.create({
        data: {
          runId,
          employeeId: employee.id,
          period: run.period,
          // Copied, so the payslip stays true after the employee's record
          // changes or they leave.
          employeeCode: employee.code,
          fullName: employee.fullName,
          designation: employee.designation,
          department: employee.department,
          pan: employee.pan,
          uan: employee.uan,
          bankAccount: employee.bankAccount,
          payableDays: computed.payableDays,
          lopDays: computed.lopDays,
          grossPaise: pay.grossPaise,
          deductionsPaise: pay.deductionsPaise,
          netPaise: pay.netPaise,
          pfEmployeePaise: pay.pfEmployeePaise,
          pfEmployerPaise: pay.pfEmployerPaise,
          pfPensionPaise: pay.pfPensionPaise,
          esiEmployeePaise: pay.esiEmployeePaise,
          esiEmployerPaise: pay.esiEmployerPaise,
          ptPaise: pay.ptPaise,
          tdsPaise: pay.tdsPaise,
          loanPaise: pay.loanPaise,
          reimbursementPaise: pay.reimbursementPaise,
          lines: {
            create: pay.lines.map((line) => ({
              label: line.label,
              kind: line.kind,
              amountPaise: line.amountPaise,
              position: line.position,
            })),
          },
        },
      });

      // Move the loans on by what was actually recovered this month.
      for (const loan of employee.loans) {
        const outstanding = loan.principalPaise - loan.recoveredPaise;
        const taken = Math.max(0, Math.min(loan.instalmentPaise, outstanding));
        if (!taken) continue;
        const recovered = loan.recoveredPaise + taken;
        await tx.loan.update({
          where: { id: loan.id },
          data: {
            recoveredPaise: recovered,
            status: recovered >= loan.principalPaise ? "CLOSED" : "ACTIVE",
          },
        });
      }

      if (employee.reimbursements.length) {
        await tx.reimbursement.updateMany({
          where: { id: { in: employee.reimbursements.map((r) => r.id) } },
          data: { status: "PAID" },
        });
      }
    }

    await tx.payrollRun.update({
      where: { id: runId },
      data: {
        status: "PROCESSED",
        processedOn: new Date(),
        grossPaise: totals.gross,
        deductionsPaise: totals.deductions,
        netPaise: totals.net,
        employerPaise: totals.employer,
        headcount: totals.count,
      },
    });
  });

  return { headcount: totals.count, netPaise: totals.net };
}

/**
 * The bank file.
 *
 * Every bank wants its own columns, so this is the common shape and the
 * place to branch when a client says "ours needs the IFSC first". CSV
 * with a BOM, because the person checking it opens it in Excel.
 */
export function bankAdviceCsv(
  payslips: { fullName: string; bankAccount: string | null; netPaise: number; employeeCode: string }[],
  bankIfscByCode: Record<string, string | null> = {},
) {
  const rows = [
    ["Employee code", "Beneficiary name", "Account number", "IFSC", "Amount", "Narration"],
    ...payslips.map((p) => [
      p.employeeCode,
      p.fullName,
      p.bankAccount ?? "",
      bankIfscByCode[p.employeeCode] ?? "",
      (p.netPaise / 100).toFixed(2),
      "Salary",
    ]),
  ];
  return rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
}

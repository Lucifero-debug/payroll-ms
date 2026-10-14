"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { monthFromValue } from "@/lib/format";
import { processRun } from "@/lib/run";

/*
  Payroll run actions.

  The one rule worth defending: a PROCESSED run is never recalculated.
  It can be cancelled, with a reason, and a fresh one created; it cannot
  quietly change under a payslip somebody has already been sent.
*/

export async function createRun(formData: FormData) {
  const period = monthFromValue(String(formData.get("period")));
  const company = await db.company.findFirst();
  if (!company) throw new Error("No company set up");

  const existing = await db.payrollRun.findUnique({
    where: { companyId_period: { companyId: company.id, period } },
  });
  if (existing) redirect(`/payroll/${existing.id}`);

  const run = await db.payrollRun.create({
    data: { companyId: company.id, period, status: "DRAFT" },
  });
  redirect(`/payroll/${run.id}`);
}

export async function process(formData: FormData) {
  const id = String(formData.get("runId"));
  await processRun(id);
  revalidatePath(`/payroll/${id}`);
}

export async function markPaid(formData: FormData) {
  const id = String(formData.get("runId"));
  const run = await db.payrollRun.findUnique({ where: { id } });
  if (run?.status !== "PROCESSED") throw new Error("Only a processed run can be marked paid");

  await db.payrollRun.update({
    where: { id },
    data: { status: "PAID", paidOn: new Date() },
  });
  revalidatePath(`/payroll/${id}`);
}

/**
 * Cancels a run and deletes its payslips.
 *
 * Deliberately requires a reason, and deliberately the only way to
 * "redo" a month: so that undoing a payroll is a decision someone makes
 * and records, not a side effect of pressing Calculate again.
 */
export async function cancelRun(formData: FormData) {
  const id = String(formData.get("runId"));
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) throw new Error("Give a reason: cancelling a processed payroll is not a quiet act");

  const run = await db.payrollRun.findUnique({ where: { id }, include: { payslips: true } });
  if (!run) throw new Error("Run not found");
  if (run.status === "PAID") {
    throw new Error("This payroll has been paid. Correct it with an adjustment next month instead.");
  }

  await db.$transaction(async (tx) => {
    // Loan recoveries made by this run are put back, or the next run
    // would recover them twice.
    for (const slip of run.payslips) {
      if (!slip.loanPaise) continue;
      const loans = await tx.loan.findMany({ where: { employeeId: slip.employeeId } });
      let left = slip.loanPaise;
      for (const loan of loans) {
        if (left <= 0) break;
        const back = Math.min(left, loan.recoveredPaise);
        if (!back) continue;
        await tx.loan.update({
          where: { id: loan.id },
          data: { recoveredPaise: loan.recoveredPaise - back, status: "ACTIVE" },
        });
        left -= back;
      }
    }

    await tx.reimbursement.updateMany({
      where: { period: run.period, status: "PAID" },
      data: { status: "APPROVED" },
    });
    await tx.payslip.deleteMany({ where: { runId: id } });
    await tx.payrollRun.update({
      where: { id },
      data: {
        status: "CANCELLED",
        note: reason,
        grossPaise: 0,
        deductionsPaise: 0,
        netPaise: 0,
        employerPaise: 0,
        headcount: 0,
      },
    });
  });

  revalidatePath(`/payroll/${id}`);
}

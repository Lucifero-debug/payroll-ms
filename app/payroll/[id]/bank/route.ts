import { db } from "@/lib/db";
import { canSeeSalaries, getUser } from "@/lib/auth";
import { bankAdviceCsv } from "@/lib/run";

/*
  The bank advice file for a processed run.

  A route rather than a button that builds the file in the browser: the
  figures must come from the payslips as issued, not from anything
  recomputed on a page that may have been open for an hour.

  A route handler gets no protection from the page it was linked from,
  so it checks the session itself. This file is every salary in the
  company in one download.
*/

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user) return new Response("Sign in first", { status: 401 });
  if (!canSeeSalaries(user.role)) return new Response("Not allowed", { status: 403 });

  const { id } = await params;
  const run = await db.payrollRun.findFirst({
    where: { id, companyId: user.companyId },
    include: { payslips: { orderBy: { employeeCode: "asc" } } },
  });

  if (!run) return new Response("Run not found", { status: 404 });
  if (run.status === "DRAFT") {
    return new Response("This run has not been processed yet", { status: 409 });
  }

  // IFSC lives on the employee, not on the payslip: it is a routing
  // detail rather than part of the pay record.
  const employees = await db.employee.findMany({
    where: { companyId: user.companyId, code: { in: run.payslips.map((p) => p.employeeCode) } },
    select: { code: true, bankIfsc: true },
  });
  const ifsc = Object.fromEntries(employees.map((e) => [e.code, e.bankIfsc]));

  const csv = bankAdviceCsv(run.payslips, ifsc);
  const month = run.period.toISOString().slice(0, 7);

  return new Response(`\ufeff${csv}`, {
    headers: {
      // The BOM above is for Excel, which otherwise mangles a rupee sign
      // or a name in Devanagari.
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="salary-${month}.csv"`,
    },
  });
}

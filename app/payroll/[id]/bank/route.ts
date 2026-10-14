import { db } from "@/lib/db";
import { bankAdviceCsv } from "@/lib/run";

/*
  The bank advice file for a processed run.

  A route rather than a button that builds the file in the browser: the
  figures must come from the payslips as issued, not from anything
  recomputed on a page that may have been open for an hour.
*/

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const run = await db.payrollRun.findUnique({
    where: { id },
    include: { payslips: { orderBy: { employeeCode: "asc" } } },
  });

  if (!run) return new Response("Run not found", { status: 404 });
  if (run.status === "DRAFT") {
    return new Response("This run has not been processed yet", { status: 409 });
  }

  // IFSC lives on the employee, not on the payslip: it is a routing
  // detail rather than part of the pay record.
  const employees = await db.employee.findMany({
    where: { code: { in: run.payslips.map((p) => p.employeeCode) } },
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

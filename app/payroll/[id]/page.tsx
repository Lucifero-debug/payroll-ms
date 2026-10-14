import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { canSeeSalaries, requireUser } from "@/lib/auth";
import { rupees } from "@/lib/money";
import { fmtDate, fmtMonth, tone } from "@/lib/format";
import { previewRun, totalsOf, type ComputedRow } from "@/lib/run";
import { cancelRun, markPaid, process } from "../actions";

/*
  One payroll run: the register, and the two buttons that matter.

  A DRAFT is computed fresh every time this page loads, so it always
  reflects the latest attendance and salary. A PROCESSED run is read from
  its payslips and never recomputed, which is the entire reason payslips
  copy their lines.

  The comparison against last month is the most useful thing on the page.
  Payroll errors are almost never "this number is odd" in isolation; they
  are "this number is different from last month and nobody changed
  anything".
*/

export const dynamic = "force-dynamic";

/** A change worth looking at before pressing Process. */
const MATERIAL = 0.1; // 10%

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const run = await db.payrollRun.findFirst({
    where: { id, companyId: user.companyId },
    include: { company: true, payslips: { orderBy: { employeeCode: "asc" } } },
  });
  if (!run) notFound();

  const maySeePay = canSeeSalaries(user.role);
  const isDraft = run.status === "DRAFT";

  // Draft: computed live. Processed: read back, exactly as issued.
  const rows: ComputedRow[] = isDraft
    ? await previewRun(run.companyId, run.period)
    : run.payslips.map((slip) => ({
        employeeId: slip.employeeId,
        code: slip.employeeCode,
        name: slip.fullName,
        designation: slip.designation,
        department: slip.department,
        payableDays: slip.payableDays,
        lopDays: slip.lopDays,
        pay: {
          // A payslip stores what the employee was paid, not every
          // figure the engine worked out on the way there. The fields
          // below that read zero are employer-side numbers the payslip
          // does not keep: PF administration charges, and the two wage
          // bases. They are recomputed for a statutory return from the
          // stored contributions, never from this.
          lines: [],
          grossPaise: slip.grossPaise,
          deductionsPaise: slip.deductionsPaise,
          netPaise: slip.netPaise,
          employerCostPaise:
            slip.grossPaise + slip.pfEmployerPaise + slip.pfPensionPaise + slip.esiEmployerPaise,
          pfWagePaise: 0,
          pfEmployeePaise: slip.pfEmployeePaise,
          pfEmployerPaise: slip.pfEmployerPaise,
          pfPensionPaise: slip.pfPensionPaise,
          pfAdminPaise: 0,
          esiGrossPaise: 0,
          esiEmployeePaise: slip.esiEmployeePaise,
          esiEmployerPaise: slip.esiEmployerPaise,
          ptPaise: slip.ptPaise,
          tdsPaise: slip.tdsPaise,
          loanPaise: slip.loanPaise,
          reimbursementPaise: slip.reimbursementPaise,
        },
      }));

  const totals = totalsOf(rows);

  // Last month's figures, to compare against.
  const previousPeriod = new Date(run.period.getFullYear(), run.period.getMonth() - 1, 1);
  const previous = await db.payslip.findMany({
    where: {
      period: previousPeriod,
      run: { status: { in: ["PROCESSED", "PAID"] }, companyId: user.companyId },
    },
  });
  const lastMonth = Object.fromEntries(previous.map((p) => [p.employeeCode, p.netPaise]));

  const problems = rows.filter((r) => !r.pay || r.problem);
  const slipByEmployee = Object.fromEntries(run.payslips.map((s) => [s.employeeId, s.id]));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[20px] font-semibold tracking-tight">{fmtMonth(run.period)}</h1>
            <span className={`pill ${tone(run.status)}`}>{run.status.toLowerCase()}</span>
          </div>
          <p className="text-[13px] text-[color:var(--color-muted)]">
            {run.company.name}
            {run.processedOn && ` · processed ${fmtDate(run.processedOn)}`}
            {run.paidOn && ` · paid ${fmtDate(run.paidOn)}`}
          </p>
        </div>

        <div className="no-print flex flex-wrap items-center gap-2">
          <button className="btn-light" type="button" disabled>
            {/* Printing is the browser's job; this is a reminder, not a control. */}
            Ctrl+P to print the register
          </button>
          {maySeePay && run.status !== "DRAFT" && run.status !== "CANCELLED" && (
            <a className="btn-light" href={`/payroll/${run.id}/bank`}>
              Bank advice CSV
            </a>
          )}
          {maySeePay && isDraft && (
            <form action={process}>
              <input type="hidden" name="runId" value={run.id} />
              <button className="btn" type="submit" disabled={totals.count === 0}>
                Process {totals.count} payslips
              </button>
            </form>
          )}
          {maySeePay && run.status === "PROCESSED" && (
            <form action={markPaid}>
              <input type="hidden" name="runId" value={run.id} />
              <button className="btn" type="submit">Mark paid</button>
            </form>
          )}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {[
          { label: "Employees", value: String(totals.count) },
          { label: "Gross", value: rupees(totals.gross) },
          { label: "Deductions", value: rupees(totals.deductions) },
          { label: "Net payable", value: rupees(totals.net) },
          { label: "Employer cost", value: rupees(totals.gross + totals.employer) },
        ].map((stat) => (
          <div key={stat.label} className="card p-4">
            <div className="text-[12px] text-[color:var(--color-muted)]">{stat.label}</div>
            <div className="mt-1 text-[18px] font-semibold tabular-nums tracking-tight">
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      {isDraft && problems.length > 0 && (
        <section className="card border-[color:var(--color-warn)]/40 bg-amber-50/50 p-4">
          <h2 className="text-[14px] font-semibold">Check before processing</h2>
          <ul className="mt-2 space-y-1 text-[13px] text-[color:var(--color-muted)]">
            {problems.map((row) => (
              <li key={row.employeeId}>
                <Link href={`/employees/${row.employeeId}`} className="font-medium hover:underline">
                  {row.name}
                </Link>
                : {row.problem ?? "no salary structure, so not paid"}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* A viewer gets the totals above and nothing per person below. */}
      {maySeePay ? (
        <div className="card overflow-x-auto">
        <table className="w-full min-w-[900px]">
          <thead className="bg-[color:var(--color-paper)]">
            <tr>
              <th className="th">Code</th>
              <th className="th">Name</th>
              <th className="th num">Days</th>
              <th className="th num">Gross</th>
              <th className="th num">PF</th>
              <th className="th num">ESI</th>
              <th className="th num">PT</th>
              <th className="th num">TDS</th>
              <th className="th num">Loan</th>
              <th className="th num">Net</th>
              <th className="th num">vs last month</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const pay = row.pay;
              const before = lastMonth[row.code];
              const change =
                pay && before ? (pay.netPaise - before) / before : null;
              const material = change !== null && Math.abs(change) >= MATERIAL;
              return (
                <tr key={row.employeeId} className="hover:bg-[color:var(--color-paper)]">
                  <td className="td">{row.code}</td>
                  <td className="td">
                    {slipByEmployee[row.employeeId] ? (
                      <Link href={`/payslips/${slipByEmployee[row.employeeId]}`} className="font-medium hover:underline">
                        {row.name}
                      </Link>
                    ) : (
                      <Link href={`/employees/${row.employeeId}`} className="font-medium hover:underline">
                        {row.name}
                      </Link>
                    )}
                  </td>
                  <td className="td num">
                    {row.payableDays}
                    {row.lopDays > 0 && (
                      <span className="text-[color:var(--color-warn)]"> −{row.lopDays}</span>
                    )}
                  </td>
                  <td className="td num">{pay ? rupees(pay.grossPaise) : "—"}</td>
                  <td className="td num">{pay?.pfEmployeePaise ? rupees(pay.pfEmployeePaise) : "—"}</td>
                  <td className="td num">{pay?.esiEmployeePaise ? rupees(pay.esiEmployeePaise) : "—"}</td>
                  <td className="td num">{pay?.ptPaise ? rupees(pay.ptPaise) : "—"}</td>
                  <td className="td num">{pay?.tdsPaise ? rupees(pay.tdsPaise) : "—"}</td>
                  <td className="td num">{pay?.loanPaise ? rupees(pay.loanPaise) : "—"}</td>
                  <td className="td num font-medium">{pay ? rupees(pay.netPaise) : "—"}</td>
                  <td className={`td num ${material ? "text-[color:var(--color-warn)]" : "text-[color:var(--color-muted)]"}`}>
                    {change === null
                      ? "new"
                      : `${change > 0 ? "+" : ""}${Math.round(change * 100)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-[color:var(--color-paper)] font-semibold">
              <td className="td" colSpan={3}>
                Total
              </td>
              <td className="td num">{rupees(totals.gross)}</td>
              <td className="td num">{rupees(totals.pf)}</td>
              <td className="td num">{rupees(totals.esi)}</td>
              <td className="td num">{rupees(totals.pt)}</td>
              <td className="td num">{rupees(totals.tds)}</td>
              <td className="td num" />
              <td className="td num">{rupees(totals.net)}</td>
              <td className="td num" />
            </tr>
          </tfoot>
        </table>
      </div>
      ) : (
        <p className="card p-6 text-[13px] text-[color:var(--color-muted)]">
          Your account sees payroll totals, not what any individual is paid.
        </p>
      )}

      {maySeePay && run.status === "PROCESSED" && (
        <form action={cancelRun} className="no-print card flex flex-wrap items-end gap-3 p-4">
          <input type="hidden" name="runId" value={run.id} />
          <div className="min-w-[280px] flex-1">
            <label className="label" htmlFor="reason">
              Cancel this run (deletes its payslips and puts loan recoveries back)
            </label>
            <input className="input" id="reason" name="reason" placeholder="Why is it being cancelled?" required />
          </div>
          <button className="btn-light" type="submit">Cancel run</button>
        </form>
      )}

      {run.note && (
        <p className="text-[13px] text-[color:var(--color-muted)]">Note: {run.note}</p>
      )}
    </div>
  );
}

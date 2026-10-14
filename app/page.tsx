import Link from "next/link";
import { db } from "@/lib/db";
import { canSeeSalaries, requireUser } from "@/lib/auth";
import { rupees, rupeesShort } from "@/lib/money";
import { fmtMonth, tone } from "@/lib/format";
import { monthStart, previewRun, totalsOf } from "@/lib/run";

/*
  The dashboard answers the only questions anyone asks before payday:
  what will this month cost, who is missing something, and is the run
  done.
*/

export const dynamic = "force-dynamic";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="text-[12px] text-[color:var(--color-muted)]">{label}</div>
      <div className="mt-1 text-[22px] font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-[color:var(--color-muted)]">{sub}</div>}
    </div>
  );
}

export default async function Dashboard() {
  // Everything below is scoped to this user's company. No screen in this
  // app looks anything up without a company id from the session.
  const user = await requireUser();
  const company = await db.company.findUnique({ where: { id: user.companyId } });
  if (!company) {
    return (
      <div className="card p-6">
        <h1 className="text-[18px] font-semibold">Company not found</h1>
        <p className="mt-2 text-[14px] text-[color:var(--color-muted)]">
          This account points at a company that no longer exists.
        </p>
      </div>
    );
  }

  const period = monthStart(new Date());
  const [rows, runs, headcount] = await Promise.all([
    previewRun(company.id, period),
    db.payrollRun.findMany({
      where: { companyId: company.id },
      orderBy: { period: "desc" },
      take: 6,
    }),
    db.employee.count({ where: { companyId: company.id, status: "ACTIVE" } }),
  ]);

  const totals = totalsOf(rows);
  const problems = rows.filter((r) => r.problem);
  const thisRun = runs.find((r) => r.period.getTime() === period.getTime());

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">{company.name}</h1>
          <p className="text-[13px] text-[color:var(--color-muted)]">
            {fmtMonth(period)} · {headcount} on the payroll
          </p>
        </div>
        <Link href="/payroll" className="btn no-print">
          {thisRun ? "Open this month's run" : "Start this month's run"}
        </Link>
      </header>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Gross this month" value={rupeesShort(totals.gross)} sub={`${totals.count} employees`} />
        <Stat label="Net payable" value={rupeesShort(totals.net)} sub="what leaves the bank" />
        <Stat
          label="Statutory"
          value={rupeesShort(totals.pf + totals.esi + totals.pt + totals.tds)}
          sub="PF, ESI, PT and TDS deducted"
        />
        <Stat
          label="Employer cost"
          value={rupeesShort(totals.gross + totals.employer)}
          sub={`${rupeesShort(totals.employer)} on top of gross`}
        />
      </div>

      {/* A viewer sees the shape of the payroll, never a person's pay. */}
      {canSeeSalaries(user.role) && problems.length > 0 && (
        <section className="card">
          <h2 className="border-b border-[color:var(--color-line)] px-4 py-3 text-[14px] font-semibold">
            Needs attention before processing
          </h2>
          <ul className="divide-y divide-[color:var(--color-line)]">
            {problems.map((row) => (
              <li key={row.employeeId} className="flex items-center justify-between gap-3 px-4 py-3">
                <Link href={`/employees/${row.employeeId}`} className="text-[14px] font-medium hover:underline">
                  {row.name}
                  <span className="ml-2 text-[12px] text-[color:var(--color-muted)]">{row.code}</span>
                </Link>
                <span className="text-[13px] text-[color:var(--color-warn)]">{row.problem}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card overflow-hidden">
        <h2 className="border-b border-[color:var(--color-line)] px-4 py-3 text-[14px] font-semibold">
          Recent runs
        </h2>
        <table className="w-full">
          <thead className="bg-[color:var(--color-paper)]">
            <tr>
              <th className="th">Month</th>
              <th className="th">Status</th>
              <th className="th num">Headcount</th>
              <th className="th num">Gross</th>
              <th className="th num">Net paid</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className="hover:bg-[color:var(--color-paper)]">
                <td className="td">
                  <Link href={`/payroll/${run.id}`} className="font-medium hover:underline">
                    {fmtMonth(run.period)}
                  </Link>
                </td>
                <td className="td">
                  <span className={`pill ${tone(run.status)}`}>{run.status.toLowerCase()}</span>
                </td>
                <td className="td num">{run.headcount || "—"}</td>
                <td className="td num">{run.grossPaise ? rupees(run.grossPaise) : "—"}</td>
                <td className="td num">{run.netPaise ? rupees(run.netPaise) : "—"}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td className="td text-[color:var(--color-muted)]" colSpan={5}>
                  No runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

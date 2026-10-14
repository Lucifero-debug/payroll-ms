import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { rupees } from "@/lib/money";
import { fmtDate, fmtMonth, monthValue, tone } from "@/lib/format";
import { monthStart } from "@/lib/run";
import { createRun } from "./actions";

export const dynamic = "force-dynamic";

export default async function PayrollPage() {
  const user = await requireUser();
  const runs = await db.payrollRun.findMany({
    where: { companyId: user.companyId },
    orderBy: { period: "desc" },
    take: 24,
  });
  const period = monthStart(new Date());

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-[20px] font-semibold tracking-tight">Payroll runs</h1>
        <p className="text-[13px] text-[color:var(--color-muted)]">
          One run per month. A draft can be recalculated; a processed run cannot.
        </p>
      </header>

      <form action={createRun} className="card flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="label" htmlFor="period">Month</label>
          <input
            className="input w-48"
            id="period"
            name="period"
            type="month"
            defaultValue={monthValue(period)}
            required
          />
        </div>
        <button className="btn" type="submit">Open run</button>
        <p className="text-[12px] text-[color:var(--color-muted)]">
          Opening a month that already has a run takes you to it.
        </p>
      </form>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-[color:var(--color-paper)]">
            <tr>
              <th className="th">Month</th>
              <th className="th">Status</th>
              <th className="th num">Headcount</th>
              <th className="th num">Gross</th>
              <th className="th num">Deductions</th>
              <th className="th num">Net paid</th>
              <th className="th">Processed</th>
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
                <td className="td num">{run.deductionsPaise ? rupees(run.deductionsPaise) : "—"}</td>
                <td className="td num">{run.netPaise ? rupees(run.netPaise) : "—"}</td>
                <td className="td whitespace-nowrap text-[13px] text-[color:var(--color-muted)]">
                  {fmtDate(run.processedOn)}
                </td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td className="td text-[color:var(--color-muted)]" colSpan={7}>
                  No runs yet. Open this month above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

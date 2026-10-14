import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { canSeeSalaries, requireUser } from "@/lib/auth";
import { inWords, rupees } from "@/lib/money";
import { fmtMonth } from "@/lib/format";

/*
  A payslip, as issued.

  Every figure here is read from the payslip's own stored lines, never
  recomputed: an employee showing this to a bank in two years must see
  the same sheet they were sent, whatever has changed since.

  Printed from the browser rather than generated as a PDF. One less
  dependency, it always matches the screen, and "Save as PDF" is in
  every print dialog.
*/

export const dynamic = "force-dynamic";

export default async function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  if (!canSeeSalaries(user.role)) notFound();

  const slip = await db.payslip.findFirst({
    // Through the run, which is what carries the company.
    where: { id, run: { companyId: user.companyId } },
    include: { lines: { orderBy: { position: "asc" } }, run: { include: { company: true } } },
  });
  if (!slip) notFound();

  const company = slip.run.company;
  const earnings = slip.lines.filter((l) => l.kind === "EARNING");
  const deductions = slip.lines.filter((l) => l.kind === "DEDUCTION");
  const employer = slip.lines.filter((l) => l.kind === "EMPLOYER_CONTRIBUTION");

  return (
    <div className="mx-auto max-w-[820px]">
      <div className="no-print mb-4 flex items-center justify-between">
        <a href={`/payroll/${slip.runId}`} className="btn-light">Back to the run</a>
        <span className="text-[13px] text-[color:var(--color-muted)]">
          Ctrl+P to print or save as PDF
        </span>
      </div>

      <article className="card p-8">
        <header className="border-b border-[color:var(--color-line)] pb-5 text-center">
          <h1 className="text-[18px] font-semibold uppercase tracking-wide">{company.name}</h1>
          {company.address && (
            <p className="text-[12px] text-[color:var(--color-muted)]">
              {company.address}
              {company.city ? `, ${company.city}` : ""}
            </p>
          )}
          <p className="mt-3 inline-block rounded-full bg-[color:var(--color-paper)] px-3 py-1 text-[13px] font-medium">
            Payslip for {fmtMonth(slip.period)}
          </p>
        </header>

        <section className="grid grid-cols-2 gap-x-8 gap-y-2 py-5 text-[13px]">
          {[
            ["Employee", `${slip.fullName} (${slip.employeeCode})`],
            ["Designation", slip.designation ?? "—"],
            ["Department", slip.department ?? "—"],
            ["Days paid", `${slip.payableDays}${slip.lopDays ? ` (${slip.lopDays} loss of pay)` : ""}`],
            ["PAN", slip.pan ?? "—"],
            ["UAN", slip.uan ?? "—"],
            ["Bank account", slip.bankAccount ?? "—"],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 border-b border-dashed border-[color:var(--color-line)] py-1">
              <span className="text-[color:var(--color-muted)]">{label}</span>
              <span className="text-right">{value}</span>
            </div>
          ))}
        </section>

        <section className="grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
              Earnings
            </h2>
            <table className="w-full text-[14px]">
              <tbody>
                {earnings.map((line) => (
                  <tr key={line.id}>
                    <td className="td">{line.label}</td>
                    <td className="td num">{rupees(line.amountPaise)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="td font-semibold">Gross</td>
                  <td className="td num font-semibold">{rupees(slip.grossPaise)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div>
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
              Deductions
            </h2>
            <table className="w-full text-[14px]">
              <tbody>
                {deductions.map((line) => (
                  <tr key={line.id}>
                    <td className="td">{line.label}</td>
                    <td className="td num">{rupees(line.amountPaise)}</td>
                  </tr>
                ))}
                {deductions.length === 0 && (
                  <tr>
                    <td className="td text-[color:var(--color-muted)]">None</td>
                    <td className="td num">—</td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td className="td font-semibold">Total</td>
                  <td className="td num font-semibold">{rupees(slip.deductionsPaise)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <section className="mt-6 border-t-2 border-[color:var(--color-line)] pt-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[15px] font-semibold">Net pay</span>
            <span className="text-[20px] font-semibold tabular-nums">{rupees(slip.netPaise)}</span>
          </div>
          {/* Amount in words: what a bank and an auditor both look for. */}
          <p className="mt-1 text-right text-[12px] text-[color:var(--color-muted)]">
            {inWords(slip.netPaise)}
          </p>
        </section>

        {employer.length > 0 && (
          <section className="mt-6 border-t border-[color:var(--color-line)] pt-4 text-[12px] text-[color:var(--color-muted)]">
            <p className="mb-1 font-medium">Paid by the employer, not deducted from you</p>
            <ul className="flex flex-wrap gap-x-6 gap-y-1">
              {employer.map((line) => (
                <li key={line.id}>
                  {line.label}: <span className="tabular-nums">{rupees(line.amountPaise)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="mt-8 border-t border-[color:var(--color-line)] pt-4 text-[11px] text-[color:var(--color-muted)]">
          This is a computer-generated payslip and does not need a signature.
          {company.pfCode && ` PF code ${company.pfCode}.`}
          {company.esiCode && ` ESI code ${company.esiCode}.`}
        </footer>
      </article>
    </div>
  );
}

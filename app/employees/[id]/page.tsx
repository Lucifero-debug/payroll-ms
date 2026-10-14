import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { canSeeSalaries, requireUser } from "@/lib/auth";
import { rupees } from "@/lib/money";
import { fmtDate, fmtMonth, tone, ymd } from "@/lib/format";
import { computeRow, monthStart, ratesFor, structureFor } from "@/lib/run";
import { addLoan, reviseSalary, updateEmployee } from "../actions";

/*
  One employee, with a live preview of this month's payslip beside the
  salary.

  The preview is the point. An owner typing a number wants to see the PF,
  the ESI and the figure that actually reaches the bank, and that is the
  moment this product proves itself against a spreadsheet.
*/

export const dynamic = "force-dynamic";

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  // A viewer has no business on an individual's page at all: their pay
  // is the whole content of it.
  if (!canSeeSalaries(user.role)) notFound();
  const period = monthStart(new Date());

  const employee = await db.employee.findFirst({
    // Scoped by company, so a guessed id from another tenant is simply
    // not found rather than quietly readable.
    where: { id, companyId: user.companyId },
    include: {
      salaryStructures: {
        include: { components: { include: { component: true } } },
        orderBy: { effectiveFrom: "desc" },
      },
      attendance: { where: { period } },
      loans: { orderBy: { startPeriod: "desc" } },
      reimbursements: { where: { status: { in: ["CLAIMED", "APPROVED"] } } },
      payslips: { orderBy: { period: "desc" }, take: 6, include: { run: true } },
    },
  });
  if (!employee) notFound();

  const { rates, ptSlabs } = await ratesFor(employee.companyId);
  // The preview needs the same shape the run uses, so it is the same
  // function: a preview that disagrees with the run is worse than none.
  const computed = computeRow(
    {
      ...employee,
      loans: employee.loans.filter((l) => l.status === "ACTIVE"),
      reimbursements: employee.reimbursements.filter((r) => r.status === "APPROVED" && r.period),
    } as Parameters<typeof computeRow>[0],
    period,
    rates,
    ptSlabs,
  );

  const current = structureFor(employee.salaryStructures, period);
  const pay = computed.pay;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[20px] font-semibold tracking-tight">{employee.fullName}</h1>
            <span className={`pill ${tone(employee.status)}`}>
              {employee.status.replace("_", " ").toLowerCase()}
            </span>
          </div>
          <p className="text-[13px] text-[color:var(--color-muted)]">
            {employee.code} · {employee.designation ?? "—"} · joined {fmtDate(employee.joinedOn)}
          </p>
        </div>
        <Link href="/employees" className="btn-light no-print">
          All employees
        </Link>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1fr_0.9fr]">
        <div className="space-y-5">
          {/* Salary */}
          <section className="card">
            <h2 className="border-b border-[color:var(--color-line)] px-4 py-3 text-[14px] font-semibold">
              Salary, from {current ? fmtDate(current.effectiveFrom) : "—"}
            </h2>
            {current ? (
              <table className="w-full">
                <tbody>
                  {current.components
                    .slice()
                    .sort((a, b) => a.component.position - b.component.position)
                    .map((line) => (
                      <tr key={line.id}>
                        <td className="td">
                          {line.component.name}
                          <span className="ml-2 text-[11px] text-[color:var(--color-muted)]">
                            {line.component.pfWage ? "PF wage" : ""}
                          </span>
                        </td>
                        <td className="td num">{rupees(line.value)}</td>
                      </tr>
                    ))}
                  <tr>
                    <td className="td font-semibold">Monthly gross</td>
                    <td className="td num font-semibold">
                      {rupees(
                        current.components
                          .filter((l) => l.component.kind === "EARNING")
                          .reduce((s, l) => s + l.value, 0),
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <p className="px-4 py-6 text-[13px] text-[color:var(--color-warn)]">
                No salary structure. This employee will be skipped by every payroll run until one
                exists.
              </p>
            )}

            <form action={reviseSalary} className="grid gap-2 border-t border-[color:var(--color-line)] p-4 sm:grid-cols-4">
              <input type="hidden" name="employeeId" value={employee.id} />
              <input className="input" name="monthlyGross" placeholder="New monthly gross ₹" required aria-label="New monthly gross" />
              <input className="input" name="effectiveFrom" type="date" required aria-label="Effective from" />
              <input className="input" name="note" placeholder="Reason" aria-label="Reason" />
              <button className="btn" type="submit">Revise</button>
              <p className="sm:col-span-4 text-[12px] text-[color:var(--color-muted)]">
                A revision creates a new structure from that date. The old one stays, so past
                payslips and arrears still work.
              </p>
            </form>
          </section>

          {/* Loans */}
          <section className="card">
            <h2 className="border-b border-[color:var(--color-line)] px-4 py-3 text-[14px] font-semibold">
              Loans and advances
            </h2>
            <ul className="divide-y divide-[color:var(--color-line)]">
              {employee.loans.map((loan) => (
                <li key={loan.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <div className="text-[14px]">{loan.reason}</div>
                    <div className="text-[12px] text-[color:var(--color-muted)]">
                      {rupees(loan.instalmentPaise)} a month · {rupees(loan.recoveredPaise)} of{" "}
                      {rupees(loan.principalPaise)} recovered
                    </div>
                  </div>
                  <span className={`pill ${tone(loan.status)}`}>{loan.status.toLowerCase()}</span>
                </li>
              ))}
              {employee.loans.length === 0 && (
                <li className="px-4 py-6 text-[13px] text-[color:var(--color-muted)]">None.</li>
              )}
            </ul>
            <form action={addLoan} className="grid gap-2 border-t border-[color:var(--color-line)] p-4 sm:grid-cols-5">
              <input type="hidden" name="employeeId" value={employee.id} />
              <input className="input sm:col-span-2" name="reason" placeholder="Reason" aria-label="Reason" />
              <input className="input" name="principal" placeholder="Amount ₹" required aria-label="Amount" />
              <input className="input" name="instalment" placeholder="Per month ₹" required aria-label="Instalment" />
              <button className="btn" type="submit">Add</button>
            </form>
          </section>

          {/* Record */}
          <section className="card">
            <h2 className="border-b border-[color:var(--color-line)] px-4 py-3 text-[14px] font-semibold">
              Record
            </h2>
            <form action={updateEmployee} className="grid gap-3 p-4 sm:grid-cols-3">
              <input type="hidden" name="employeeId" value={employee.id} />
              {[
                { name: "designation", label: "Designation", value: employee.designation },
                { name: "department", label: "Department", value: employee.department },
                { name: "state", label: "State", value: employee.state },
                { name: "phone", label: "Phone", value: employee.phone },
                { name: "pan", label: "PAN", value: employee.pan },
                { name: "uan", label: "UAN", value: employee.uan },
                { name: "esiNumber", label: "ESI number", value: employee.esiNumber },
                { name: "bankName", label: "Bank", value: employee.bankName },
                { name: "bankAccount", label: "Account", value: employee.bankAccount },
                { name: "bankIfsc", label: "IFSC", value: employee.bankIfsc },
              ].map((field) => (
                <div key={field.name}>
                  <label className="label" htmlFor={field.name}>{field.label}</label>
                  <input
                    className="input"
                    id={field.name}
                    name={field.name}
                    defaultValue={field.value ?? ""}
                  />
                </div>
              ))}
              <div>
                <label className="label" htmlFor="status">Status</label>
                <select className="input" id="status" name="status" defaultValue={employee.status}>
                  {["ACTIVE", "ON_NOTICE", "EXITED", "ON_LEAVE"].map((s) => (
                    <option key={s} value={s}>{s.replace("_", " ").toLowerCase()}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="exitedOn">Last working day</label>
                <input
                  className="input"
                  id="exitedOn"
                  name="exitedOn"
                  type="date"
                  defaultValue={ymd(employee.exitedOn)}
                />
              </div>
              <label className="flex items-end gap-2 pb-2 text-[14px]">
                <input type="checkbox" name="pfExempt" defaultChecked={employee.pfExempt} className="h-4 w-4" />
                PF exempt
              </label>
              <div className="sm:col-span-3">
                <button className="btn" type="submit">Save</button>
              </div>
            </form>
          </section>
        </div>

        {/* The live preview */}
        <div className="space-y-5">
          <section className="card">
            <h2 className="border-b border-[color:var(--color-line)] px-4 py-3 text-[14px] font-semibold">
              {fmtMonth(period)}, as it stands
            </h2>
            {pay ? (
              <>
                <table className="w-full">
                  <tbody>
                    {pay.lines
                      .filter((l) => l.kind !== "EMPLOYER_CONTRIBUTION")
                      .map((line, i) => (
                        <tr key={`${line.label}-${i}`}>
                          <td className="td">
                            {line.label}
                            {line.kind === "DEDUCTION" && (
                              <span className="ml-2 text-[11px] text-[color:var(--color-muted)]">
                                deduction
                              </span>
                            )}
                          </td>
                          <td className={`td num ${line.kind === "DEDUCTION" ? "text-[color:var(--color-bad)]" : ""}`}>
                            {line.kind === "DEDUCTION" ? "−" : ""}
                            {rupees(line.amountPaise)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="td font-semibold">Net pay</td>
                      <td className="td num font-semibold">{rupees(pay.netPaise)}</td>
                    </tr>
                  </tfoot>
                </table>
                <dl className="grid grid-cols-2 gap-3 border-t border-[color:var(--color-line)] p-4 text-[13px]">
                  <div>
                    <dt className="text-[color:var(--color-muted)]">Gross</dt>
                    <dd className="tabular-nums">{rupees(pay.grossPaise)}</dd>
                  </div>
                  <div>
                    <dt className="text-[color:var(--color-muted)]">Employer cost</dt>
                    <dd className="tabular-nums">{rupees(pay.employerCostPaise)}</dd>
                  </div>
                  <div>
                    <dt className="text-[color:var(--color-muted)]">PF wage</dt>
                    <dd className="tabular-nums">{rupees(pay.pfWagePaise)}</dd>
                  </div>
                  <div>
                    <dt className="text-[color:var(--color-muted)]">Days paid</dt>
                    <dd className="tabular-nums">
                      {computed.payableDays}
                      {computed.lopDays > 0 && ` (${computed.lopDays} lost)`}
                    </dd>
                  </div>
                </dl>
                {computed.problem && (
                  <p className="border-t border-[color:var(--color-line)] px-4 py-3 text-[12px] text-[color:var(--color-warn)]">
                    {computed.problem}
                  </p>
                )}
              </>
            ) : (
              <p className="px-4 py-6 text-[13px] text-[color:var(--color-muted)]">
                {computed.problem}
              </p>
            )}
          </section>

          <section className="card">
            <h2 className="border-b border-[color:var(--color-line)] px-4 py-3 text-[14px] font-semibold">
              Payslips
            </h2>
            <ul className="divide-y divide-[color:var(--color-line)]">
              {employee.payslips.map((slip) => (
                <li key={slip.id} className="flex items-center justify-between px-4 py-3">
                  <Link href={`/payslips/${slip.id}`} className="text-[14px] hover:underline">
                    {fmtMonth(slip.period)}
                  </Link>
                  <span className="text-[14px] tabular-nums">{rupees(slip.netPaise)}</span>
                </li>
              ))}
              {employee.payslips.length === 0 && (
                <li className="px-4 py-6 text-[13px] text-[color:var(--color-muted)]">None yet.</li>
              )}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

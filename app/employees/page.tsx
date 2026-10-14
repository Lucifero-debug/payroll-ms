import Link from "next/link";
import { db } from "@/lib/db";
import { canSeeSalaries, requireUser } from "@/lib/auth";
import { rupees } from "@/lib/money";
import { fmtDate, tone } from "@/lib/format";
import { monthStart, structureFor } from "@/lib/run";
import { createEmployee } from "./actions";

export const dynamic = "force-dynamic";

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string; status?: string }>;
}) {
  const params = await searchParams;
  const user = await requireUser();
  const showForm = params.new === "1" && canSeeSalaries(user.role);
  const status = params.status?.toUpperCase();

  const employees = await db.employee.findMany({
    where: {
      companyId: user.companyId,
      ...(status && status !== "ALL"
        ? { status: status as "ACTIVE" }
        : { status: { not: "EXITED" } }),
    },
    include: { salaryStructures: true },
    orderBy: { code: "asc" },
  });

  const period = monthStart(new Date());

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Employees</h1>
          <p className="text-[13px] text-[color:var(--color-muted)]">
            {employees.length} on the payroll
          </p>
        </div>
        <Link href={showForm ? "/employees" : "/employees?new=1"} className="btn">
          {showForm ? "Close" : "Add employee"}
        </Link>
      </header>

      {showForm && (
        <form action={createEmployee} className="card space-y-4 p-4">
          <div className="grid gap-4 md:grid-cols-4">
            <div className="md:col-span-2">
              <label className="label" htmlFor="fullName">
                Full name, as on the bank account
              </label>
              <input className="input" id="fullName" name="fullName" required />
            </div>
            <div>
              <label className="label" htmlFor="joinedOn">Joined on</label>
              <input className="input" id="joinedOn" name="joinedOn" type="date" required />
            </div>
            <div>
              <label className="label" htmlFor="monthlyGross">Monthly gross (₹)</label>
              <input className="input" id="monthlyGross" name="monthlyGross" placeholder="45000" required />
            </div>
            <div>
              <label className="label" htmlFor="designation">Designation</label>
              <input className="input" id="designation" name="designation" />
            </div>
            <div>
              <label className="label" htmlFor="department">Department</label>
              <input className="input" id="department" name="department" />
            </div>
            <div>
              <label className="label" htmlFor="state">State (for professional tax)</label>
              <input className="input" id="state" name="state" placeholder="Delhi" />
            </div>
            <div>
              <label className="label" htmlFor="pan">PAN</label>
              <input className="input" id="pan" name="pan" />
            </div>
            <div>
              <label className="label" htmlFor="uan">UAN</label>
              <input className="input" id="uan" name="uan" />
            </div>
            <div>
              <label className="label" htmlFor="bankAccount">Bank account</label>
              <input className="input" id="bankAccount" name="bankAccount" />
            </div>
            <div>
              <label className="label" htmlFor="bankIfsc">IFSC</label>
              <input className="input" id="bankIfsc" name="bankIfsc" />
            </div>
            <label className="flex items-end gap-2 pb-2 text-[14px]">
              <input type="checkbox" name="pfExempt" className="h-4 w-4" />
              PF exempt
            </label>
          </div>
          <p className="text-[12px] text-[color:var(--color-muted)]">
            The salary is split the usual way: half as basic, 40% of basic as HRA, conveyance capped
            at ₹1,600, the rest as special allowance. Change it on the employee's page afterwards.
          </p>
          <button className="btn" type="submit">Save</button>
        </form>
      )}

      <nav className="no-print flex flex-wrap gap-2">
        {["ALL", "ACTIVE", "ON_NOTICE", "EXITED"].map((s) => (
          <Link
            key={s}
            href={s === "ALL" ? "/employees?status=all" : `/employees?status=${s.toLowerCase()}`}
            className={`pill ${(status ?? "") === s ? "bg-[color:var(--color-ink)] text-white" : "bg-white"}`}
          >
            {s.replace("_", " ").toLowerCase()}
          </Link>
        ))}
      </nav>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-[color:var(--color-paper)]">
            <tr>
              <th className="th">Code</th>
              <th className="th">Name</th>
              <th className="th">Department</th>
              <th className="th">Joined</th>
              <th className="th num">Monthly gross</th>
              <th className="th">Status</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((employee) => {
              const structure = structureFor(employee.salaryStructures, period);
              const monthly = structure?.ctcAnnualPaise
                ? Math.round(structure.ctcAnnualPaise / 12)
                : null;
              return (
                <tr key={employee.id} className="hover:bg-[color:var(--color-paper)]">
                  <td className="td">{employee.code}</td>
                  <td className="td">
                    <Link href={`/employees/${employee.id}`} className="font-medium hover:underline">
                      {employee.fullName}
                    </Link>
                    <div className="text-[12px] text-[color:var(--color-muted)]">
                      {employee.designation ?? "—"}
                    </div>
                  </td>
                  <td className="td">{employee.department ?? "—"}</td>
                  <td className="td whitespace-nowrap">{fmtDate(employee.joinedOn)}</td>
                  <td className="td num">
                    {!canSeeSalaries(user.role) ? (
                      <span className="text-[color:var(--color-muted)]">hidden</span>
                    ) : monthly ? (
                      rupees(monthly)
                    ) : (
                      <span className="text-[color:var(--color-warn)]">no structure</span>
                    )}
                  </td>
                  <td className="td">
                    <span className={`pill ${tone(employee.status)}`}>
                      {employee.status.replace("_", " ").toLowerCase()}
                    </span>
                  </td>
                </tr>
              );
            })}
            {employees.length === 0 && (
              <tr>
                <td className="td text-[color:var(--color-muted)]" colSpan={6}>
                  Nobody here yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

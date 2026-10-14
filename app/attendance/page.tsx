import { revalidatePath } from "next/cache";
import Link from "next/link";
import { db } from "@/lib/db";
import { requirePayroll, requireUser } from "@/lib/auth";
import { fmtMonth, monthFromValue, monthValue } from "@/lib/format";
import { daysInMonth, monthStart } from "@/lib/run";

/*
  Attendance for a month: one row per employee, two numbers each.

  Deliberately one grid and one Save, not a row of little forms. The
  person doing this has a register or a biometric export beside them and
  wants to type down a column, not click twenty times.
*/

export const dynamic = "force-dynamic";

async function saveAttendance(formData: FormData) {
  "use server";
  const user = await requirePayroll();
  const period = monthFromValue(String(formData.get("period")));
  const submitted = formData.getAll("employeeId").map(String);

  // Only ids that belong to this company, read from the database rather
  // than trusted from the form.
  const own = await db.employee.findMany({
    where: { id: { in: submitted }, companyId: user.companyId },
    select: { id: true },
  });

  for (const { id } of own) {
    const payable = Number(formData.get(`payable-${id}`) ?? 0);
    const lop = Number(formData.get(`lop-${id}`) ?? 0);
    // A blank row is left alone rather than written as zero: zero payable
    // days would silently pay nobody.
    if (!payable && !lop) continue;

    await db.attendance.upsert({
      where: { employeeId_period: { employeeId: id, period } },
      create: {
        employeeId: id,
        period,
        payableDays: payable,
        workedDays: Math.max(0, payable - lop),
        lopDays: lop,
      },
      update: {
        payableDays: payable,
        workedDays: Math.max(0, payable - lop),
        lopDays: lop,
      },
    });
  }

  revalidatePath("/attendance");
}

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const params = await searchParams;
  const user = await requireUser();
  const period = params.period ? monthFromValue(params.period) : monthStart(new Date());
  const total = daysInMonth(period);

  const employees = await db.employee.findMany({
    where: {
      companyId: user.companyId,
      status: { in: ["ACTIVE", "ON_NOTICE"] },
      joinedOn: { lte: new Date(period.getFullYear(), period.getMonth() + 1, 0) },
    },
    include: { attendance: { where: { period } } },
    orderBy: { code: "asc" },
  });

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Attendance</h1>
          <p className="text-[13px] text-[color:var(--color-muted)]">
            {fmtMonth(period)} · {total} days · only loss of pay changes the salary
          </p>
        </div>
        <form className="flex items-end gap-2">
          <div>
            <label className="label" htmlFor="period">Month</label>
            <input
              className="input"
              id="period"
              name="period"
              type="month"
              defaultValue={monthValue(period)}
            />
          </div>
          <button className="btn-light" type="submit">Go</button>
        </form>
      </header>

      <form action={saveAttendance}>
        <input type="hidden" name="period" value={monthValue(period)} />
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead className="bg-[color:var(--color-paper)]">
              <tr>
                <th className="th">Code</th>
                <th className="th">Name</th>
                <th className="th num">Payable days</th>
                <th className="th num">Loss of pay</th>
                <th className="th">Note</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((employee) => {
                const row = employee.attendance[0];
                const joinedThisMonth =
                  employee.joinedOn.getFullYear() === period.getFullYear() &&
                  employee.joinedOn.getMonth() === period.getMonth();
                return (
                  <tr key={employee.id}>
                    <td className="td">{employee.code}</td>
                    <td className="td">
                      <Link href={`/employees/${employee.id}`} className="hover:underline">
                        {employee.fullName}
                      </Link>
                      <input type="hidden" name="employeeId" value={employee.id} />
                    </td>
                    <td className="td num">
                      <input
                        className="input h-8 w-24 text-right"
                        name={`payable-${employee.id}`}
                        type="number"
                        step="0.5"
                        min={0}
                        max={31}
                        defaultValue={row?.payableDays ?? total}
                        aria-label={`Payable days for ${employee.fullName}`}
                      />
                    </td>
                    <td className="td num">
                      <input
                        className="input h-8 w-24 text-right"
                        name={`lop-${employee.id}`}
                        type="number"
                        step="0.5"
                        min={0}
                        max={31}
                        defaultValue={row?.lopDays ?? 0}
                        aria-label={`Loss of pay for ${employee.fullName}`}
                      />
                    </td>
                    <td className="td text-[12px] text-[color:var(--color-muted)]">
                      {joinedThisMonth
                        ? `Joined on the ${employee.joinedOn.getDate()}: the part-month is worked out automatically`
                        : (row?.note ?? "")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button className="btn" type="submit">Save attendance</button>
          <p className="text-[12px] text-[color:var(--color-muted)]">
            A joiner or a leaver does not need loss of pay entered: the run works their part-month
            out from the dates on their record.
          </p>
        </div>
      </form>
    </div>
  );
}

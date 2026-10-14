import { db } from "../lib/db.js";
import { hashPassword } from "../lib/auth.js";

/*
  Seed: one company, the standard salary components, the statutory rates
  as of 2026, professional tax slabs for a few states, and eight
  employees spread across the cases that break payroll software.

  Run with `npm run db:seed`. Safe to repeat: it clears first.

  The eight are chosen deliberately:
  - someone below the ESI ceiling, and someone above it
  - someone above the PF ceiling, and someone PF-exempt
  - someone with loss of pay this month
  - someone with a loan being recovered
  - someone who joined mid-month
  - someone in a state with professional tax, and one in Delhi without
*/

const L = (lakhs: number) => Math.round(lakhs * 100000 * 100); // lakhs -> paise
const R = (rupees: number) => Math.round(rupees * 100); // rupees -> paise

const monthStart = (offset = 0) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + offset, 1);
};

async function main() {
  /*
    Children before parents, or Postgres refuses the delete: a company
    cannot go while a user, an employee or a component still points at
    it. Users were added last and belong above Company here.
  */
  await db.$transaction([
    db.payslipLine.deleteMany(),
    db.payslip.deleteMany(),
    db.payrollRun.deleteMany(),
    db.settlement.deleteMany(),
    db.reimbursement.deleteMany(),
    db.loan.deleteMany(),
    db.attendance.deleteMany(),
    db.structureComponent.deleteMany(),
    db.salaryStructure.deleteMany(),
    db.salaryComponent.deleteMany(),
    db.employee.deleteMany(),
    db.professionalTaxSlab.deleteMany(),
    db.statutorySettings.deleteMany(),
    db.user.deleteMany(),
    db.company.deleteMany(),
  ]);

  const company = await db.company.create({
    data: {
      name: "Harbour Systems Private Limited",
      address: "C-42, Okhla Industrial Area Phase 2",
      city: "New Delhi",
      state: "Delhi",
      pan: "AAACH0000A",
      tan: "DELH00000A",
      pfCode: "DL/12345",
      esiCode: "11000123450000999",
      payDay: 1,
    },
  });

  /*
    Statutory rates as of 2026. VERIFY against the current notification
    before paying anyone real: these change by gazette, not by release.
  */
  const settings = await db.statutorySettings.create({
    data: {
      companyId: company.id,
      pfEmployeeRate: 1200, // 12%
      pfEmployerRate: 1200,
      pfPensionRate: 833, // 8.33%, capped at the ceiling wage
      pfWageCeiling: R(15000),
      pfCapAtCeiling: true,
      pfAdminRate: 50, // 0.5%
      pfAdminMinimum: R(500),
      esiEmployeeRate: 75, // 0.75%
      esiEmployerRate: 325, // 3.25%
      esiWageCeiling: R(21000),
    },
  });

  /*
    Professional tax. A state subject: Delhi has none, which is why the
    seeded company is in Delhi and one employee sits in Maharashtra to
    exercise the other path.
  */
  await db.professionalTaxSlab.createMany({
    data: [
      // Maharashtra: nil to ₹7,500, then ₹175, then ₹200 with ₹300 in February.
      { settingsId: settings.id, state: "Maharashtra", fromPaise: 0, toPaise: R(7500), amountPaise: 0 },
      { settingsId: settings.id, state: "Maharashtra", fromPaise: R(7501), toPaise: R(10000), amountPaise: R(175) },
      { settingsId: settings.id, state: "Maharashtra", fromPaise: R(10001), toPaise: null, amountPaise: R(200) },
      { settingsId: settings.id, state: "Maharashtra", fromPaise: R(10001), toPaise: null, amountPaise: R(300), month: 2 },
      // Karnataka: nil up to ₹25,000, then ₹200.
      { settingsId: settings.id, state: "Karnataka", fromPaise: 0, toPaise: R(24999), amountPaise: 0 },
      { settingsId: settings.id, state: "Karnataka", fromPaise: R(25000), toPaise: null, amountPaise: R(200) },
    ],
  });

  /*
    The components a small Indian firm actually uses. Which of them count
    as PF wages and ESI wages is the detail that decides every statutory
    number downstream.
  */
  const components = await Promise.all(
    [
      { code: "BASIC", name: "Basic", kind: "EARNING" as const, pfWage: true, esiWage: true, prorated: true, position: 10 },
      { code: "DA", name: "Dearness allowance", kind: "EARNING" as const, pfWage: true, esiWage: true, prorated: true, position: 20 },
      { code: "HRA", name: "House rent allowance", kind: "EARNING" as const, pfWage: false, esiWage: true, prorated: true, position: 30 },
      { code: "CONVEYANCE", name: "Conveyance", kind: "EARNING" as const, pfWage: false, esiWage: true, prorated: true, position: 40 },
      { code: "SPECIAL", name: "Special allowance", kind: "EARNING" as const, pfWage: false, esiWage: true, prorated: true, position: 50 },
      { code: "LTA", name: "Leave travel allowance", kind: "EARNING" as const, pfWage: false, esiWage: true, prorated: true, position: 60 },
    ].map((data) => db.salaryComponent.create({ data: { ...data, companyId: company.id } })),
  );
  const byCode = Object.fromEntries(components.map((c) => [c.code, c.id]));

  /** Builds a structure from a monthly gross, the usual way it is split. */
  const structureFor = (monthlyGrossPaise: number) => {
    const basic = Math.round(monthlyGrossPaise * 0.5);
    const hra = Math.round(basic * 0.4);
    const conveyance = Math.min(R(1600), Math.round(monthlyGrossPaise * 0.05));
    const special = monthlyGrossPaise - basic - hra - conveyance;
    return [
      { componentId: byCode.BASIC, calc: "FIXED" as const, value: basic },
      { componentId: byCode.HRA, calc: "FIXED" as const, value: hra },
      { componentId: byCode.CONVEYANCE, calc: "FIXED" as const, value: conveyance },
      { componentId: byCode.SPECIAL, calc: "FIXED" as const, value: special },
    ];
  };

  const people = [
    { code: "EMP-0001", fullName: "Rohit Verma", designation: "Operations manager", department: "Operations", state: "Delhi", gross: R(72000), joined: "2021-04-12" },
    { code: "EMP-0002", fullName: "Meera Shah", designation: "Senior engineer", department: "Engineering", state: "Maharashtra", gross: R(110000), joined: "2019-07-01" },
    { code: "EMP-0003", fullName: "Imran Qureshi", designation: "Accountant", department: "Finance", state: "Delhi", gross: R(38000), joined: "2023-01-16" },
    // Below the ESI ceiling: ESI applies to these two.
    { code: "EMP-0004", fullName: "Sunita Devi", designation: "Machine operator", department: "Plant", state: "Delhi", gross: R(18500), joined: "2022-09-05" },
    { code: "EMP-0005", fullName: "Ramesh Yadav", designation: "Store assistant", department: "Plant", state: "Delhi", gross: R(16000), joined: "2024-02-20" },
    // PF-exempt: never a member, joined above the ceiling.
    { code: "EMP-0006", fullName: "Kabir Anand", designation: "Design lead", department: "Design", state: "Karnataka", gross: R(145000), joined: "2025-06-02", pfExempt: true },
    { code: "EMP-0007", fullName: "Divya Menon", designation: "Sales executive", department: "Sales", state: "Delhi", gross: R(45000), joined: "2024-11-11" },
    // Joined mid-month: the first payslip must be part of a month.
    { code: "EMP-0008", fullName: "Arjun Nair", designation: "Junior engineer", department: "Engineering", state: "Delhi", gross: R(32000), joined: new Date(monthStart().getFullYear(), monthStart().getMonth(), 16).toISOString() },
  ];

  const employees = [];
  for (const person of people) {
    const employee = await db.employee.create({
      data: {
        companyId: company.id,
        code: person.code,
        fullName: person.fullName,
        email: `${person.code.toLowerCase()}@harbour.example`,
        phone: "+91 98100 000" + person.code.slice(-2),
        designation: person.designation,
        department: person.department,
        state: person.state,
        joinedOn: new Date(person.joined),
        pfExempt: person.pfExempt ?? false,
        pan: "ABCDE1234F",
        uan: "1001" + person.code.slice(-8).replace(/\D/g, "").padStart(8, "0"),
        bankName: "HDFC Bank",
        bankAccount: "5010" + person.code.slice(-4).replace(/\D/g, "").padStart(8, "0"),
        bankIfsc: "HDFC0001234",
        salaryStructures: {
          create: {
            effectiveFrom: new Date(person.joined),
            ctcAnnualPaise: person.gross * 12,
            components: { create: structureFor(person.gross) },
          },
        },
      },
    });
    employees.push(employee);
  }

  // This month's attendance: everyone full, except one with three days
  // of loss of pay and the mid-month joiner.
  const period = monthStart();
  const daysInMonth = new Date(period.getFullYear(), period.getMonth() + 1, 0).getDate();

  for (const employee of employees) {
    const joinedThisMonth =
      employee.joinedOn.getFullYear() === period.getFullYear() &&
      employee.joinedOn.getMonth() === period.getMonth();
    const payableDays = joinedThisMonth
      ? daysInMonth - employee.joinedOn.getDate() + 1
      : daysInMonth;
    const lop = employee.code === "EMP-0007" ? 3 : 0;

    await db.attendance.create({
      data: {
        employeeId: employee.id,
        period,
        payableDays,
        workedDays: payableDays - lop,
        lopDays: lop,
        note: joinedThisMonth ? "Joined mid-month" : lop ? "Unapproved absence" : null,
      },
    });
  }

  // One loan being recovered, because every small firm has one.
  await db.loan.create({
    data: {
      employeeId: employees[2].id,
      reason: "Salary advance for medical expenses",
      principalPaise: R(60000),
      instalmentPaise: R(5000),
      recoveredPaise: R(15000),
      startPeriod: monthStart(-3),
    },
  });

  await db.reimbursement.create({
    data: {
      employeeId: employees[6].id,
      description: "Client travel, Jaipur",
      amountPaise: R(4200),
      status: "APPROVED",
      period,
    },
  });

  /*
    Sign-ins for the demo database.

    `admin` / `admin123` is a convenience for local work ONLY. It is
    short, guessable, and the account it opens can see every salary in
    the company. A real installation goes through /setup, which demands
    ten characters for exactly that reason, and this seed must never be
    run against a real database.
  */
  const demoPassword = "admin123";
  await db.user.createMany({
    data: [
      {
        companyId: company.id,
        name: "Anita Rao",
        email: "admin",
        role: "OWNER",
        passwordHash: hashPassword(demoPassword),
      },
      {
        companyId: company.id,
        name: "Vikas Sharma",
        email: "payroll",
        role: "PAYROLL",
        passwordHash: hashPassword(demoPassword),
      },
      {
        companyId: company.id,
        name: "Deepa Nair",
        email: "viewer",
        role: "VIEWER",
        passwordHash: hashPassword(demoPassword),
      },
    ],
  });

  console.log(
    `Seeded: ${company.name}, ${employees.length} employees, attendance for ` +
      `${period.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}, ` +
      `1 loan, 1 reimbursement.\n` +
      `Sign in: admin / ${demoPassword} (owner). Also "payroll" and "viewer", same password.\n` +
      `Statutory rates are 2026 defaults: verify before real use.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());

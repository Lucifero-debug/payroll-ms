# CONTEXT

Handover document for payroll-ms. Read this before changing anything; the
README says what the project is and how to run it.

Written so another assistant (ChatGPT, Gemini, Claude) or a future you can
continue without having seen it built.

---

## 1. What this is, and who for

Monthly payroll for a **small Indian business**, ten to two hundred staff,
where one person does payroll alongside three other jobs. Today they use
a spreadsheet that someone built years ago, and they copy last month's
tab.

The specific failures that spreadsheet causes, which this exists to fix:

1. PF is worked out on the wrong wage, usually by ignoring the ceiling or
   the pension split.
2. Someone crosses the ESI threshold and nobody notices until an
   inspection.
3. Loss of pay is applied inconsistently, and the employee argues.
4. Payslips are produced by hand, late, and do not match the bank file.
5. Last year's numbers cannot be reproduced, because the sheet was
   overwritten.

Everything below serves one of those five.

**Deliberately out of scope:** biometric integration, a full income-tax
engine, leave management, expense claims. Say no to these, or it never
ships.

---

## 2. Stack and conventions

- **Next.js 15 App Router, TypeScript, Tailwind v4** (configured in CSS),
  **PostgreSQL + Prisma**. Same as the other projects.
- **Server Components by default**, server actions for forms, zod at the
  boundary inside the action.
- **Money is paise, as `Int`.** Always. Helpers in `lib/money.ts`; no
  component does arithmetic on rupees.
- **Codes humans say aloud** (`EMP-0001`) alongside cuid primary keys.
  Never show a cuid.
- **British spelling** in copy and comments.

---

## 3. The data model

Read `prisma/schema.prisma`; it is commented. The parts that matter:

- **`SalaryStructure` is dated and immutable in practice.** A raise
  creates a new row with a new `effectiveFrom`; structures are never
  edited after a payroll has used one. That is what makes arrears
  calculable and old payslips still true.
- **`SalaryComponent` carries `pfWage` and `esiWage` flags.** Which
  components count towards PF wages (basic and DA) and the ESI gross
  decides every statutory number downstream. Get these wrong and
  everything else is wrong quietly.
- **`Payslip` copies everything** at processing: name, designation, PAN,
  UAN, bank account, each line's label, every rate. Nothing is looked up
  live.
- **`PayrollRun.status`** goes DRAFT, PROCESSED, PAID. A DRAFT is
  recalculated freely; **PROCESSED must never be recalculated**, only
  cancelled and re-run, and cancelling a processed run should require a
  reason.
- **`StatutorySettings` and `ProfessionalTaxSlab`** hold the rates,
  because they change by notification.
- **`Attendance` is a monthly summary, not a punch log**, on purpose:
  asking a small firm to move its attendance register in first is how
  payroll software goes unused.

---

## 4. The engine

`lib/payroll.ts`, one pure function. The order it works in:

1. Prorate earnings by the loss-of-pay factor (calendar days, not working
   days: that is Indian practice and what employees expect).
2. Add arrears, which are never prorated and do attract PF and ESI.
3. PF on the PF wage, capped at the ceiling unless the employer pays on
   full basic. The employer's 12% splits into 8.33% pension (always
   capped) and the remainder.
4. ESI only if the gross is at or below the ceiling, both sides.
5. Professional tax from the slabs, for the employee's state, with a
   month-specific slab winning over the year-round one.
6. TDS, loans and other deductions.
7. Reimbursements, which are paid out but sit outside gross and attract
   nothing.

**Tests are in `tests/payroll.test.ts` with the arithmetic worked out in
the comments.** Run `npm test` before every commit that touches money. If
you change a rule, change a test first and make it say why.

---

## 5. What exists and what does not

**Done:** schema, engine, money helpers, tests, seed, and the working
product:

- **`lib/run.ts`**, the bridge between the database and the engine:
  resolves the structure in force, folds a joiner's or leaver's
  part-month into the loss-of-pay figure (one proration rule, not two),
  resolves BALANCE components, takes one loan instalment, and persists a
  processed run in a single transaction.
- **Dashboard** (`app/page.tsx`): this month's gross, net, statutory and
  employer cost, anyone missing a structure or attendance, recent runs.
- **Employees** (`app/employees/`): list, add with an automatic salary
  split, detail with a **live preview of this month's payslip** computed
  by the same function the run uses, salary revision as a new dated
  structure, loans, and the record itself.
- **Attendance** (`app/attendance/`): one grid per month, one Save.
- **Payroll runs** (`app/payroll/`): open a month, review the register
  with **each employee's net beside last month's and anything that moved
  by 10% flagged**, process, mark paid, cancel with a reason (which puts
  loan recoveries back).
- **Payslip** (`app/payslips/[id]`): printable, read from the stored
  lines, with the amount in words.
- **Bank advice** (`app/payroll/[id]/bank`): CSV from the payslips as
  issued.

**Not built yet,** in the order I would build it:

1. **Statutory returns:** the PF ECR text file, the ESI contribution
   file, a PT summary by state, a TDS summary. These are what actually
   make an operator abandon a spreadsheet, and the data is all there.
2. **Component-level structure editing.** Today a salary is entered as a
   monthly gross and split by a fixed rule; the schema supports any set
   of components and the percentage kinds, but no screen edits them.
3. **Arrears.** The engine takes an `arrearsPaise` input and nothing
   feeds it yet: a backdated revision should offer to pay the difference.
4. **TDS entry** per employee per month, with the estimator shown beside
   it as a suggestion.
5. **Bulk payslip send** over email or WhatsApp.
6. **Full and final:** the `Settlement` model and `gratuity()` exist, the
   screen does not.
7. **CSV import** for attendance, because that is how the data arrives
   from a biometric machine.
8. **Auth and roles.** The `UserRole` enum exists: OWNER and PAYROLL see
   salaries, VIEWER sees only totals. Enforce it in the queries, not just
   in the interface, because a salary leak is unrecoverable.

**Known rough edges:** server-action validation errors are thrown rather
than shown inline per field; there is no pagination; and the employee
preview rebuilds the computed row from a slightly different query shape
than the run does, so if you change `loadEmployees`, check that page too.

---

## 6. Decisions already made, with reasons

- **Rates in the database, not in code**, so a notification is a settings
  change rather than a deployment.
- **TDS is entered, not computed.** A rough new-regime estimator exists
  for guidance; it ignores other income, chapter VI-A, perquisites and
  surcharge. Never make it the default silently.
- **Attendance is a summary**, see above.
- **Payslips copy everything**, see above.
- **Professional tax by state on the employee**, not the company, because
  remote staff in another state are now normal.
- **Reimbursements sit outside gross**, since they are the employee's own
  money returning and attract neither PF, ESI nor tax.

---

## 7. If you are an AI continuing this

- Keep the scope. The temptation is to build a tax engine; resist it.
- Touching `lib/payroll.ts` means adding or changing a test in the same
  commit, with the arithmetic in the comment.
- Match the style: server components, server actions, zod at the
  boundary, paise, codes for humans.
- When you finish a screen, update section 5 here. A stale handover file
  is worse than none.
- Never let a PROCESSED run be silently recalculated. If you find
  yourself writing that, you have misunderstood the product.

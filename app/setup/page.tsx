import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { hashPassword, signIn } from "@/lib/auth";
import { toPaise } from "@/lib/money";

/*
  First run: create the company, its owner, its statutory settings and
  its salary components, in one transaction.

  A new tenant with no components or no rates is a tenant whose first
  payroll silently pays nobody, so none of it is optional and none of it
  is left for later.

  Closed as soon as one user exists. Adding a second company is a thing
  the product should do deliberately (and bill for), not something a
  stranger can do by visiting a URL.
*/

export const dynamic = "force-dynamic";

const R = (rupees: number) => Math.round(rupees * 100);

async function setup(formData: FormData) {
  "use server";

  if ((await db.user.count()) > 0) redirect("/login");

  const companyName = String(formData.get("companyName") ?? "").trim();
  const state = String(formData.get("state") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!companyName || !state || !name || !email) throw new Error("Fill in every field");
  if (password.length < 10) {
    throw new Error("Use a password of at least ten characters: this account can see every salary");
  }

  const company = await db.$transaction(async (tx) => {
    const created = await tx.company.create({
      data: {
        name: companyName,
        state,
        address: String(formData.get("address") ?? "") || null,
        city: String(formData.get("city") ?? "") || null,
        pan: String(formData.get("pan") ?? "") || null,
        pfCode: String(formData.get("pfCode") ?? "") || null,
        esiCode: String(formData.get("esiCode") ?? "") || null,
      },
    });

    await tx.user.create({
      data: {
        companyId: created.id,
        name,
        email,
        passwordHash: hashPassword(password),
        role: "OWNER",
      },
    });

    /*
      Statutory rates as of 2026. THESE MUST BE CHECKED against the
      current notification before this company's first real payroll;
      they are defaults to get started with, not advice.
    */
    await tx.statutorySettings.create({
      data: {
        companyId: created.id,
        pfEmployeeRate: 1200,
        pfEmployerRate: 1200,
        pfPensionRate: 833,
        pfWageCeiling: R(15000),
        pfCapAtCeiling: true,
        pfAdminRate: 50,
        pfAdminMinimum: R(500),
        esiEmployeeRate: 75,
        esiEmployerRate: 325,
        esiWageCeiling: R(21000),
      },
    });

    await tx.salaryComponent.createMany({
      data: [
        { companyId: created.id, code: "BASIC", name: "Basic", kind: "EARNING", pfWage: true, esiWage: true, prorated: true, position: 10 },
        { companyId: created.id, code: "DA", name: "Dearness allowance", kind: "EARNING", pfWage: true, esiWage: true, prorated: true, position: 20 },
        { companyId: created.id, code: "HRA", name: "House rent allowance", kind: "EARNING", pfWage: false, esiWage: true, prorated: true, position: 30 },
        { companyId: created.id, code: "CONVEYANCE", name: "Conveyance", kind: "EARNING", pfWage: false, esiWage: true, prorated: true, position: 40 },
        { companyId: created.id, code: "SPECIAL", name: "Special allowance", kind: "EARNING", pfWage: false, esiWage: true, prorated: true, position: 50 },
        { companyId: created.id, code: "LTA", name: "Leave travel allowance", kind: "EARNING", pfWage: false, esiWage: true, prorated: true, position: 60 },
      ],
    });

    return created;
  });

  void company;
  await signIn(email, password);
  redirect("/");
}

export default async function SetupPage() {
  if ((await db.user.count()) > 0) redirect("/login");

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-[20px] font-semibold tracking-tight">Set up payroll</h1>
      <p className="mt-1 text-[13px] text-[color:var(--color-muted)]">
        The firm, and the first account. This page closes once an account exists.
      </p>

      <form action={setup} className="card mt-6 space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="companyName">Company name</label>
            <input className="input" id="companyName" name="companyName" required autoFocus />
          </div>
          <div>
            <label className="label" htmlFor="state">State</label>
            <input className="input" id="state" name="state" placeholder="Delhi" required />
          </div>
          <div>
            <label className="label" htmlFor="city">City</label>
            <input className="input" id="city" name="city" />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="address">Address</label>
            <input className="input" id="address" name="address" />
          </div>
          <div>
            <label className="label" htmlFor="pan">PAN</label>
            <input className="input" id="pan" name="pan" />
          </div>
          <div>
            <label className="label" htmlFor="pfCode">PF establishment code</label>
            <input className="input" id="pfCode" name="pfCode" />
          </div>
          <div>
            <label className="label" htmlFor="esiCode">ESI code</label>
            <input className="input" id="esiCode" name="esiCode" />
          </div>
        </div>

        <div className="border-t border-[color:var(--color-line)] pt-5">
          <p className="mb-3 text-[13px] font-medium">Your account</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="name">Your name</label>
              <input className="input" id="name" name="name" required />
            </div>
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input className="input" id="email" name="email" type="email" required />
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="password">Password, at least ten characters</label>
              <input
                className="input"
                id="password"
                name="password"
                type="password"
                minLength={10}
                autoComplete="new-password"
                required
              />
            </div>
          </div>
        </div>

        <p className="text-[12px] text-[color:var(--color-muted)]">
          PF, ESI and professional tax rates are created with the 2026 defaults. Check them against
          the current notification before your first real payroll.
        </p>
        <button className="btn w-full" type="submit">Create and sign in</button>
      </form>
    </div>
  );
}

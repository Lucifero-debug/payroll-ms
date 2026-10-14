"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { nextEmployeeCode } from "@/lib/format";
import { toPaise } from "@/lib/money";

/*
  Employee actions. Validation lives here rather than in the form: a form
  can be bypassed, a server action cannot.
*/

const date = (value: FormDataEntryValue | null) =>
  value && String(value).trim() ? new Date(String(value)) : null;
const text = (value: FormDataEntryValue | null) => String(value ?? "").trim() || null;

const createSchema = z.object({
  fullName: z.string().min(2, "Name as it appears on the bank account"),
  designation: z.string().optional(),
  department: z.string().optional(),
  state: z.string().optional(),
  joinedOn: z.string().min(4, "Joining date is needed"),
  monthlyGross: z.string().min(1, "Monthly gross is needed"),
});

/**
 * Adds an employee with a first salary structure.
 *
 * The split is the conventional one for a small Indian firm: half as
 * basic (which is what PF is charged on), 40% of basic as HRA, a capped
 * conveyance, and the remainder as special allowance. The operator can
 * change any of it afterwards; what matters is that nobody is created
 * without a structure, because an employee with no structure is an
 * employee who silently drops out of the payroll.
 */
export async function createEmployee(formData: FormData) {
  const parsed = createSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join(", "));
  const data = parsed.data;

  const company = await db.company.findFirst();
  if (!company) throw new Error("No company set up");

  const gross = toPaise(data.monthlyGross);
  const count = await db.employee.count();

  const components = await db.salaryComponent.findMany({
    where: { code: { in: ["BASIC", "HRA", "CONVEYANCE", "SPECIAL"] } },
  });
  const id = (code: string) => components.find((c) => c.code === code)?.id;
  if (!id("BASIC")) throw new Error("Salary components are not set up: run the seed");

  const basic = Math.round(gross * 0.5);
  const hra = Math.round(basic * 0.4);
  const conveyance = Math.min(toPaise(1600), Math.round(gross * 0.05));
  const special = gross - basic - hra - conveyance;

  const employee = await db.employee.create({
    data: {
      companyId: company.id,
      code: nextEmployeeCode(count),
      fullName: data.fullName,
      designation: data.designation || null,
      department: data.department || null,
      state: data.state || company.state,
      joinedOn: new Date(data.joinedOn),
      email: text(formData.get("email")),
      phone: text(formData.get("phone")),
      pan: text(formData.get("pan")),
      uan: text(formData.get("uan")),
      bankName: text(formData.get("bankName")),
      bankAccount: text(formData.get("bankAccount")),
      bankIfsc: text(formData.get("bankIfsc")),
      pfExempt: formData.get("pfExempt") === "on",
      salaryStructures: {
        create: {
          effectiveFrom: new Date(data.joinedOn),
          ctcAnnualPaise: gross * 12,
          components: {
            create: [
              { componentId: id("BASIC")!, calc: "FIXED", value: basic },
              { componentId: id("HRA")!, calc: "FIXED", value: hra },
              { componentId: id("CONVEYANCE")!, calc: "FIXED", value: conveyance },
              { componentId: id("SPECIAL")!, calc: "FIXED", value: special },
            ],
          },
        },
      },
    },
  });

  redirect(`/employees/${employee.id}`);
}

/**
 * A raise: a NEW structure from a date, never an edit of the old one.
 *
 * Editing in place would rewrite history, and the first thing anyone
 * asks after a raise is "what was I on in March".
 */
export async function reviseSalary(formData: FormData) {
  const employeeId = String(formData.get("employeeId"));
  const effectiveFrom = date(formData.get("effectiveFrom"));
  const gross = toPaise(String(formData.get("monthlyGross") ?? "0"));
  if (!effectiveFrom) throw new Error("A date is needed: a structure without one cannot be applied");
  if (gross <= 0) throw new Error("Enter the new monthly gross");

  const components = await db.salaryComponent.findMany({
    where: { code: { in: ["BASIC", "HRA", "CONVEYANCE", "SPECIAL"] } },
  });
  const id = (code: string) => components.find((c) => c.code === code)!.id;

  const basic = Math.round(gross * 0.5);
  const hra = Math.round(basic * 0.4);
  const conveyance = Math.min(toPaise(1600), Math.round(gross * 0.05));
  const special = gross - basic - hra - conveyance;

  await db.salaryStructure.create({
    data: {
      employeeId,
      effectiveFrom,
      ctcAnnualPaise: gross * 12,
      note: text(formData.get("note")),
      components: {
        create: [
          { componentId: id("BASIC"), calc: "FIXED", value: basic },
          { componentId: id("HRA"), calc: "FIXED", value: hra },
          { componentId: id("CONVEYANCE"), calc: "FIXED", value: conveyance },
          { componentId: id("SPECIAL"), calc: "FIXED", value: special },
        ],
      },
    },
  });

  revalidatePath(`/employees/${employeeId}`);
}

export async function updateEmployee(formData: FormData) {
  const id = String(formData.get("employeeId"));
  await db.employee.update({
    where: { id },
    data: {
      designation: text(formData.get("designation")),
      department: text(formData.get("department")),
      state: text(formData.get("state")),
      phone: text(formData.get("phone")),
      pan: text(formData.get("pan")),
      uan: text(formData.get("uan")),
      esiNumber: text(formData.get("esiNumber")),
      bankName: text(formData.get("bankName")),
      bankAccount: text(formData.get("bankAccount")),
      bankIfsc: text(formData.get("bankIfsc")),
      pfExempt: formData.get("pfExempt") === "on",
      status: String(formData.get("status") ?? "ACTIVE") as "ACTIVE",
      exitedOn: date(formData.get("exitedOn")),
    },
  });
  revalidatePath(`/employees/${id}`);
}

export async function addLoan(formData: FormData) {
  const employeeId = String(formData.get("employeeId"));
  await db.loan.create({
    data: {
      employeeId,
      reason: String(formData.get("reason") ?? "Advance"),
      principalPaise: toPaise(String(formData.get("principal") ?? "0")),
      instalmentPaise: toPaise(String(formData.get("instalment") ?? "0")),
      startPeriod: date(formData.get("startPeriod")) ?? new Date(),
    },
  });
  revalidatePath(`/employees/${employeeId}`);
}

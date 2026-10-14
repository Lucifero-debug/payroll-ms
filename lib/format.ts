/** Dates and small helpers the screens share. */

export const fmtDate = (date: Date | null | undefined) =>
  date
    ? date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : "—";

export const fmtMonth = (date: Date) =>
  date.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

/** "2026-10" for a month input. */
export const monthValue = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

/** "2026-10" back to the first of that month, in local time. */
export const monthFromValue = (value: string) => {
  const [year, month] = value.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, 1);
};

export const ymd = (date: Date | null | undefined) =>
  date ? date.toISOString().slice(0, 10) : "";

export function tone(value: string) {
  const map: Record<string, string> = {
    DRAFT: "bg-amber-50 text-amber-700",
    PROCESSED: "bg-blue-50 text-blue-700",
    PAID: "bg-green-50 text-green-700",
    CANCELLED: "bg-red-50 text-red-700",
    ACTIVE: "bg-green-50 text-green-700",
    ON_NOTICE: "bg-amber-50 text-amber-700",
    EXITED: "bg-neutral-100 text-neutral-600",
    ON_LEAVE: "bg-neutral-100 text-neutral-600",
  };
  return map[value] ?? "bg-neutral-100 text-neutral-600";
}

/** EMP-0007: the next code in the series. */
export const nextEmployeeCode = (count: number) => `EMP-${String(count + 1).padStart(4, "0")}`;

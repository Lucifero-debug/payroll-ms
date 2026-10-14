/*
  Money, in paise.

  Every amount in this system is an integer number of paise. Payroll adds
  up hundreds of numbers per employee per month and then has to agree with
  a bank transfer, a PF challan and an income-tax return. Floating point
  loses that argument.

  Rupees exist only at the edges: parsed on input, formatted on output.
*/

/** 12500000 -> "₹1,25,000" ; 12500050 -> "₹1,25,000.50" */
export function rupees(paise: number, { decimals = false } = {}): string {
  const value = paise / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: decimals || value % 1 !== 0 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value);
}

/** For dashboards: 4550000 -> "₹45.5k", 12500000 -> "₹1.25 L". */
export function rupeesShort(paise: number): string {
  const value = paise / 100;
  const abs = Math.abs(value);
  if (abs >= 1e7) return `₹${(value / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `₹${(value / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `₹${(value / 1e3).toFixed(1)}k`;
  return `₹${value.toFixed(0)}`;
}

/** "1,25,000.50" or "125000.5" -> 12500050 paise. Throws on nonsense. */
export function toPaise(input: string | number): number {
  const text = String(input).replace(/[₹,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new Error(`Not an amount: ${input}`);
  return Math.round(parseFloat(text) * 100);
}

/**
 * A percentage held in basis points, so 12% is 1200 and nothing is ever
 * stored as 0.12. Rounded half up, once, at the point of use.
 */
export const percent = (paise: number, basisPoints: number) =>
  Math.round((paise * basisPoints) / 10000);

/** Rupees, not paise: statutory amounts are conventionally whole rupees. */
export const toWholeRupees = (paise: number) => Math.round(paise / 100) * 100;

/** Words for a payslip or a cheque: "One Lakh Twenty Five Thousand Rupees Only". */
export function inWords(paise: number): string {
  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
    "Eighteen", "Nineteen",
  ];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  const two = (n: number): string =>
    n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ""}`;

  const rupeePart = Math.floor(Math.abs(paise) / 100);
  const paisePart = Math.abs(paise) % 100;

  // The Indian system groups as crore, lakh, thousand, hundred.
  const parts: string[] = [];
  const push = (value: number, label: string) => {
    if (value) parts.push(`${two(value)} ${label}`);
  };
  push(Math.floor(rupeePart / 1e7), "Crore");
  push(Math.floor((rupeePart % 1e7) / 1e5), "Lakh");
  push(Math.floor((rupeePart % 1e5) / 1000), "Thousand");
  push(Math.floor((rupeePart % 1000) / 100), "Hundred");
  const rest = rupeePart % 100;
  if (rest) parts.push(two(rest));

  const words = parts.length ? parts.join(" ") : "Zero";
  const sign = paise < 0 ? "Minus " : "";
  return paisePart
    ? `${sign}${words} Rupees and ${two(paisePart)} Paise Only`
    : `${sign}${words} Rupees Only`;
}

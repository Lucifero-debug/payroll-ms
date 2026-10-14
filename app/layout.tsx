import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser, signOut } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Payroll",
  description: "Monthly payroll: salaries, PF, ESI, professional tax, payslips and bank advice.",
};

const nav = [
  { href: "/", label: "Dashboard" },
  { href: "/employees", label: "Employees" },
  { href: "/attendance", label: "Attendance" },
  { href: "/payroll", label: "Payroll" },
];

async function leave() {
  "use server";
  await signOut();
  redirect("/login");
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Null on the login and setup pages, which render without the shell.
  const user = await getUser();

  return (
    <html lang="en-IN">
      <body className="min-h-screen">
        <div className="mx-auto flex max-w-[1500px] gap-6 px-4 py-5 md:px-6">
          {user && (
            <aside className="no-print hidden w-52 shrink-0 md:block">
              <div className="px-2 pb-1 text-[15px] font-semibold tracking-tight">
                {user.companyName}
              </div>
              <div className="mb-5 px-2 text-[11px] text-[color:var(--color-muted)]">
                {user.name} · {user.role.toLowerCase()}
              </div>
              <nav className="space-y-0.5">
                {nav.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="block rounded-md px-3 py-2 text-[14px] text-[color:var(--color-muted)] hover:bg-white hover:text-[color:var(--color-ink)]"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
              <form action={leave} className="mt-6 px-3">
                <button
                  type="submit"
                  className="text-[13px] text-[color:var(--color-muted)] hover:text-[color:var(--color-ink)]"
                >
                  Sign out
                </button>
              </form>
            </aside>
          )}
          <main className="min-w-0 flex-1 pb-16">{children}</main>
        </div>
      </body>
    </html>
  );
}

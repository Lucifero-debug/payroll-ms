import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getUser, signIn } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function login(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  const { error } = await signIn(email, password);
  // The message goes back in the URL rather than in a client component:
  // one fewer bundle on the one page everybody loads signed out.
  if (error) redirect(`/login?error=${encodeURIComponent(error)}`);
  redirect(next.startsWith("/") ? next : "/");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  if (await getUser()) redirect("/");

  // A fresh installation has nobody to sign in as, so send the first
  // visitor to set the company up instead of staring at a login form.
  const anyUser = await db.user.count();
  if (anyUser === 0) redirect("/setup");

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center">
      <h1 className="text-[20px] font-semibold tracking-tight">Payroll</h1>
      <p className="mt-1 text-[13px] text-[color:var(--color-muted)]">
        Sign in to run this month.
      </p>

      <form action={login} className="card mt-6 space-y-4 p-5">
        <input type="hidden" name="next" value={params.next ?? "/"} />
        <div>
          <label className="label" htmlFor="email">Email or username</label>
          {/*
            Not type="email": the browser would refuse a plain username
            such as "admin", and small firms hand out usernames rather
            than addresses more often than not.
          */}
          <input
            className="input"
            id="email"
            name="email"
            type="text"
            autoCapitalize="none"
            autoComplete="username"
            required
            autoFocus
          />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            className="input"
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        {params.error && (
          <p className="text-[13px] text-[color:var(--color-bad)]">{params.error}</p>
        )}
        <button className="btn w-full" type="submit">Sign in</button>
      </form>
    </div>
  );
}

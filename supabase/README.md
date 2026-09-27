# Supabase setup (Mova Store)

1. Create a project at [supabase.com](https://supabase.com).
2. Copy **Project URL** and **anon public** key into `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
3. Configure **Admin access** in `.env.local`:
   - Set `NEXT_PUBLIC_ADMIN_EMAILS` to your email (e.g. `NEXT_PUBLIC_ADMIN_EMAILS=admin@example.com`). Multiple emails can be comma-separated.
   - `AuthContext` reads this variable via `isAdminEmail` (`lib/env.ts`), and `components/AdminGuard.jsx` uses it to gate all `/admin` routes. If left unset, `isAdmin` defaults to `false` and authenticated users will be blocked with an "Access Denied" error when attempting to reach the admin catalog panel.
4. In the SQL editor, run [`schema.sql`](./schema.sql).
5. Auth → Providers: enable **Email** (and **Google** if you want OAuth).
6. Auth → URL Configuration: add `http://localhost:3000/**` (and your production URL).
7. Restart `npm run dev`.

Products live in the `products` table; images in the public `products` storage bucket.


## Orders: who may update or delete rows

`public.orders` is a payments table, so its write surface is intentionally narrow:

- `insert` — authenticated buyers create their own rows (see the insert policy in
  `schema.sql`).
- `update` / `delete` — **admin only**, granted explicitly through
  `public.is_admin()` (`"Admins can update orders"`, `"Admins can delete orders"`).

There is no permissive fallback: with RLS enabled and only those policies in place,
an `update` or `delete` by an unauthenticated or non-admin caller is denied by
default. A buyer's order status is authoritative once the Stellar payment has been
verified, so admin flows are the only sanctioned way to change it.

To grant admin rights, use the `public.admin_users` allowlist or the `is_admin`
JWT claim (`app_metadata.is_admin`) as described in [`../SECURITY.md`](../SECURITY.md).

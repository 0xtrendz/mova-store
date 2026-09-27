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


## Orders: who may insert rows

Only an authenticated buyer may create an order row, and only for their own
`user_id`:

```sql
create policy "Users can insert own orders"
  on public.orders for insert
  to authenticated
  with check (auth.uid() = user_id and status = 'Pending');
```

Consequences to be aware of when changing the checkout flow:

- **No `anon` inserts.** A request carrying only the public anon key is rejected.
  Guest checkout must therefore not write to `orders` directly; it either signs the
  buyer in or keeps the order client-side until it is claimed.
- **No client-written status.** The insert policy pins `status` to `'Pending'`, so a
  forged `'Paid'` row cannot come from the browser. Advancing the status is a
  server/admin action performed *after* the payment is verified on-chain (see the
  admin update policy in `schema.sql`).
- **`total`** is still guarded by the column's `total >= 0` check, and the
  authoritative amount is the value paid to the checkout contract, not the value in
  the request body.

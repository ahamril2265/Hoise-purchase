# Property Tracker

A small password-protected site for keeping track of properties viewed while house hunting.
Each property stores its name, location, type, price, match score (1–10) and agent number.

Built for Vercel: static files in `public/`, one serverless function in `api/`, data in Neon Postgres.

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In Vercel, choose **Add New → Project** and import the repository. Leave every setting at its default and deploy.
3. Open the project's **Storage** tab, choose **Create Database → Neon (Postgres)**, and connect it to the project.
   This adds the `DATABASE_URL` environment variable automatically.
4. Go to **Deployments** and **Redeploy** the latest deployment so it picks up the database.
5. Visit your site. The first visit shows **Create a password**. Set it straight away:
   once a password exists, registration closes and the site only shows sign-in.

Tables are created automatically on first use.

## Forgot the password?

In the Neon console (Vercel → Storage → your database → **Open in Neon** → SQL Editor), run:

```sql
DELETE FROM settings WHERE key = 'password_hash';
DELETE FROM sessions;
```

The next visit shows **Create a password** again. Your saved properties are kept.

## Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:3000. Without a `DATABASE_URL`, local runs use an in-process Postgres (PGlite)
saved to `.pglite/`, so you don't need a database account to try it. Set `DATABASE_URL` to use your Neon database instead.

## Customising

- **Currency symbol:** set `CURRENCY` at the top of `public/app.js` (e.g. `'USD'`, `'GBP'`, `'AED'`).
- **Property types:** edit `PROPERTY_TYPES` in `api/index.js`.

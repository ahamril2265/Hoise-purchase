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

## How the match score works

Set what you're looking for under **Preferences**: property types, areas, a budget range and a list of features.
Give each one an importance: **Must-have** (counts 3×), **Important** (2×) or **Nice to have** (1×).

Each property is checked against every preference, and the weighted share it meets becomes a score from 1 to 10:

- **Type:** matches if it's one of your chosen types.
- **Location:** matches if the location mentions any of your areas.
- **Budget:** full marks inside your range, with partial credit up to 25% outside it.
- **Features:** each feature you tick on the property counts on its own.

A property missing any must-have can't score above 4. Each card has a **Why this score?** breakdown.
You can also pin your own score on any property; the card then shows a star, and the breakdown still shows the calculated score.
Tweak the weights, the cap and the budget tolerance at the top of `public/app.js`.

## Photos and descriptions

Each property can have a description and up to 12 photos; the first photo is the cover (use ★ to change it).
Photos are resized in your browser before upload (to 1600px, typically 100–400 KB each) and stored in the
Neon database, so they're only visible after signing in. Neon's free plan includes 0.5 GB, which is room for
well over a thousand photos at that size. Deleting a property also deletes its photos.

## Map

The dashboard map shows every property that has a map location, as a pin coloured by match score.
Search and the type filter apply to the map too. Tap a pin for its photo, price and score, plus Directions.

Set a property's location in its edit form: paste coordinates or a full Google Maps link, use
**Find from location** (looks up the typed location on OpenStreetMap), **Use my current location**,
or click the map and drag the pin. Map tiles come from OpenStreetMap; Leaflet is served from `public/vendor/leaflet`.

## Updates never remove your data

Database changes in new versions only ever add tables or columns, applied automatically on the next request.
Existing properties, photos, preferences and your password are left as they are.

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

- **Numbers** use the Indian system (12,34,56,789, with lakh/crore labels). Change `NUMBER_LOCALE` at the top of `public/app.js` for another format.
- **Currency symbol:** set `CURRENCY` at the top of `public/app.js` (e.g. `'INR'` for ₹, `'AED'`, `'USD'`).
- **Property types:** edit `PROPERTY_TYPES` in `api/index.js`.

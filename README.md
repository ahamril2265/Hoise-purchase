# Property Tracker

A small password-protected site for keeping track of properties viewed while house hunting.
Each property stores its name, location, type, price, match score (1–10) and agent number.

No dependencies to install. It needs Node.js 22.13 or newer and uses Node's built-in SQLite.

## Run it

```bash
npm run set-password -- "choose-a-password"
npm start
```

Then open http://localhost:3000.

- Run `set-password` again at any time to reset the password. This also signs out every device.
- Once signed in, the client can change the password from **Change password** in the top bar.
- All data lives in `data.db`. Back up that file to back up everything.

## Settings (environment variables)

| Variable       | Default       | Purpose                                                          |
| -------------- | ------------- | ---------------------------------------------------------------- |
| `PORT`         | `3000`        | Port to listen on                                                |
| `HOST`         | `127.0.0.1`   | Use `0.0.0.0` when hosting so other devices can reach it         |
| `DB_PATH`      | `./data.db`   | Where the database file is stored                                |
| `APP_PASSWORD` | —             | Sets the initial password on first start (handy on hosts with no shell) |

To show a currency symbol with prices, set `CURRENCY` at the top of `public/app.js` (e.g. `'USD'`, `'GBP'`, `'AED'`).

## Hosting for the client

Put it behind HTTPS (most hosts like Render, Railway or a VPS with Caddy/nginx do this for you).
The session cookie is automatically marked `Secure` when the request arrives over HTTPS.
Make sure `data.db` is on persistent storage so it survives restarts and redeploys.

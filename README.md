# Gig Invoices

A one-screen iPhone app that leaves a gig invoice in your Gmail drafts. You check it and press Send.

- **Phone app** (`web/`): pick the client, fill in date, venue and fee, choose whether the invoice is a
  PDF attachment or the email itself, and tap **Create Gmail draft**.
- **Google side** (`apps-script/Code.gs`): renders the invoice and creates the draft in your own Gmail.

**Nothing is stored.** No spreadsheet, no Drive files, no list of past invoices. Your Gmail Sent folder
is the record. Your own name and bank details are typed into the app on first use and kept on your
phone; your clients live in `CONFIG` at the top of `Code.gs`, in your Google account and on your Mac,
never in this repo.

```
iPhone app  ──(web app URL + API key)──►  Apps Script  ──►  Gmail draft (PDF attached, or
                                                            the invoice in the email body)
```

## Your details

On first use the app asks for your name, email, phone, account name and IBAN. They go at the top
of the invoice and in its payment box. They're saved in the browser storage of the Home Screen app, so
they never reach Google or GitHub, and they're sent with each invoice you draft. Only the name is
required; blank lines are simply left off. Change them any time under ⚙️, and note they'll need
re-entering if you delete the app or move to a new phone.

## Clients

Clients and the email wording are the `CONFIG` block at the top of
[`apps-script/Code.gs`](apps-script/Code.gs). Change it there and run `npm run deploy:script`. The app
picks up new clients the next time it loads.

```js
clients: [
  { id: 'john', name: 'John McGlynn', email: 'angel@anuna.ie', defaultFee: 125, method: 'body' },
  { id: 'ardu', name: 'Ardú', email: 'ardumusic@gmail.com', defaultFee: null, method: 'pdf' },
],
```

- `defaultFee` prefills the fee, or `null` for none.
- `method` is what the client normally gets: `'body'` for the invoice in the email, `'pdf'` to attach it.
  The app starts there and lets you switch per invoice.
- Anyone else is a one-off: pick **Someone else…** in the app and type a name and email.

## Setup

### 1. Apps Script (about 10 minutes, on a laptop)

1. Create a script at [script.new](https://script.new) and name it **Gig Invoices**.
2. Paste in [`apps-script/Code.gs`](apps-script/Code.gs), edit the `clients` in `CONFIG`, and save.
3. Click ⚙️ **Project Settings** and set **Time zone** to *(GMT+01:00) Dublin*, so invoice dates are right.
4. Pick **`setup`** in the function dropdown and click **Run**. Google asks for permission to use Gmail.
   Because this is your own script rather than a published app, it says *"Google hasn't verified this
   app"*: click **Advanced → Go to Gig Invoices (unsafe) → Allow**.
5. The **Execution log** shows your **API key**. Copy it. (Run `showApiKey` any time to see it again.)
6. **Deploy → New deployment**, click ⚙️ next to *Select type* and choose **Web app**:
   - **Execute as:** Me
   - **Who has access:** Anyone

   **Deploy**, then copy the **Web app URL** (it ends in `/exec`).

   *Why "Anyone"?* The phone app can't sign in to Google itself, so the web app has to accept requests
   without a Google login. The API key is what keeps other people out. Treat it like a password.

### 2. Put the phone app online

The files in `web/` are static and contain no secrets. This repo publishes them to GitHub Pages: set
**Settings → Pages → Source** to **GitHub Actions**, and every push to `main` republishes
`https://<your-username>.github.io/<repo-name>/`.

### 3. Install it on your iPhone

1. Open that URL in **Safari**, then **Share → Add to Home Screen**.
2. Open **Invoices** from the Home Screen, tap ⚙️, paste the **web app URL** and **API key**, tap
   **Connect**, then fill in your own details and tap **Save my details**. (Do this inside the Home
   Screen app: it keeps its own storage, separate from Safari.)
3. Draft one invoice to yourself and check it looks right in Gmail.

## Using it

- The date defaults to today, and venues you've used before are suggested. Both are only on your phone.
- **＋ Add gig** puts several gigs on one invoice. It's then dated today and lists each gig's own date.
- **Preview** shows exactly what the client will see.
- The subject line is `Invoice for performance at {venues} {gigDates}`, for example
  *Invoice for performance at St Patrick's Cathedral 2026-08-26*.

## Changing the Apps Script

```sh
npm run deploy:script -- "what changed"
```

Runs the tests, pushes `apps-script/` to Google with [clasp](https://github.com/google/clasp), and moves
the live web app to the new version, keeping its URL.

One-time setup on a new machine:

1. Turn on **Google Apps Script API** at <https://script.google.com/home/usersettings>.
2. `npm install`, then `npx clasp login`.
3. Create `.clasp.json` (git-ignored) with the script ID from ⚙️ **Project Settings**:

   ```json
   { "scriptId": "YOUR_SCRIPT_ID", "rootDir": "apps-script" }
   ```

Deploying replaces the script in the editor, so make changes here rather than there. If the API key
ever gets out (a lost phone, say), run `resetApiKey` in the editor and enter the new key in the app.

## Working on it locally

Needs Node 20 or later. `npm install` is only needed for deploying with clasp.

```sh
npm test      # runs Code.gs against an in-memory fake of Gmail
npm run dev   # the app on http://localhost:8787
```

In the local app's Settings use URL `http://localhost:8787/exec` and key `dev`. Drafts the fake backend
made are listed at `/fake-gmail`, and the newest one renders at `/fake-gmail/last`.

## Files

| Path | What it is |
| --- | --- |
| `apps-script/Code.gs` | Clients and wording, the invoice renderer and the Gmail draft |
| `apps-script/appsscript.json` | Apps Script project settings (time zone, web app access) |
| `web/` | The phone app: `index.html`, `app.js`, `styles.css`, manifest, service worker, icons |
| `dev/` | Fake Gmail, the tests, the dev server and the deploy script |

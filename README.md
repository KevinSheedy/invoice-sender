# Gig Invoices

A small iPhone app for logging gigs and emailing invoices from your own Gmail.

- **Phone app** (`web/`): a web app you add to your Home Screen. Log a gig, pick which gigs go on an
  invoice, preview it, and create it.
- **Google side** (`apps-script/Code.gs`): a Google Apps Script attached to a Google Sheet. It stores
  clients, gigs and invoices in the Sheet, saves each invoice as a PDF in a Drive folder, and puts the
  email (with the PDF attached) in your **Gmail Drafts**, ready for you to check and send from the
  Gmail app. It can send directly instead, if you switch that on in Settings.

Nothing else is involved: no server, no database, no monthly cost.

```
iPhone app  ──(web app URL + API key)──►  Apps Script  ──►  Google Sheet (clients, gigs, invoices)
                                                       ├─►  Drive folder "Gig Invoices" (PDFs)
                                                       └─►  Gmail draft with PDF attached
```

## Setup

### 1. Google Sheet and Apps Script (about 10 minutes, on a laptop)

1. Go to [sheets.new](https://sheets.new) and name the new sheet **Gig Invoices**.
2. In the sheet, choose **Extensions → Apps Script**.
3. Replace everything in `Code.gs` with the contents of [`apps-script/Code.gs`](apps-script/Code.gs), then save.
4. Click the ⚙️ **Project Settings** icon and set **Time zone** to *(GMT+01:00) Dublin* (or your own), so
   invoice dates are right.
5. Back in the editor, pick **`setup`** in the function dropdown and click **Run**.
   Google asks for permission to use Sheets, Drive and Gmail. Because this is your own script rather
   than a published app, it shows *"Google hasn't verified this app"*: click **Advanced → Go to
   Gig Invoices (unsafe) → Allow**.
6. The **Execution log** shows your **API key**. Copy it. (Run `showApiKey` any time to see it again.)
7. Click **Deploy → New deployment**, click ⚙️ next to *Select type* and choose **Web app**:
   - **Execute as:** Me
   - **Who has access:** Anyone

   Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

   *Why "Anyone"?* The phone app can't sign in to Google itself, so the web app has to accept requests
   without a Google login. The API key is what keeps other people out. Treat it like a password.

The setup adds four tabs to the sheet: **Clients**, **Gigs**, **Invoices** and **Settings**. You can
look at and edit them directly, but don't rename the tabs or the header row.

### 2. Put the phone app online

The app is just the static files in `web/`, and they contain no secrets. Any static host works; this
repo is set up for GitHub Pages:

1. Push this folder to a new GitHub repository (it can be private if you have a paid plan; otherwise
   public is fine, since there's nothing secret in it).
2. In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The *Deploy app to GitHub Pages* workflow publishes `web/` to
   `https://<your-username>.github.io/<repo-name>/`.

### 3. Install it on your iPhone

1. Open the GitHub Pages URL in **Safari**, tap **Share → Add to Home Screen**.
2. Open **Invoices** from your Home Screen, go to **Settings**, paste the **web app URL** and
   **API key**, and tap **Connect**. (Do this inside the Home Screen app: it keeps its own storage,
   separate from Safari.) Notes or AirDrop are handy for getting the URL and key onto your phone.
3. Fill in your details, bank details and email wording further down Settings, and tap **Save settings**.

### 4. Try it once on yourself

Add yourself as a client, log a test gig and create an invoice. Then check:

- Gmail → **Drafts** has the email with the PDF attached.
- Google Drive → **Gig Invoices** folder has the PDF, and it looks right.

Then delete the test rows from the sheet, and in the app's Settings set **Next number** back to 1.

## Using it

- **Log a gig**: client, date (defaults to today), venue (remembers past venues) and fee (defaults to
  what you charged that client last time). Handy in the dressing room; invoice later.
- **New invoice**: pick the client, tick the gigs to include, **Preview**, then **Create Gmail draft**.
  The invoice page then has an **Open Gmail to send it** button.
- **Status**: *Draft in Gmail* → *Awaiting payment* (the app spots the email in your Sent folder
  automatically; you can also tap **I've sent it**) → *Overdue* after the due date → **Mark as paid**.
- **Invoice numbers**: `{YYYY}-{NNN}` gives 2026-001, 2026-002… restarting each January. To carry on
  from invoices you've already sent, change the format and **Next number** in Settings.

## Changing the Apps Script later

After editing `Code.gs` in the Apps Script editor, go to **Deploy → Manage deployments**, click ✏️ on
the web app, set **Version** to **New version** and click **Deploy**. The URL stays the same. (Just
saving the file isn't enough: the web app keeps running the old version until you do this.)

If the API key ever gets out (a lost phone, say), run `resetApiKey` and enter the new key in the app.

## Working on it locally

Needs Node 20 or later; no packages to install.

```sh
npm test      # backend tests, running Code.gs against in-memory fakes of Sheets, Drive and Gmail
npm run dev   # the app on http://localhost:8787 with sample data
```

In the local app's Settings, use URL `http://localhost:8787/exec` and key `dev`. Emails the fake
backend "sent" are listed at `/fake-gmail`.

## Files

| Path | What it is |
| --- | --- |
| `apps-script/Code.gs` | Everything on the Google side: storage, invoice numbering, PDF, Gmail |
| `apps-script/appsscript.json` | Apps Script project settings (time zone, web app access), for use with `clasp` |
| `web/` | The phone app: `index.html`, `app.js`, `styles.css`, manifest, service worker, icons |
| `dev/` | Local fakes of the Google services, backend tests and the dev server |

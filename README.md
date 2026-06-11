# EDM Builder (v0.1)

A browser-based tool to convert an EDM design image into an Outlook-safe HTML email with clickable regions.

**No install. No build step. No server.** Just open `index.html` in any modern browser (Chrome, Edge, Firefox).

---

## What it does

1. You upload a finished EDM mockup (PNG/JPG) — the same kind your vendor delivers as a flat image.
2. You draw rectangles on top of it to mark **clickable regions** (each video tile, each CTA, each session card).
3. For each rectangle you paste the destination URL (e.g. the YouTube link, the landing page).
4. The tool exports a `.zip` containing:
   - `index.html` — the email HTML, built as a nested `<table>` with inlined CSS (works in Gmail, Outlook, Apple Mail, Mailchimp, AWS SES).
   - `images/` — every rectangle sliced out as a separate JPG, named `slice_01.jpg`, `slice_02.jpg`, etc.
   - `README.txt` — deployment instructions.

This matches the standard "sliced EDM" pattern that design vendors use — but you control it end-to-end.

---

## How to use

### 1. Open the tool
Double-click `index.html`. It opens in your default browser.

### 2. Upload your EDM image
Either drag and drop a PNG/JPG onto the page, or click **Upload image**.

For best results: width ≤ 640px. If your design is wider (say 800px), most email clients will still display it but Outlook may clip the right edge.

### 3. Draw slices
Click and drag on the image to draw rectangles. Each rectangle is a "slice" — the area that will become one clickable region.

**Typical slicing strategy (matches what Amazon Smbhav 2023 vendor did):**
- One slice for the header logo + illustration
- One slice for the hero image
- **One slice per video tile** (whole tile, not per face — click anywhere on the tile opens YouTube)
- One slice for each CTA button
- One large slice for decorative collages

### 4. Attach URLs
For each slice, paste the link in the URL field. Slices with no URL will display but won't be clickable. Acceptable for decorative regions.

### 5. Preview
Click **Preview** to see how it'll render. Three tabs simulate Gmail, Outlook, and Apple Mail (cosmetic — for true rendering accuracy use [Litmus](https://www.litmus.com/) or send a real test).

### 6. Export
Click **Export HTML + Images (.zip)**. A zip downloads.

### 7. Deploy (the part most people miss)
Email clients won't load images from your local computer. You must:

1. Upload the `images/` folder to a public CDN (S3, CloudFront, Cloudflare R2, or your existing web host).
2. Open `index.html` in a text editor and replace every `images/` with your CDN base URL.
3. Paste the modified HTML into Mailchimp / SES / Outlook to send.

The `README.txt` inside the exported zip walks through this step-by-step.

---

## What the tool produces (technical)

```html
<!-- Example structure -->
<table align="center" cellpadding="0" cellspacing="0" border="0" width="640">
  <tr>
    <td style="padding:0;font-size:0;line-height:0;">
      <a href="https://campaign.example.com/header" target="_blank" style="display:block;">
        <img src="images/slice_01.jpg" width="640" height="320" border="0"
             style="display:block;border:0;outline:none;text-decoration:none;">
      </a>
    </td>
  </tr>
  ...
</table>
```

- All CSS **inlined** (Gmail strips `<style>` blocks in some contexts).
- `cellpadding="0"`, `cellspacing="0"`, `border="0"` — Outlook quirks fix.
- `display:block` on every `<img>` — prevents Gmail's default 4px gap below images.
- `font-size:0; line-height:0` on `<td>` — prevents 1px gaps between sliced images.
- `target="_blank"` on every link — opens in browser, not in mail client.

---

## Known limits (v0.1)

This is the slice-based engine. It's deliberately simple. The next version will add:

- **AI vision** to auto-detect text blocks and buttons in your image and propose slices.
- **Real text in `<td>` cells** for paragraphs (so body copy is selectable and accessible).
- **Direct send integration** with Mailchimp, SES, Outlook Graph API (no manual CDN upload needed).
- **Litmus-grade preview** via paid Email-on-Acid API.
- **PSD ingest** — read Photoshop slice metadata directly.

For now this version handles 80% of what your vendor does: turn a flat design into a clickable email.

---

## Tech notes

- Single-page browser app. Files: `index.html`, `app.js`, `exporter.js`, `styles.css`.
- One external dependency: [JSZip](https://stuk.github.io/jszip/) loaded from CDN.
- Image slicing uses the HTML5 Canvas API (`drawImage` + `toBlob`).
- HTML generation uses a hardcoded nested-table template — no MJML yet (will be added in v0.2 when we need real text + buttons + responsive behavior).

---

## Roadmap

- **v0.2** — MJML-based output, real-text slices, button slices, responsive breakpoints.
- **v0.3** — Vision API integration (Claude / GPT-4 / Gemini) to auto-detect slice regions.
- **v0.4** — Direct Mailchimp + SES send. Audit log.
- **v0.5** — Multi-user with approval workflow.

# Sample EDM — `sample-edm.html`

A complete, ready-to-customize event-recap EDM. Open `sample-edm.html` in any browser to see it render.

## What it demonstrates

This sample mimics the Amazon Smbhav 2023 structure but built the *right* way:

| Pattern | Where in the file | Why |
|---|---|---|
| Sliced header image (clickable) | First `<tr>` | Brand consistency — illustration/logo too complex for HTML |
| Real HTML headline text (`<h1>`) | Hero section | Mobile-clear, accessible, searchable |
| Hero image with YouTube link | After headline | Single click → playlist |
| Real text body paragraphs | Body `<td>` | Not blurry on mobile, screen-reader friendly, indexable |
| 3 video-tile sliced images, each linking to one video | "Key sessions" rows | The vendor pattern: one slice = one click = one video |
| Bulletproof CTA button | After tiles | Uses VML for Outlook + table fallback for everything else |
| Decorative collage image (no link) | Below CTA | Pure visual content |
| Reach banner as real HTML (no image needed) | Orange pill | Demonstrates when *not* to use an image |
| 4-column team grid with circular photos | Team section | Nested table — collapses to single column on mobile |
| Dark footer with compliance links | Last `<tr>` | Unsubscribe + View in browser tokens for Mailchimp |

## Width

640px. The Smbhav vendor used 850px which is why their email clips in Outlook. Stay at 640px or below.

## How to customize for a real campaign

1. **Open `sample-edm.html` in VS Code** (or Notepad, any text editor).
2. **Replace placeholder images.** Search for `picsum.photos` — every match is a placeholder. Replace each URL with your real image's CDN URL (e.g., `https://res.cloudinary.com/yourname/image/upload/v123/header.jpg`).
3. **Replace placeholder links.** Search for `example.com` and `YOUR_VIDEO_ID` / `YOUR_PLAYLIST_ID`. Each is one link to swap.
4. **Edit the text.** All headlines, paragraphs, button labels, footer text are real HTML — edit them inline.
5. **Save the file.**

## How to test it

- **In a browser**: double-click `sample-edm.html` → renders locally with picsum.photos placeholders.
- **In Outlook**: open Outlook → New Email → switch to source view (or use `Insert > Attach File > As Text`) and paste the HTML. Or use the EDM Builder tool to wrap it in a `.eml`.
- **In Gmail**: paste the HTML into Mailchimp's "Code your own" editor → preview.
- **Cross-client**: use [Litmus](https://www.litmus.com/) or [Email on Acid](https://www.emailonacid.com/) for paid pixel-accurate previews.

## How to send it

See the main README in the parent folder. Quick version:

- **1–10 recipients**: use the EDM Builder tool to wrap it as a `.eml`, open in Outlook, Forward → send.
- **100+ recipients**: upload images to Cloudinary/S3, swap URLs, paste HTML into Mailchimp → send to list.

## Why the unsubscribe + view-in-browser tokens?

`{{UnsubscribeURL}}` and `{{ViewInBrowser}}` are **Mailchimp merge tags** — Mailchimp auto-replaces them with real per-recipient URLs when sending. For AWS SES use SES's own placeholders. For one-off Outlook sends, either delete those lines or replace with a real URL.

## Files in this folder

- `sample-edm.html` — the email template
- `README.md` — this file

## Recommended next step

Open `sample-edm.html` in your browser, look at how each section is structured, then start swapping placeholder content for your next real campaign. Once it looks right, paste into Mailchimp and send.

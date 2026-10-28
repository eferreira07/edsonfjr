# Quick Actions landing page

Standalone landing page for Quick Actions. Open `index.html` locally for a preview, or deploy the folder as a Cloudflare Worker with the included `wrangler.jsonc`.

- `Quick_Actions_Promo_Final_1080p.mp4`: the promotional video in the How it works section. The page attempts to play it with sound when scrolled into view; browsers may require a tap before audible playback.
- `assets/sprite-mark.png`: the Quick Actions mark used in the animated product preview and page branding.
- The beta form POSTs to `/api/beta-request`; the Worker sends the request via Resend and does not expose the recipient address in the page.

## Configure email and deploy

Create a Resend API key and use a sender address verified in your Resend account. From this directory, run:

```sh
npx wrangler login
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put BETA_TO
npx wrangler secret put BETA_FROM
npx wrangler deploy
```

Enter the API key, recipient inbox, and verified sender address when prompted. Keep these values as Worker secrets; do not add them to the HTML or commit them. The beta form cannot send from a local `file://` preview.

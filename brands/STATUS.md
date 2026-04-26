# Brand asset acquisition status

Audited 2026-04-23. Each vendor's current state for landing official brand assets in `brands/<vendor>/`.

## Quick reference — outreach contacts

| Vendor | Contact / URL | Auth required? |
|---|---|---|
| Fitbit | https://dev.fitbit.com/legal/brand-assets/ → download `FitbitLogosAndGuidelines.zip` | None — public download |
| WHOOP | developers@whoop.com (or via Developer Dashboard) | Yes — request kit via partner channel |
| Withings | developer.withings.com (no formal portal section found) | Likely email developers@withings.com |
| Polar | Brand resources page currently 404 — https://www.polar.com/en/about_polar/brand_resources | Polar AccessLink agreement requires written consent |
| Oura | cloud.ouraring.com/v2 (developer console → branding) | Login required (developer account) |
| Ultrahuman | support@ultrahuman.com — bundled with partner OAuth credentials request | Partner email reply pending |
| Apple Health | N/A — see brands/apple-health/LICENSE.md | Locked to generic glyph by policy |

## Per-vendor workflow

### Fitbit — easiest, public ZIP
```
curl -O https://dev.fitbit.com/static/FitbitLogosAndGuidelines.zip
unzip FitbitLogosAndGuidelines.zip -d /tmp/fitbit-brand
# Inspect the PDF for usage rules ("Works With Fitbit" badge is permitted
# for showing connected services — fits our use case)
# Pick the SVG that maps to "Connect with Fitbit"; copy to:
cp /tmp/fitbit-brand/<chosen-button>.svg brands/fitbit/sign-in-light.svg
cp /tmp/fitbit-brand/<chosen-button-dark>.svg brands/fitbit/sign-in-dark.svg
# Then in js/brand-assets.js: flip fitbit to mode: 'official' + add signInLight/signInDark paths
```

### WHOOP — requires partner outreach
```
# Email developers@whoop.com from the same account that owns the WHOOP
# OAuth client. Request: "Sign in with WHOOP button asset pack — light + dark
# variants — for OAuth integration via the WHOOP Developer Platform."
# When their kit lands, drop into brands/whoop/ and flip the registry.
```

### Withings — informal, fetch carefully
```
# No formal partner branding portal located. Email developers@withings.com
# asking for the official branding pack for Connect-with-Withings buttons.
# DO NOT hotlink developer.withings.com/img/logo_withings.svg — that's
# their dev-site header logo, not a partner-distribution asset.
```

### Polar — brand portal currently down
```
# Their brand-resources page (polar.com/en/about_polar/brand_resources) returns
# 404 as of 2026-04-23. Try again later, or reach out via the AccessLink
# support channel with our app/integration ID.
```

### Oura — login-walled
```
# 1. Sign in to https://cloud.ouraring.com/v2 with the Oura developer account
#    that owns our OAuth client.
# 2. Navigate to Branding (or Resources) section in the developer console.
# 3. Download the Oura logo + "Connect with Oura" button assets if available.
#    Note: Oura's brand guideline is monochrome — typically only black/white
#    variants are provided.
```

### Ultrahuman — bundled with partner credentials reply
Already pending per project memory. When the credentials reply lands, ask
the same email for the official branding pack.

## Render policy reminder

`js/brand-assets.js` registry has 3 modes per vendor:
- `mode: 'fallback'` — generic accent pill, monochrome glyph
- `mode: 'branded'` (current state for 6/7) — vendor's brand colour pill, monochrome glyph
- `mode: 'official'` — vendor's "Sign in with X" graphic dropped in, rendered unmodified

To upgrade a vendor from `branded` to `official`:
1. Drop `sign-in-light.svg` + `sign-in-dark.svg` into `brands/<vendor>/`
2. In the registry: change `mode: 'branded'` to `mode: 'official'`, add `signInLight` + `signInDark` paths
3. The render code picks them up — no other changes needed

# Brand files

Google's and Microsoft's own logo and sign-in button files. Their brand
guidelines allow them only whole and unaltered, so these are byte-for-byte
copies and the apps draw them as images. Never edit one: when the owner
publishes a newer logo, replace the file with the owner's.

The mobile app's copies are in `apps/mobile/assets/brands/` (PNG, since
React Native draws PNG exactly) and `apps/mobile/src/ui/brandMarkup.ts`
(the files Microsoft publishes as SVG only).

Fetched 2026-11-11.

## Google

| File | From |
| --- | --- |
| `gmail.svg`, `googlecalendar.svg`, `googledrive.svg`, `googledocs.svg`, `googlesheets.svg`, `googleslides.svg`, `googletasks.svg` | `https://www.gstatic.com/images/branding/productlogos/<name>_2026/v1/192px.svg`, the logos Google introduced in May 2026. Mobile: `.../<name>_2026/v2/web-64dp/logo_<name>_2026_color_2x_web_64dp.png`, the file Google's Drive branding page links. |
| `google.svg` | `https://www.gstatic.com/images/branding/productlogos/googleg_gradient/v1/192px.svg`. Mobile: `.../googleg_gradient/1x/googleg_gradient_standard_128dp.png`. |
| `signin-google-light.svg`, `signin-google-dark.svg` | Google's pre-approved sign-in buttons, `signin-assets.zip` from <https://developers.google.com/identity/branding-guidelines>: pill, with text, Android and web. Mobile uses the PNGs of the same bundle, the iOS drawing on iOS. |

Rules these follow:

- Drive: <https://developers.google.com/workspace/drive/api/guides/branding>.
  The logo needs no pre-approval; it may be resized and nothing else, and
  the product is always named in full, "Google Drive".
- Other product icons: <https://about.google/brand-resource-center/brand-elements/#product-icons>.
  Use the latest version, never modified, with Hexbot's own brand more
  prominent. Google asks for permission through its Partner Marketing Hub
  before a product icon is used; see `docs/release.md`, "Brand permissions".
- Sign-in: <https://developers.google.com/identity/branding-guidelines>. The
  button keeps its "G", words, colours and shape.

## Microsoft

| File | From |
| --- | --- |
| `microsoftoutlook.svg`, `microsoftonedrive.svg`, `microsoftword.svg`, `microsoftexcel.svg`, `microsoftpowerpoint.svg`, `microsofttodo.svg` | `https://res.cdn.office.net/files/fabric-cdn-prod_20261014.001/assets/brand-icons/product/svg/<name>_48x1.svg`, the CDN version Fluent UI names (`FLUENT_CDN_BASE_URL`), with the icons Microsoft introduced in October 2025. Mobile: `.../product/png/<name>_48x3.png`; To Do is published as SVG only. |
| `microsoft.svg`, `signin-microsoft-light.svg`, `signin-microsoft-dark.svg` | The Microsoft logo and "Sign in with Microsoft" buttons from <https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-branding-in-apps>. |

Rules these follow:

- The app icons are licensed by the Microsoft Fabric Assets License
  Agreement (<https://aka.ms/fluentui-assets-license>) to an application
  that uses a Microsoft API, to show that it works with Microsoft's
  products: the full-colour icon on a background with enough contrast, the
  product's full name beside it, the newest icon, never as Hexbot's own
  logo and never more prominent than Hexbot's name.
- Microsoft 365 trademark guidelines: don't alter, distort or crop an icon;
  keep clear space around it; no smaller than 16 px; its label in black,
  grey or white, not the product's colour.
- Sign-in: the Microsoft logo with the words "Sign in with Microsoft", in
  the light or the dark version, unaltered.

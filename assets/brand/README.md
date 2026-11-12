# VideoQ brand assets

The Q-shaped speech bubble and play symbol connect video, questions, and learning.
The app icon uses a white mark on blue, aligned with the site's Digital Agency
blue-800 theme token (#0031d8). The editable SVG uses exact solid blue and white;
raster edge pixels are antialiased. The Q silhouette, play symbol, and clear space
are retained. Social cards retain their existing artwork.

- `icon.svg`: editable vector master with explicit theme colors.
- `icon-master.png`: 1254px PNG export of the vector master.
- `icon-original.png`: previous textured blue artwork retained for comparison.
- `github-organization.png`: 1024px square PNG for the `videoq-jp` Organization avatar.
- `social-master.png`: original sharing card artwork, including Japanese typography.

The web public directory contains 512px and 192px app icons, the 180px Apple touch
icon, a multi-size 16/32/48px ICO, and the 1200×630px social card. All icon sizes
are rendered from the same SVG master. Corners are applied by the UI/platform.
The Q symbol stays inside the central region for circular/maskable crops.
`og-image-v2.png` uses a new URL so sharing crawlers can fetch the refreshed image;
`og-image.png` also contains the new card for existing consumers.

To update the GitHub Organization avatar, upload `github-organization.png` at
https://github.com/organizations/videoq-jp/settings/profile under Profile picture.
The connected GitHub API does not offer an avatar upload operation.

Regenerate the web, docs, demo, and GitHub avatar exports with
`node scripts/brand/export-icons.mjs` after `npm ci` (uses the locked Sharp dependency). The GitHub avatar file
is prepared locally; uploading it is a separate operation.

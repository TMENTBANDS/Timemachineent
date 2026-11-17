# timemachineent.com

Time Machine Entertainment website, hosted on Netlify.

- `public/` is the website. Netlify publishes this folder.
- `public/songbook.html` holds the Live Band Karaoke song list (`var DATA = [...]`).
- `src/signup.template.html` is the Live Band Karaoke sign-up page. On each deploy, `scripts/build-signup.mjs` fills it with the songbook's song list and writes `public/signup.html` (live at /signup).
- `netlify/functions/lbk.mjs` is the sign-up's server piece: guest sign-ups, host logins (personal PINs) and the nightly line, stored in Netlify Blobs.
- `public/portal/` is the wedding client portal (live at /portal). Couples log in with last name + PIN to see their event, balance, Square pay link, documents, song requests and wedding worksheet. `public/portal/songs.json` is the song-request list: [artist, song, genre code, decade].
- `netlify/functions/portal.mjs` is the portal's server piece. It reads and writes the couple's Zoho CRM Deal (needs ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_API_URL and PORTAL_SECRET set in Netlify).

# timemachineent.com

Time Machine Entertainment website, hosted on Netlify.

- `public/` is the website. Netlify publishes this folder.
- `public/songbook.html` holds the Live Band Karaoke song list (`var DATA = [...]`).
- `src/signup.template.html` is the Live Band Karaoke sign-up page. On each deploy, `scripts/build-signup.mjs` fills it with the songbook's song list and writes `public/signup.html` (live at /signup).
- `netlify/functions/lbk.mjs` is the sign-up's server piece: guest sign-ups, host logins (personal PINs) and the nightly line, stored in Netlify Blobs.

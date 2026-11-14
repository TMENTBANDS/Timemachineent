// Builds the karaoke sign-up pages from their templates, using the song list in public/songbook.html:
//   src/signup.template.html    -> public/signup.html    (Wednesday Sidecar sign-up, /signup)
//   src/corporate.template.html -> public/corporate.html (corporate events, /corporate)
// Runs on every Netlify deploy, so updating the songbook page updates both sign-up pages too.
import { readFileSync, writeFileSync } from "node:fs";
const songbook = readFileSync("public/songbook.html", "utf8");
const m = songbook.match(/var DATA = (\[[\s\S]*?\]);/);
if (!m) throw new Error("Couldn't find the song list (var DATA = [...]) in public/songbook.html");
const songs = JSON.parse(m[1]);
for (const [src, out] of [["src/signup.template.html", "public/signup.html"], ["src/corporate.template.html", "public/corporate.html"]]) {
  const page = readFileSync(src, "utf8").replace("__SONGS__", () => JSON.stringify(songs));
  writeFileSync(out, page);
  console.log(`${out} built with ${songs.length} songs`);
}

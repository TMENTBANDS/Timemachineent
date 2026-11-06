// Builds public/signup.html from src/signup.template.html, using the song list in public/songbook.html.
// Runs on every Netlify deploy, so updating the songbook page updates the sign-up page too.
import { readFileSync, writeFileSync } from "node:fs";
const songbook = readFileSync("public/songbook.html", "utf8");
const m = songbook.match(/var DATA = (\[[\s\S]*?\]);/);
if (!m) throw new Error("Couldn't find the song list (var DATA = [...]) in public/songbook.html");
const songs = JSON.parse(m[1]);
const page = readFileSync("src/signup.template.html", "utf8").replace("__SONGS__", JSON.stringify(songs));
writeFileSync("public/signup.html", page);
console.log(`signup.html built with ${songs.length} songs`);

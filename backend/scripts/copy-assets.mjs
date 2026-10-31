// Copy non-TS runtime assets next to the compiled JS (fixtures and the default policy).
import fs from "node:fs";
for (const dir of ["fixtures", "policy"]) {
  fs.cpSync(new URL(`../src/${dir}`, import.meta.url), new URL(`../dist/${dir}`, import.meta.url), {
    recursive: true,
    filter: (src) => !src.endsWith(".ts"),
  });
}
console.log("copied fixtures and policy to dist/");

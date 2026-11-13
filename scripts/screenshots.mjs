// Reproducible README screenshots. Run: npm run dev (port 5173) then node scripts/screenshots.mjs
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const base = process.env.BASE || "http://localhost:5173/";
const out = process.env.OUT || "docs";
const browser = await chromium.launch();
const errors = [];
async function shot(name, url, opts = {}, wait = 0, fn) {
  const ctx = await browser.newContext(opts.device ? { ...devices[opts.device] } : { viewport: opts.viewport || { width: 1360, height: 860 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(wait);
  if (fn) await fn(page);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: !!opts.full });
  await ctx.close();
}
await shot("overview", "", {}, 500);
await shot("booking", "?open&script=booking", {}, 6500);
await shot("faq-answers", "?open&script=faq", {}, 3000);
await shot("owner-inbox", "?script=booking", {}, 6500, async (p) => {
  await p.evaluate(() => document.querySelector(".cw").classList.remove("cw-open"));
  await p.locator("#owner").scrollIntoViewIfNeeded();
  await p.evaluate(() => scrollBy(0, -40));
  await p.waitForTimeout(300);
});
await shot("mobile-handoff", "?open&script=handoff", { device: "iPhone 13" }, 4000);
await shot("mobile-home", "", { device: "iPhone 13", full: true }, 500);
await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("no console errors");

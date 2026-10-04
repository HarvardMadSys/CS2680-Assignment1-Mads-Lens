/**
 * Screenshot one element, scrolled into view.
 *   node tools/clip.mjs <css-selector> <out.png> [scale]
 */
import { writeFileSync } from "node:fs";
import { attach } from "./cdp.mjs";

const [, , selector, out, scale = "3"] = process.argv;
const { send, close } = await attach();

const box = await send("Runtime.evaluate", {
  returnByValue: true,
  expression: `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`,
});

const clip = box.result?.result?.value;
if (!clip) {
  console.error("selector not found:", selector);
  process.exit(1);
}

const shot = await send("Page.captureScreenshot", {
  format: "png",
  clip: { ...clip, scale: Number(scale) },
});
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log(`wrote ${out} (${Math.round(clip.width)}x${Math.round(clip.height)} @${scale}x)`);
close();

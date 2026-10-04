/**
 * Drive the page and screenshot it.
 *   node tools/shoot.mjs <url> <out.png> [width] [height] [prompt]
 *   WAIT=9000 node tools/shoot.mjs ...   how long to let the run stream
 */
import { writeFileSync } from "node:fs";
import { attach, submitPrompt, wait } from "./cdp.mjs";

const [, , url, out, w = "1500", h = "980", prompt = ""] = process.argv;
const { send, close } = await attach();

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: Number(w), height: Number(h), deviceScaleFactor: 2, mobile: false,
});
await send("Page.navigate", { url });
await wait(2500);

if (prompt) {
  const r = await send("Runtime.evaluate", {
    returnByValue: true,
    expression: submitPrompt(prompt),
  });
  console.log("submit:", r.result?.result?.value);
  await wait(Number(process.env.WAIT ?? 18000));
}

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("wrote", out);
close();

import { cp, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export async function buildGooglePages() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  // A fixed, ignored staging directory; never copy the checkout or private data.
  const destination = path.join(root, ".cache/google-pages");
  await mkdir(destination, { recursive: true });
  const files = [
    "index.html",
    "style.css",
    "app.js",
    "model.js",
    "transport.js",
    "features.js",
    "manifest.webmanifest",
    "sw.js",
  ];
  const icons = [
    "icon.svg",
    "ui.svg",
    "icon-192.png",
    "icon-512.png",
    "maskable-512.png",
    "apple-touch-icon.png",
  ];
  // Fail instead of publishing stale or unexpectedly added files from staging.
  for (const entry of await readdir(destination)) {
    if (![...files, "icons"].includes(entry))
      throw Error(`Unexpected staged file: ${entry}`);
  }
  const iconDestination = path.join(destination, "icons");
  await mkdir(iconDestination, { recursive: true });
  for (const entry of await readdir(iconDestination)) {
    if (!icons.includes(entry)) throw Error(`Unexpected staged icon: ${entry}`);
  }
  for (const name of files)
    await cp(path.join(root, "google-pwa", name), path.join(destination, name));
  for (const name of icons)
    await cp(
      path.join(root, "public/icons", name),
      path.join(iconDestination, name),
    );
  return destination;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(`Static Google-mode PWA prepared at ${await buildGooglePages()}`);
}

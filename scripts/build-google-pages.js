import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const SERVICE_WORKER_MARKER = 'const BUILD_REVISION = "development";';

export function serviceWorkerSource(template, assets) {
  if (template.split(SERVICE_WORKER_MARKER).length !== 2)
    throw Error(
      "The service worker must have exactly one build revision marker",
    );
  const hash = createHash("sha256");
  // Names delimit each ordered asset so content/path changes both invalidate the
  // shell. The caller passes only allowlisted public files, never deployment auth.
  for (const { name, contents } of [...assets].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    hash.update(name).update("\0").update(contents).update("\0");
  }
  return template.replace(
    SERVICE_WORKER_MARKER,
    `const BUILD_REVISION = "${hash.digest("hex")}";`,
  );
}

export function deploymentConfigSource(value = "") {
  if (typeof value !== "string") throw Error("Invalid VARKA_APPS_SCRIPT_URL");
  const endpoint = value.trim();
  if (
    endpoint &&
    (endpoint.length > 2048 ||
      !/^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(
        endpoint,
      ))
  )
    throw Error(
      "VARKA_APPS_SCRIPT_URL must be an Apps Script HTTPS /exec URL without credentials, query parameters, or a fragment",
    );
  // This is intentionally public configuration, never an authentication token.
  return `// Public deployment default. Existing saved connections take priority.\nexport const DEFAULT_APPS_SCRIPT_URL = ${JSON.stringify(endpoint)};\n`;
}

export async function buildGooglePages({
  destination = path.join(root, ".cache/google-pages"),
  appsScriptUrl = process.env.VARKA_APPS_SCRIPT_URL || "",
} = {}) {
  // Validate before touching a previously staged build.
  const deploymentConfig = deploymentConfigSource(appsScriptUrl);
  const serviceWorkerTemplate = await readFile(
    path.join(root, "google-pwa", "sw.js"),
    "utf8",
  );
  serviceWorkerSource(serviceWorkerTemplate, []);
  // A fixed, ignored staging directory; never copy the checkout or private data.
  await mkdir(destination, { recursive: true });
  const files = [
    "index.html",
    "legacy.html",
    "workspace.js",
    "workspace.css",
    "workspace-model.js",
    "deployment-config.js",
    "locales.js",
    "style.css",
    "app.js",
    "model.js",
    "transport.js",
    "features.js",
    "ui.js",
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
    if (name !== "deployment-config.js")
      await cp(
        path.join(root, "google-pwa", name),
        path.join(destination, name),
      );
  // Always replace this generated file, even when the environment is unset.
  // Reusing a staging directory must not retain an earlier database default.
  await writeFile(
    path.join(destination, "deployment-config.js"),
    deploymentConfig,
  );
  for (const name of icons)
    await cp(
      path.join(root, "public/icons", name),
      path.join(iconDestination, name),
    );
  const publicAssets = [];
  for (const name of [...files, ...icons.map((name) => `icons/${name}`)])
    publicAssets.push({
      name,
      contents: await readFile(path.join(destination, name)),
    });
  // sw.js is still its unrendered template at this point. Including it makes
  // cache logic changes invalidate the shell too, without a self-referential hash.
  await writeFile(
    path.join(destination, "sw.js"),
    serviceWorkerSource(serviceWorkerTemplate, publicAssets),
  );
  return destination;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(`Static Google-mode PWA prepared at ${await buildGooglePages()}`);
}

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildGooglePages,
  deploymentConfigSource,
  serviceWorkerSource,
} from "../scripts/build-google-pages.js";

const endpoint = "https://script.google.com/macros/s/RELEASE-TEST_1/exec";
const otherEndpoint = "https://script.google.com/macros/s/OTHER-TEST_2/exec";
async function temporaryStage(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "varka-google-pages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "public");
}

test("public deployment configuration accepts only canonical Apps Script /exec URLs", () => {
  assert.match(deploymentConfigSource(), /DEFAULT_APPS_SCRIPT_URL = "";/);
  assert.match(deploymentConfigSource("   "), /DEFAULT_APPS_SCRIPT_URL = "";/);
  assert.ok(
    deploymentConfigSource(endpoint).includes(JSON.stringify(endpoint)),
  );
  assert.equal(
    deploymentConfigSource(` ${endpoint} `),
    deploymentConfigSource(endpoint),
  );
  for (const value of [
    "http://script.google.com/macros/s/TEST/exec",
    "https://evil.example/macros/s/TEST/exec",
    "https://script.google.com.evil.example/macros/s/TEST/exec",
    "https://script.google.com:443/macros/s/TEST/exec",
    "https://user:private-value@script.google.com/macros/s/TEST/exec",
    `${endpoint}?token=private-value`,
    `${endpoint}?`,
    `${endpoint}#fragment`,
    `${endpoint}#`,
    `${endpoint}/extra`,
    "https://script.google.com/macros/s/TEST/dev",
    "https://script.google.com/macros/s/a%2Fb/exec",
    "javascript:alert(1)",
    '";globalThis.injected=true;//',
    "https://script.google.com/macros/s/TEST\nINJECTION/exec",
    "https://script.google.com/macros/s/" + "x".repeat(2100) + "/exec",
    null,
    false,
    42,
    {},
  ]) {
    assert.throws(
      () => deploymentConfigSource(value),
      (error) => {
        assert.match(error.message, /VARKA_APPS_SCRIPT_URL/);
        assert.equal(error.message.includes("private-value"), false);
        assert.equal(error.message.includes("INJECTION"), false);
        return true;
      },
    );
  }
});

test("Pages staging includes only the public allowlist and generated URL, not deployment credentials", async (t) => {
  const destination = await temporaryStage(t);
  const output = await buildGooglePages({
    destination,
    appsScriptUrl: endpoint,
  });
  assert.equal(output, destination);
  const files = (await readdir(destination)).sort();
  assert.deepEqual(
    files,
    [
      "app.js",
      "deployment-config.js",
      "features.js",
      "icons",
      "index.html",
      "legacy.html",
      "locales.js",
      "manifest.webmanifest",
      "model.js",
      "release",
      "style.css",
      "sw.js",
      "transport.js",
      "ui.js",
      "workspace-model.js",
      "workspace.css",
      "workspace.js",
    ].sort(),
  );
  const config = await readFile(
    path.join(destination, "deployment-config.js"),
    "utf8",
  );
  assert.equal(config, deploymentConfigSource(endpoint));
  assert.match(
    await readFile(path.join(destination, "workspace.js"), "utf8"),
    /from "\.\/deployment-config\.js"/,
  );
  assert.match(
    await readFile(path.join(destination, "sw.js"), "utf8"),
    /"\.\/deployment-config\.js"/,
  );
  const serviceWorker = await readFile(path.join(destination, "sw.js"), "utf8");
  assert.match(serviceWorker, /const BUILD_REVISION = "[a-f0-9]{64}";/);
  assert.equal(
    serviceWorker.includes('const BUILD_REVISION = "development";'),
    false,
  );
  const icons = await readdir(path.join(destination, "icons"));
  assert.ok(icons.includes("apple-touch-icon.png"));
  const releasePages = await readdir(path.join(destination, "release"));
  assert.deepEqual(releasePages.sort(), [
    "index.html",
    "privacy.html",
    "terms.html",
  ]);
  const template = await readFile(
    new URL("../google-pwa/sw.js", import.meta.url),
    "utf8",
  );
  const publicAssets = await Promise.all(
    [
      ...files.filter((name) => !["icons", "release"].includes(name)),
      ...icons.map((name) => `icons/${name}`),
      ...releasePages.map((name) => `release/${name}`),
    ].map(async (name) => ({
      name,
      contents:
        name === "sw.js"
          ? template
          : await readFile(path.join(destination, name)),
    })),
  );
  assert.equal(serviceWorker, serviceWorkerSource(template, publicAssets));
  assert.equal(
    files.some((name) => /\.env|\.git|server|apps-script|oauth/i.test(name)),
    false,
  );
});

test("every staging build regenerates its config and cannot retain an earlier database default", async (t) => {
  const destination = await temporaryStage(t);
  await buildGooglePages({ destination, appsScriptUrl: endpoint });
  const serviceWorkerPath = path.join(destination, "sw.js");
  const firstWorker = await readFile(serviceWorkerPath, "utf8");
  await buildGooglePages({ destination, appsScriptUrl: endpoint });
  assert.equal(await readFile(serviceWorkerPath, "utf8"), firstWorker);
  await buildGooglePages({ destination, appsScriptUrl: otherEndpoint });
  const otherWorker = await readFile(serviceWorkerPath, "utf8");
  assert.notEqual(otherWorker, firstWorker);
  const configPath = path.join(destination, "deployment-config.js");
  assert.equal(
    await readFile(configPath, "utf8"),
    deploymentConfigSource(otherEndpoint),
  );
  await buildGooglePages({ destination, appsScriptUrl: "" });
  const emptyWorker = await readFile(serviceWorkerPath, "utf8");
  assert.notEqual(emptyWorker, otherWorker);
  assert.notEqual(emptyWorker, firstWorker);
  await buildGooglePages({ destination, appsScriptUrl: "" });
  assert.equal(await readFile(serviceWorkerPath, "utf8"), emptyWorker);
  assert.equal(await readFile(configPath, "utf8"), deploymentConfigSource(""));
  const checkedInConfig = await readFile(
    new URL("../google-pwa/deployment-config.js", import.meta.url),
    "utf8",
  );
  assert.match(checkedInConfig, /DEFAULT_APPS_SCRIPT_URL = "";/);
});

test("the service worker revision fingerprints ordered public paths, code, icons and its own template", () => {
  const template =
    'const BUILD_REVISION = "development";\nconst CACHE = BUILD_REVISION;\n';
  const assets = [
    { name: "sw.js", contents: Buffer.from(template) },
    { name: "workspace.js", contents: Buffer.from("export const version=1;") },
    { name: "icons/icon.png", contents: Buffer.from([0, 1, 2, 255]) },
    {
      name: "deployment-config.js",
      contents: Buffer.from(deploymentConfigSource(endpoint)),
    },
  ];
  const first = serviceWorkerSource(template, assets);
  assert.equal(serviceWorkerSource(template, [...assets].reverse()), first);
  for (const changed of [
    assets.map((asset) =>
      asset.name === "workspace.js"
        ? { ...asset, contents: Buffer.from("export const version=2;") }
        : asset,
    ),
    assets.map((asset) =>
      asset.name === "icons/icon.png"
        ? { ...asset, contents: Buffer.from([0, 1, 3, 255]) }
        : asset,
    ),
    assets.map((asset) =>
      asset.name === "workspace.js"
        ? { ...asset, name: "another-module.js" }
        : asset,
    ),
    assets.map((asset) =>
      asset.name === "sw.js"
        ? {
            ...asset,
            contents: Buffer.from(`${template}// changed cache logic\n`),
          }
        : asset,
    ),
  ])
    assert.notEqual(serviceWorkerSource(template, changed), first);
  assert.throws(
    () => serviceWorkerSource("// missing marker", assets),
    /exactly one build revision marker/,
  );
  assert.throws(
    () => serviceWorkerSource(template + template, assets),
    /exactly one build revision marker/,
  );
});

test("the build reads only the public deployment variable and clears it when unset", async (t) => {
  const destination = await temporaryStage(t);
  const previous = process.env.VARKA_APPS_SCRIPT_URL;
  const previousSecret = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env.VARKA_APPS_SCRIPT_URL;
    else process.env.VARKA_APPS_SCRIPT_URL = previous;
    if (previousSecret === undefined)
      delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
    else process.env.GOOGLE_OAUTH_REFRESH_TOKEN = previousSecret;
  });
  process.env.VARKA_APPS_SCRIPT_URL = endpoint;
  process.env.GOOGLE_OAUTH_REFRESH_TOKEN =
    "fake-test-secret-not-for-public-builds";
  await buildGooglePages({ destination });
  const configPath = path.join(destination, "deployment-config.js");
  assert.equal(
    await readFile(configPath, "utf8"),
    deploymentConfigSource(endpoint),
  );
  delete process.env.VARKA_APPS_SCRIPT_URL;
  await buildGooglePages({ destination });
  const config = await readFile(configPath, "utf8");
  assert.equal(config, deploymentConfigSource(""));
  assert.equal(config.includes(process.env.GOOGLE_OAUTH_REFRESH_TOKEN), false);
});

test("invalid public configuration fails before modifying a previous staged build", async (t) => {
  const destination = await temporaryStage(t);
  await buildGooglePages({ destination, appsScriptUrl: endpoint });
  await assert.rejects(
    buildGooglePages({
      destination,
      appsScriptUrl: "https://evil.example/exec",
    }),
    /VARKA_APPS_SCRIPT_URL/,
  );
  assert.equal(
    await readFile(path.join(destination, "deployment-config.js"), "utf8"),
    deploymentConfigSource(endpoint),
  );
});

test("unexpected staging files and icons fail closed instead of being published", async (t) => {
  const destination = await temporaryStage(t);
  await buildGooglePages({ destination, appsScriptUrl: endpoint });
  await writeFile(path.join(destination, ".env"), "fake-test-fixture");
  await assert.rejects(
    buildGooglePages({ destination, appsScriptUrl: otherEndpoint }),
    /Unexpected staged file/,
  );
  assert.equal(
    await readFile(path.join(destination, "deployment-config.js"), "utf8"),
    deploymentConfigSource(endpoint),
  );
  const otherDestination = await temporaryStage(t);
  await buildGooglePages({
    destination: otherDestination,
    appsScriptUrl: endpoint,
  });
  await writeFile(
    path.join(otherDestination, "icons", "unexpected-private.txt"),
    "fake-test-fixture",
  );
  await assert.rejects(
    buildGooglePages({
      destination: otherDestination,
      appsScriptUrl: otherEndpoint,
    }),
    /Unexpected staged icon/,
  );
});

test("release information staging rejects extra files, directories, and symlinks before replacing the build", async (t) => {
  for (const unexpected of ["extra-file", "directory", "symlink"]) {
    const destination = await temporaryStage(t);
    await buildGooglePages({ destination, appsScriptUrl: endpoint });
    const release = path.join(destination, "release");
    if (unexpected === "extra-file")
      await writeFile(
        path.join(release, "desktop-client.json"),
        "fake-test-fixture",
      );
    else {
      await rm(path.join(release, "privacy.html"));
      if (unexpected === "directory")
        await mkdir(path.join(release, "privacy.html"));
      else
        await symlink(
          path.join(destination, "deployment-config.js"),
          path.join(release, "privacy.html"),
        );
    }
    await assert.rejects(
      buildGooglePages({ destination, appsScriptUrl: otherEndpoint }),
      /Unexpected staged release page/,
    );
    assert.equal(
      await readFile(path.join(destination, "deployment-config.js"), "utf8"),
      deploymentConfigSource(endpoint),
    );
  }
});

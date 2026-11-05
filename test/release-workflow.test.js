import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = (name) =>
  readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

// These are deliberate repository policy checks, not a general YAML parser.
function job(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.ok(start >= 0, `Missing job: ${name}`);
  const relativeEnd = lines
    .slice(start + 1)
    .findIndex((line) => /^  [\w-]+:$/.test(line));
  return lines
    .slice(start, relativeEnd < 0 ? undefined : start + 1 + relativeEnd)
    .join("\n");
}

function step(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.ok(start >= 0, `Missing step: ${name}`);
  const relativeEnd = lines
    .slice(start + 1)
    .findIndex((line) => line.startsWith("      - "));
  return lines
    .slice(start, relativeEnd < 0 ? undefined : start + 1 + relativeEnd)
    .join("\n");
}

test("combined releases run on main pushes with a manual fallback; frontend-only releases remain manual", async () => {
  for (const name of ["deploy-varka.yml", "google-pages.yml"]) {
    const source = await workflow(name);
    if (name === "deploy-varka.yml")
      assert.match(source, /^on:\n  push:\n    branches: \[main\]\n  workflow_dispatch:\s*$/m);
    else {
      assert.match(source, /^on:\n  workflow_dispatch:\s*$/m);
      assert.doesNotMatch(source, /^\s+push:/m);
    }
    assert.doesNotMatch(
      source,
      /^\s+(?:pull_request|pull_request_target|schedule|workflow_run):/m,
    );
    assert.match(source, /^permissions: \{\}$/m);
    assert.match(
      source,
      /concurrency:\n  group: google-pages\n  cancel-in-progress: false/,
    );
    for (const jobName of name === "deploy-varka.yml"
      ? ["verify", "release"]
      : ["verify", "deploy"]) {
      const block = job(source, jobName);
      const guard = step(block, "Require main");
      assert.match(guard, /\[ "\$GITHUB_REF" != "refs\/heads\/main" \]/);
      assert.match(guard, /::error::/);
      assert.match(guard, /exit 1/);
      assert.ok(
        block.indexOf("Require main") < block.indexOf("actions/checkout"),
      );
      assert.match(block, /ref: \$\{\{ github\.sha \}\}/);
      assert.match(block, /persist-credentials: false/);
      assert.doesNotMatch(block, /^    env:/m);
    }
  }
});

test("an old run checks the current main commit before backend or frontend publication", async () => {
  for (const [name, jobName, nextStep] of [
    ["deploy-varka.yml", "release", "Update existing Apps Script deployment"],
    ["google-pages.yml", "deploy", "Build Pages using the existing deployment ID when configured"],
  ]) {
    const block = job(await workflow(name), jobName);
    const guard = step(block, "Require current main commit");
    assert.match(guard, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(guard, /run: node scripts\/require-current-main\.js/);
    assert.doesNotMatch(guard, /GOOGLE_OAUTH_|secrets\./);
    assert.ok(block.indexOf("Require current main commit") < block.indexOf(nextStep));
  }
});

test("verification jobs have no Google secrets or deployment write permissions", async () => {
  for (const name of ["deploy-varka.yml", "google-pages.yml"]) {
    const block = job(await workflow(name), "verify");
    assert.match(block, /contents: read/);
    assert.doesNotMatch(
      block,
      /secrets\.|GOOGLE_OAUTH_|pages: write|id-token: write/,
    );
    assert.match(block, /node-version: "24"/);
    assert.match(block, /run: npm ci/);
    assert.match(block, /run: npm test/);
    assert.match(block, /run: npm run build:google/);
  }
  const combined = job(await workflow("deploy-varka.yml"), "verify");
  assert.match(
    combined,
    /run: npx --no-install playwright install --with-deps chromium/,
  );
  assert.match(combined, /run: npm run test:e2e/);
});

test("combined release gates Pages behind the verified existing Apps Script deployment", async () => {
  const source = await workflow("deploy-varka.yml");
  const block = job(source, "release");
  assert.match(block, /needs: verify/);
  assert.match(block, /environment:\n      name: github-pages/);
  assert.match(
    block,
    /permissions:\n      contents: read\n      pages: write\n      id-token: write/,
  );
  assert.ok(
    block.indexOf("node scripts/deploy-apps-script.js") <
      block.indexOf("node scripts/build-google-pages.js"),
  );
  assert.ok(
    block.indexOf("node scripts/build-google-pages.js") <
      block.indexOf("actions/deploy-pages@v4"),
  );
  assert.match(block, /path: \.cache\/google-pages/);
  assert.doesNotMatch(
    block,
    /continue-on-error|always\(\)|npm ci|npm install|npx /,
  );

  const backend = step(block, "Update existing Apps Script deployment");
  assert.match(backend, /id: apps_script/);
  for (const variable of ["APPS_SCRIPT_ID", "APPS_SCRIPT_DEPLOYMENT_ID"])
    assert.ok(backend.includes(`${variable}: \${{ vars.${variable} }}`));
  for (const credential of [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REFRESH_TOKEN",
  ]) {
    assert.ok(backend.includes(`${credential}: \${{ secrets.${credential} }}`));
    assert.equal(source.split(`secrets.${credential}`).length - 1, 1);
  }
  assert.match(backend, /NODE_USE_ENV_PROXY: "1"/);
  const frontend = step(block, "Build Pages with the verified deployment URL");
  assert.match(
    frontend,
    /VARKA_APPS_SCRIPT_URL: \$\{\{ steps\.apps_script\.outputs\.exec_url \}\}/,
  );
  assert.doesNotMatch(frontend, /secrets\.|GOOGLE_OAUTH_/);
});

test("frontend-only deployment derives its default URL from the same public deployment ID", async () => {
  const source = await workflow("google-pages.yml");
  const block = job(source, "deploy");
  assert.match(block, /needs: verify/);
  assert.match(block, /name: github-pages/);
  assert.doesNotMatch(source, /secrets\.|GOOGLE_OAUTH_|deploy-apps-script\.js/);
  const build = step(
    block,
    "Build Pages using the existing deployment ID when configured",
  );
  assert.match(build, /VARKA_APPS_SCRIPT_URL:/);
  assert.ok(
    build.includes(
      "vars.APPS_SCRIPT_DEPLOYMENT_ID && format('https://script.google.com/macros/s/{0}/exec', vars.APPS_SCRIPT_DEPLOYMENT_ID) || ''",
    ),
  );
  assert.match(build, /run: node scripts\/build-google-pages\.js/);
  assert.match(block, /path: \.cache\/google-pages/);
});

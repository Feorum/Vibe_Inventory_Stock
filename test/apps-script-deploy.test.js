import test from "node:test";
import assert from "node:assert/strict";
import {
  MANAGED_SCRIPT_FILES,
  deployAppsScript,
  mergeScriptFiles,
  validateDeploymentConfig,
  validateReleaseEnvironment,
} from "../scripts/deploy-apps-script.js";

const clone = (value) => structuredClone(value);
const env = {
  APPS_SCRIPT_ID: `SCRIPT_${"a".repeat(40)}`,
  APPS_SCRIPT_DEPLOYMENT_ID: `AKfycb${"b".repeat(55)}`,
  GOOGLE_OAUTH_CLIENT_ID: "fixture-client.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "fixture-client-secret-NEVER-LOG",
  GOOGLE_OAUTH_REFRESH_TOKEN: "fixture-refresh-token-NEVER-LOG",
  GITHUB_SHA: "a".repeat(40),
};
const privateSource = "fixture-remote-private-source-NEVER-LOG";
const accessToken = "fixture-access-token-NEVER-LOG";
const execUrl = `https://script.google.com/macros/s/${env.APPS_SCRIPT_DEPLOYMENT_ID}/exec`;
const local = Object.fromEntries(
  MANAGED_SCRIPT_FILES.map((entry) => [
    entry.file,
    entry.type === "HTML"
      ? "<!doctype html><p>new bridge</p>"
      : `function ${entry.entry}() { return 'new reviewed code'; }`,
  ]),
);

function files() {
  return [
    {
      name: "Код",
      type: "SERVER_JS",
      source: `// ${privateSource}\nfunction doGet(e) { if (e.parameter.pwa === 'bridge') return pwaPage_(e); }\nfunction webLogin() {}\nfunction webAuth_() {}\nfunction book_() {}\nfunction rows_() {}\nfunction totalState_() {}\nfunction v3Lock_() {}\nfunction v5Decode_() {}`,
      functionSet: { values: [{ name: "doGet" }] },
    },
    {
      name: "Inventory",
      type: "HTML",
      source: "<!doctype html><p>Original inventory must survive</p>",
    },
    {
      name: "Enhancements",
      type: "SERVER_JS",
      source: "function keepExistingEnhancements() {}",
    },
    {
      name: "InventorySessions",
      type: "SERVER_JS",
      source: "function keepExistingSessions() {}",
    },
    {
      name: "BatchInventory",
      type: "SERVER_JS",
      source: "function keepOriginalLedger() {}",
    },
    {
      name: "appsscript",
      type: "JSON",
      source: JSON.stringify(
        {
          timeZone: "Europe/Minsk",
          runtimeVersion: "V8",
          webapp: { access: "ANYONE_ANONYMOUS", executeAs: "USER_DEPLOYING" },
          dependencies: {
            libraries: [
              {
                libraryId: "original-library",
                userSymbol: "Original",
                version: "1",
              },
            ],
          },
        },
        null,
        2,
      ),
    },
    ...MANAGED_SCRIPT_FILES.map((entry) => ({
      name: entry.name,
      type: entry.type,
      source: `old ${entry.file}`,
    })),
  ];
}
function deployment() {
  return {
    deploymentId: env.APPS_SCRIPT_DEPLOYMENT_ID,
    deploymentConfig: {
      scriptId: env.APPS_SCRIPT_ID,
      versionNumber: 3,
      manifestFileName: "appsscript",
      description: "Existing owner deployment",
    },
    entryPoints: [
      {
        entryPointType: "WEB_APP",
        webApp: {
          url: execUrl,
          entryPointConfig: {
            access: "ANYONE_ANONYMOUS",
            executeAs: "USER_DEPLOYING",
          },
        },
      },
    ],
  };
}
const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => clone(data),
});

function google(options = {}) {
  const initial = files();
  const state = {
    head: clone(options.head || initial),
    versions: new Map([[3, clone(options.deployed || initial)]]),
    deployment: clone(options.deployment || deployment()),
    calls: [],
    headReads: 0,
    deploymentReads: 0,
  };
  const fetchImpl = async (url, init) => {
    const call = {
      url: String(url),
      method: init.method,
      headers: clone(init.headers),
      body: init.body,
      redirect: init.redirect,
      signal: init.signal,
    };
    state.calls.push(call);
    const early = await options.intercept?.(call, state);
    if (early) return early;
    if (url === "https://oauth2.googleapis.com/token")
      return response({ access_token: accessToken });
    assert.equal(init.headers.Authorization, `Bearer ${accessToken}`);
    const parsed = new URL(url);
    const base = `/v1/projects/${env.APPS_SCRIPT_ID}`;
    if (parsed.pathname === `${base}/content`) {
      if (init.method === "GET") {
        const version = parsed.searchParams.get("versionNumber");
        if (version) {
          assert.ok(
            state.versions.has(Number(version)),
            "requested immutable version must exist",
          );
          return response({ files: state.versions.get(Number(version)) });
        }
        state.headReads++;
        options.onHeadRead?.(state);
        return response({ files: state.head });
      }
      assert.equal(init.method, "PUT");
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body), ["files"]);
      state.head = clone(body.files);
      await options.afterUpload?.(state);
      return response({ files: state.head });
    }
    if (parsed.pathname === `${base}/versions`) {
      assert.equal(init.method, "POST");
      await options.beforeVersion?.(state);
      state.versions.set(4, clone(state.head));
      return response(options.versionResponse || { versionNumber: 4 });
    }
    if (
      parsed.pathname === `${base}/deployments/${env.APPS_SCRIPT_DEPLOYMENT_ID}`
    ) {
      if (init.method === "GET") {
        state.deploymentReads++;
        options.onDeploymentRead?.(state);
        return response(state.deployment);
      }
      assert.equal(init.method, "PUT");
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body), ["deploymentConfig"]);
      state.deployment.deploymentConfig = clone(body.deploymentConfig);
      await options.afterDeploymentUpdate?.(state);
      return response(state.deployment);
    }
    assert.fail(`Unexpected mocked request: ${init.method} ${parsed.pathname}`);
  };
  return { state, fetchImpl };
}
function run(mock, overrides = {}) {
  const logs = [],
    outputs = [];
  const promise = deployAppsScript({
    env: clone(env),
    fetchImpl: mock.fetchImpl,
    managedFiles: clone(local),
    log: (message) => logs.push(message),
    writeOutput: async (output) => outputs.push(output),
    ...overrides,
  });
  return { promise, logs, outputs };
}
const writes = (state) =>
  state.calls.filter(
    (call) =>
      call.method !== "GET" && !call.url.includes("oauth2.googleapis.com"),
  );
const deploymentWrites = (state) =>
  writes(state).filter((call) => call.url.includes("/deployments/"));
const versionWrites = (state) =>
  writes(state).filter((call) => call.url.endsWith("/versions"));
function assertPrivate(values) {
  const output = JSON.stringify(values);
  for (const secret of [
    env.GOOGLE_OAUTH_CLIENT_SECRET,
    env.GOOGLE_OAUTH_REFRESH_TOKEN,
    accessToken,
    privateSource,
  ])
    assert.equal(
      output.includes(secret),
      false,
      "credentials/source must not enter errors, logs or outputs",
    );
}

test("release configuration rejects absent or injected IDs/secrets before any Google call", async () => {
  assert.equal(
    validateReleaseEnvironment(env).APPS_SCRIPT_ID,
    env.APPS_SCRIPT_ID,
  );
  for (const invalid of [
    { APPS_SCRIPT_ID: "" },
    { APPS_SCRIPT_ID: "https://example.test/remote" },
    {
      APPS_SCRIPT_DEPLOYMENT_ID: `${env.APPS_SCRIPT_DEPLOYMENT_ID}\nextra=output`,
    },
    { GOOGLE_OAUTH_CLIENT_SECRET: "" },
    { GOOGLE_OAUTH_REFRESH_TOKEN: "bad\nvalue" },
    { GITHUB_SHA: "not-a-commit" },
  ]) {
    const mock = google();
    const attempt = run(mock, { env: { ...env, ...invalid } });
    await assert.rejects(attempt.promise);
    assert.deepEqual(mock.state.calls, []);
    assert.deepEqual(attempt.outputs, []);
  }
  const mock = google();
  await assert.rejects(run(mock, { timeoutMs: 60001 }).promise, /timeout/);
  assert.equal(mock.state.calls.length, 0);
});

test("merge overlays only four files and preserves original code, HTML, manifest and custom files exactly", () => {
  const remote = files();
  remote.push({
    name: "Custom owner helper",
    type: "SERVER_JS",
    source: "// original owner helper\nfunction customHelper() {}",
  });
  remote.find((file) => file.name === "Workspace").name = "Workspace.gs.gs";
  const original = clone(remote);
  const merged = mergeScriptFiles(remote, local);
  assert.deepEqual(
    remote,
    original,
    "merge must not mutate the source snapshot",
  );
  assert.equal(merged.length, remote.length);
  for (const file of merged) {
    assert.deepEqual(Object.keys(file).sort(), ["name", "source", "type"]);
    const descriptor = MANAGED_SCRIPT_FILES.find(
      (entry) =>
        entry.type === file.type &&
        (entry.name === file.name ||
          (file.name === "Workspace.gs.gs" && entry.name === "Workspace")),
    );
    if (descriptor) assert.equal(file.source, local[descriptor.file]);
    else
      assert.equal(
        file.source,
        remote.find((old) => old.name === file.name && old.type === file.type)
          .source,
      );
  }
  const missing = remote.filter(
    (file) => file.name !== "WorkspaceNotifications",
  );
  assert.equal(
    mergeScriptFiles(missing, local).find(
      (file) => file.name === "WorkspaceNotifications",
    ).source,
    local["WorkspaceNotifications.gs"],
  );
});

test("ambiguous managed aliases, type collisions, wrong HTML names and missing native hooks fail closed", () => {
  const duplicate = files();
  duplicate.push({
    name: "Workspace.gs",
    type: "SERVER_JS",
    source: "duplicate",
  });
  assert.throws(() => mergeScriptFiles(duplicate, local), /aliases|duplicate/i);
  const collision = files();
  collision.push({
    name: "Workspace.html",
    type: "HTML",
    source: "wrong type",
  });
  assert.throws(() => mergeScriptFiles(collision, local), /type/);
  const htmlAlias = files();
  htmlAlias.find(
    (file) => file.name === "PwaBridge" && file.type === "HTML",
  ).name = "PwaBridge.html";
  assert.throws(() => mergeScriptFiles(htmlAlias, local), /HTML/);
  const noNative = files().filter((file) => file.name !== "Код");
  assert.throws(() => mergeScriptFiles(noNative, local), /original VARKA/);
  const noHook = files();
  noHook[0].source = noHook[0].source.replace(
    "pwaPage_(e)",
    "originalInventory(e)",
  );
  assert.throws(() => mergeScriptFiles(noHook, local), /hook/);
  const duplicateFunction = files();
  duplicateFunction.push({
    name: "Old workspace copy",
    type: "SERVER_JS",
    source: "function workspaceDispatch_() {}",
  });
  assert.throws(
    () => mergeScriptFiles(duplicateFunction, local),
    /entry point/,
  );
  assert.throws(
    () => mergeScriptFiles(files(), { ...local, "Unknown.gs": "unapproved" }),
    /allowlisted/,
  );
  assert.throws(
    () =>
      mergeScriptFiles(
        files().filter((file) => file.name !== "appsscript"),
        local,
      ),
    /manifest/,
  );
});

test("manifest access and execute-as must explicitly match the existing web deployment", async () => {
  assert.equal(
    validateDeploymentConfig(
      deployment(),
      files(),
      env.APPS_SCRIPT_ID,
      env.APPS_SCRIPT_DEPLOYMENT_ID,
    ).versionNumber,
    3,
  );
  for (const webapp of [
    undefined,
    {},
    { access: "MYSELF", executeAs: "USER_DEPLOYING" },
    { access: "ANYONE_ANONYMOUS", executeAs: "USER_ACCESSING" },
  ]) {
    const head = files();
    const manifest = head.find((file) => file.name === "appsscript");
    const json = JSON.parse(manifest.source);
    json.webapp = webapp;
    manifest.source = JSON.stringify(json);
    const mock = google({ head });
    await assert.rejects(
      run(mock).promise,
      /manifest.*matching|manifest.*match/i,
    );
    assert.deepEqual(writes(mock.state), []);
  }
  const wrong = deployment();
  wrong.entryPoints[0].webApp.url = "https://example.test/not-the-existing-app";
  assert.throws(
    () =>
      validateDeploymentConfig(
        wrong,
        files(),
        env.APPS_SCRIPT_ID,
        env.APPS_SCRIPT_DEPLOYMENT_ID,
      ),
    /deployment/,
  );
});

test("successful release keeps original files, manifest, deployment ID, access, execute-as and exec URL", async () => {
  const mock = google();
  const original = clone(mock.state.head);
  const attempt = run(mock);
  const result = await attempt.promise;
  assert.deepEqual(result, {
    execUrl,
    scriptVersion: 4,
    deploymentId: env.APPS_SCRIPT_DEPLOYMENT_ID,
    changed: true,
  });
  assert.equal(deploymentWrites(mock.state).length, 1);
  assert.equal(versionWrites(mock.state).length, 1);
  assert.equal(
    mock.state.calls.some(
      (call) => call.method === "POST" && call.url.includes("/deployments"),
    ),
    false,
    "never create a new deployment",
  );
  assert.equal(
    mock.state.head.find((file) => file.name === "Код").source,
    original[0].source,
  );
  assert.equal(
    mock.state.head.find((file) => file.name === "appsscript").source,
    original.find((file) => file.name === "appsscript").source,
  );
  assert.equal(
    mock.state.deployment.deploymentConfig.description,
    "Existing owner deployment",
  );
  assert.deepEqual(mock.state.deployment.entryPoints, deployment().entryPoints);
  assert.equal(mock.state.deployment.deploymentConfig.versionNumber, 4);
  assert.match(versionWrites(mock.state)[0].body, new RegExp(env.GITHUB_SHA));
  assert.equal(
    attempt.outputs[0],
    `exec_url=${execUrl}\nscript_version=4\ndeployment_id=${env.APPS_SCRIPT_DEPLOYMENT_ID}\n`,
  );
  for (const call of mock.state.calls) {
    assert.equal(call.redirect, "error");
    assert.ok(call.signal instanceof AbortSignal);
  }
  assertPrivate([attempt.logs, attempt.outputs]);
});

test("an already deployed identical release creates neither a version nor a deployment", async () => {
  const current = mergeScriptFiles(files(), local);
  const mock = google({ head: current, deployed: current });
  const delays = [];
  const attempt = run(mock, {
    sleepImpl: async (milliseconds) => delays.push(milliseconds),
  });
  const result = await attempt.promise;
  assert.equal(result.changed, false);
  assert.equal(result.scriptVersion, 3);
  assert.deepEqual(writes(mock.state), []);
  assert.deepEqual(delays, []);
  assert.match(attempt.outputs[0], /script_version=3/);
});

test("one stale post-update deployment read converges without repeating any write", async () => {
  const original = deployment();
  let updated = false;
  let stale = true;
  const delays = [];
  const mock = google({
    afterDeploymentUpdate() {
      updated = true;
    },
    intercept(call) {
      if (
        updated &&
        stale &&
        call.method === "GET" &&
        call.url.includes("/deployments/")
      ) {
        stale = false;
        return response(original);
      }
    },
  });
  const attempt = run(mock, {
    sleepImpl: async (milliseconds) => delays.push(milliseconds),
  });
  const result = await attempt.promise;
  assert.equal(result.scriptVersion, 4);
  assert.deepEqual(delays, [2000]);
  assert.equal(writes(mock.state).length, 3);
  assert.equal(deploymentWrites(mock.state).length, 1);
  assert.equal(versionWrites(mock.state).length, 1);
  assert.equal(attempt.outputs.length, 1);
  assertPrivate([attempt.logs, attempt.outputs]);
});

test("persistent pre-update readback stops after bounded GET rechecks without publishing or repeating writes", async () => {
  const original = deployment();
  original.deploymentConfig.description = privateSource;
  let updated = false;
  const delays = [];
  const mock = google({
    deployment: original,
    afterDeploymentUpdate() {
      updated = true;
    },
    intercept(call) {
      if (
        updated &&
        call.method === "GET" &&
        call.url.includes("/deployments/")
      )
        return response(original);
    },
  });
  const attempt = run(mock, {
    sleepImpl: async (milliseconds) => delays.push(milliseconds),
  });
  const error = await attempt.promise.catch((error) => error);
  assert.ok(error instanceof Error);
  assert.match(error.message, /expected version 4, received 3/);
  assert.match(error.message, /description matches; entry points match/);
  assert.deepEqual(delays, [2000, 4000, 8000]);
  assert.equal(writes(mock.state).length, 3);
  assert.equal(deploymentWrites(mock.state).length, 1);
  assert.deepEqual(attempt.outputs, []);
  assertPrivate([error.message, error.stack, attempt.logs, attempt.outputs]);
});

test("a different deployment appearing during readback fails immediately instead of waiting over it", async () => {
  const original = deployment();
  let updated = false;
  let readbacks = 0;
  const delays = [];
  const mock = google({
    afterDeploymentUpdate() {
      updated = true;
    },
    intercept(call, state) {
      if (
        updated &&
        call.method === "GET" &&
        call.url.includes("/deployments/")
      ) {
        if (++readbacks === 1) return response(original);
        state.deployment.deploymentConfig.versionNumber = 8;
      }
    },
  });
  const attempt = run(mock, {
    sleepImpl: async (milliseconds) => delays.push(milliseconds),
  });
  await assert.rejects(attempt.promise, /expected version 4, received 8/);
  assert.deepEqual(delays, [2000]);
  assert.equal(deploymentWrites(mock.state).length, 1);
  assert.equal(mock.state.deployment.deploymentConfig.versionNumber, 8);
  assert.deepEqual(attempt.outputs, []);
});

test("a source edit during the readback wait blocks Pages without rolling back the deployment", async () => {
  const original = deployment();
  let updated = false;
  let stale = true;
  const mock = google({
    afterDeploymentUpdate() {
      updated = true;
    },
    intercept(call) {
      if (
        updated &&
        stale &&
        call.method === "GET" &&
        call.url.includes("/deployments/")
      ) {
        stale = false;
        return response(original);
      }
    },
  });
  const attempt = run(mock, {
    sleepImpl: async () => {
      mock.state.head[0].source += "\n// concurrent source edit";
    },
  });
  await assert.rejects(
    attempt.promise,
    /HEAD changed during deployment verification/,
  );
  assert.equal(deploymentWrites(mock.state).length, 1);
  assert.equal(mock.state.deployment.deploymentConfig.versionNumber, 4);
  assert.match(mock.state.head[0].source, /concurrent source edit/);
  assert.deepEqual(attempt.outputs, []);
});

test("empty and omitted optional deployment descriptions are equivalent without changing the request shape", async () => {
  for (const initialDescription of [undefined, ""]) {
    const original = deployment();
    if (initialDescription === undefined)
      delete original.deploymentConfig.description;
    else original.deploymentConfig.description = initialDescription;
    const mock = google({
      deployment: original,
      afterDeploymentUpdate(state) {
        if (initialDescription === undefined)
          state.deployment.deploymentConfig.description = "";
        else delete state.deployment.deploymentConfig.description;
      },
    });
    const result = await run(mock).promise;
    assert.equal(result.scriptVersion, 4);
    assert.equal(deploymentWrites(mock.state).length, 1);
    assert.equal(
      Object.hasOwn(
        JSON.parse(deploymentWrites(mock.state)[0].body).deploymentConfig,
        "description",
      ),
      initialDescription !== undefined,
    );
  }
  for (const description of [null, 42, { value: privateSource }]) {
    const invalid = deployment();
    invalid.deploymentConfig.description = description;
    assert.throws(
      () =>
        validateDeploymentConfig(
          invalid,
          files(),
          env.APPS_SCRIPT_ID,
          env.APPS_SCRIPT_DEPLOYMENT_ID,
        ),
      /unexpected project, version, or manifest/,
    );
  }
});

test("undeployed original source changes are not automatically published by a managed-file release", async () => {
  const head = files();
  head[0].source += "\n// unreviewed owner change";
  const mock = google({ head });
  await assert.rejects(run(mock).promise, /unmanaged|original|undeployed/i);
  assert.deepEqual(writes(mock.state), []);
});

test("a concurrent HEAD edit or deployment change before upload stops without any write", async () => {
  const headRace = google({
    onHeadRead(state) {
      if (state.headReads === 2) state.head[0].source += "\n// concurrent edit";
    },
  });
  await assert.rejects(run(headRace).promise, /HEAD changed/);
  assert.deepEqual(writes(headRace.state), []);
  const deploymentRace = google({
    onDeploymentRead(state) {
      if (state.deploymentReads === 2)
        state.deployment.deploymentConfig.description = "Concurrent deployment";
    },
  });
  await assert.rejects(run(deploymentRace).promise, /deployment changed/);
  assert.deepEqual(writes(deploymentRace.state), []);
});

test("a source edit after upload stops before version creation and is never rolled back", async () => {
  const mock = google({
    onHeadRead(state) {
      if (state.headReads === 3) state.head[0].source += "\n// newer HEAD";
    },
  });
  const attempt = run(mock);
  await assert.rejects(attempt.promise, /HEAD does not match/);
  assert.equal(writes(mock.state).length, 1);
  assert.equal(versionWrites(mock.state).length, 0);
  assert.equal(deploymentWrites(mock.state).length, 0);
  assert.match(mock.state.head[0].source, /newer HEAD/);
  assert.deepEqual(attempt.outputs, []);
});

test("immutable version verification prevents publishing a version created from concurrent source", async () => {
  const mock = google({
    beforeVersion(state) {
      state.head[0].source += "\n// raced with version creation";
    },
  });
  const attempt = run(mock);
  await assert.rejects(attempt.promise, /created version does not match/);
  assert.equal(versionWrites(mock.state).length, 1);
  assert.equal(deploymentWrites(mock.state).length, 0);
  assert.equal(mock.state.deployment.deploymentConfig.versionNumber, 3);
  assert.deepEqual(attempt.outputs, []);
});

test("a newer deployment during version creation is never overwritten or rolled back", async () => {
  const mock = google({
    onDeploymentRead(state) {
      if (state.deploymentReads === 3)
        state.deployment.deploymentConfig.versionNumber = 77;
    },
  });
  await assert.rejects(run(mock).promise, /deployment changed/);
  assert.equal(deploymentWrites(mock.state).length, 0);
  assert.equal(mock.state.deployment.deploymentConfig.versionNumber, 77);
});

test("an ambiguous upload timeout is not retried and never emits release outputs", async () => {
  const mock = google({
    afterUpload() {
      throw Error(
        `network leaked ${privateSource} ${env.GOOGLE_OAUTH_REFRESH_TOKEN}`,
      );
    },
  });
  const attempt = run(mock);
  const error = await attempt.promise.then(
    () => assert.fail("must reject"),
    (error) => error,
  );
  assert.match(error.message, /Upload Apps Script source.*may have completed/);
  assert.equal(writes(mock.state).length, 1);
  assert.equal(versionWrites(mock.state).length, 0);
  assert.deepEqual(attempt.outputs, []);
  assertPrivate([error.message, error.stack, attempt.logs, attempt.outputs]);
});

test("an ambiguous deployment update leaves its actual outcome intact without retry or output", async () => {
  const mock = google({
    afterDeploymentUpdate() {
      throw Error(`timeout ${accessToken}`);
    },
  });
  const attempt = run(mock);
  const error = await attempt.promise.then(
    () => assert.fail("must reject"),
    (error) => error,
  );
  assert.match(
    error.message,
    /Update existing Apps Script deployment.*may have completed/,
  );
  assert.equal(deploymentWrites(mock.state).length, 1);
  assert.equal(mock.state.deployment.deploymentConfig.versionNumber, 4);
  assert.deepEqual(attempt.outputs, []);
  assertPrivate([error.message, error.stack, attempt.logs]);
});

test("post-deployment URL/access/version verification fails closed before Pages outputs", async () => {
  for (const mutate of [
    (state) => {
      state.deployment.entryPoints[0].webApp.entryPointConfig.access = "MYSELF";
    },
    (state) => {
      state.deployment.entryPoints[0].webApp.url =
        "https://example.test/changed";
    },
    (state) => {
      state.deployment.deploymentConfig.versionNumber = 8;
    },
    (state) => {
      state.deployment.entryPoints[0].webApp.entryPointConfig.executeAs =
        "USER_ACCESSING";
    },
    (state) => {
      state.deployment.deploymentConfig.description = privateSource;
    },
    (state) => {
      state.deployment.entryPoints[0].webApp.unexpectedMetadata = privateSource;
    },
  ]) {
    const mock = google({ afterDeploymentUpdate: mutate });
    const delays = [];
    const attempt = run(mock, {
      sleepImpl: async (milliseconds) => delays.push(milliseconds),
    });
    const error = await attempt.promise.catch((error) => error);
    assert.ok(error instanceof Error);
    assert.deepEqual(delays, []);
    assert.equal(deploymentWrites(mock.state).length, 1);
    assert.deepEqual(attempt.outputs, []);
    assertPrivate([error.message, error.stack, attempt.logs, attempt.outputs]);
  }
});

test("Google HTTP bodies, invalid JSON and network causes never expose source or OAuth tokens", async () => {
  let bodyRead = false;
  const rejectedOAuth = google({
    intercept(call) {
      if (call.url.includes("oauth2.googleapis.com"))
        return {
          ok: false,
          status: 403,
          json: async () => {
            bodyRead = true;
            return { error: `${privateSource} ${accessToken}` };
          },
        };
    },
  });
  const attempt = run(rejectedOAuth);
  const error = await attempt.promise.then(
    () => assert.fail("must reject"),
    (error) => error,
  );
  assert.match(error.message, /HTTP 403/);
  assert.equal(bodyRead, false);
  assert.equal(rejectedOAuth.state.calls.length, 1);
  assertPrivate([error.message, error.stack, attempt.logs]);
  const invalidJSON = google({
    intercept(call) {
      if (call.url.includes("oauth2.googleapis.com"))
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw Error(`${env.GOOGLE_OAUTH_CLIENT_SECRET} ${privateSource}`);
          },
        };
    },
  });
  const invalidAttempt = run(invalidJSON);
  const invalidError = await invalidAttempt.promise.then(
    () => assert.fail("must reject"),
    (error) => error,
  );
  assert.match(invalidError.message, /invalid JSON/);
  assertPrivate([
    invalidError.message,
    invalidError.stack,
    invalidAttempt.logs,
  ]);
});

test("invalid access tokens or version numbers stop without updating the deployment", async () => {
  const invalidToken = google({
    intercept(call) {
      if (call.url.includes("oauth2.googleapis.com"))
        return response({ access_token: "bad\ntoken" });
    },
  });
  await assert.rejects(run(invalidToken).promise, /access token/);
  assert.equal(invalidToken.state.calls.length, 1);
  const invalidVersion = google({ versionResponse: { versionNumber: "4" } });
  await assert.rejects(run(invalidVersion).promise, /version number/);
  assert.equal(deploymentWrites(invalidVersion.state).length, 0);
});

test("a rejected source upload with private API details stops without reading the error body", async () => {
  let bodyRead = false;
  const mock = google({
    intercept(call) {
      if (call.method === "PUT" && call.url.endsWith("/content"))
        return {
          ok: false,
          status: 400,
          json: async () => {
            bodyRead = true;
            return {
              error: `${privateSource} ${env.GOOGLE_OAUTH_REFRESH_TOKEN}`,
            };
          },
        };
    },
  });
  const attempt = run(mock);
  const error = await attempt.promise.then(
    () => assert.fail("must reject"),
    (error) => error,
  );
  assert.match(error.message, /Upload Apps Script source.*HTTP 400/);
  assert.equal(bodyRead, false);
  assert.equal(writes(mock.state).length, 1);
  assert.equal(versionWrites(mock.state).length, 0);
  assert.equal(deploymentWrites(mock.state).length, 0);
  assert.deepEqual(attempt.outputs, []);
  assertPrivate([error.message, error.stack, attempt.logs]);
});

test("a lost version-create response never retries the write or updates the live deployment", async () => {
  const mock = google({
    intercept(call, state) {
      if (call.method === "POST" && call.url.endsWith("/versions")) {
        state.versions.set(4, clone(state.head)); // Google committed before timeout.
        throw Error(`lost response ${accessToken}`);
      }
    },
  });
  const attempt = run(mock);
  const error = await attempt.promise.then(
    () => assert.fail("must reject"),
    (error) => error,
  );
  assert.match(error.message, /Create Apps Script version.*may have completed/);
  assert.equal(versionWrites(mock.state).length, 1);
  assert.equal(deploymentWrites(mock.state).length, 0);
  assert.equal(mock.state.deployment.deploymentConfig.versionNumber, 3);
  assert.ok(mock.state.versions.has(4));
  assert.deepEqual(attempt.outputs, []);
  assertPrivate([error.message, error.stack, attempt.logs]);
});

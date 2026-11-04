import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GOOGLE_RELEASE_SCOPES,
  parseAuthorizationArgs,
  parseDesktopClient,
  loadDesktopClient,
  createAuthorizationRequest,
  validateCallbackRequest,
  validateTokenResponse,
  waitForAuthorizationCode,
  authorizeGoogleRelease,
  runGhCommand,
} from "../scripts/authorize-google-release.js";

const clientId = "123456789-test-client.apps.googleusercontent.com";
const clientSecret = "fake-client-secret-never-print";
const refreshToken = "fake-refresh-token-never-print";
const authCode = "fake-authorization-code-never-print";
const state = "a".repeat(43);
const verifier = "b".repeat(43);
const redirectUri = "http://127.0.0.1:54321/";
const repo = "Feorum/Vibe_Inventory_Stock";
const clientDocument = () => ({
  installed: {
    client_id: clientId,
    client_secret: clientSecret,
    auth_uri: "https://not-google.invalid/auth",
    token_uri: "https://not-google.invalid/token",
  },
});
const tokenDocument = () => ({
  access_token: "fake-access-token",
  refresh_token: refreshToken,
  token_type: "Bearer",
  scope: GOOGLE_RELEASE_SCOPES.join(" "),
});

test("release authorization arguments require an explicit repository and reject ambiguous or injectable targets", () => {
  assert.deepEqual(
    parseAuthorizationArgs([
      "--client",
      "/tmp/client.json",
      "--repo",
      repo,
      "--no-browser",
    ]),
    {
      client: "/tmp/client.json",
      repo,
      environment: "github-pages",
      openBrowser: false,
    },
  );
  assert.equal(parseAuthorizationArgs(["--help"]).help, true);
  for (const args of [
    [],
    ["--client", "--repo", repo],
    ["--repo", repo],
    ["--client", "/tmp/a", "--repo", "https://github.com/a/b"],
    ["--client", "/tmp/a", "--repo", "a/.."],
    ["--client", "/tmp/a", "--repo", repo, "--environment", "../../unsafe"],
    ["--client", "/tmp/a", "--repo", repo, "--repo", repo],
    ["--client", "/tmp/a", "--repo", repo, "--token", "hidden"],
  ])
    assert.throws(() => parseAuthorizationArgs(args));
});

test("only Desktop client credentials are read and downloaded endpoints are ignored", () => {
  assert.deepEqual(parseDesktopClient(clientDocument()), {
    clientId,
    clientSecret,
  });
  assert.deepEqual(parseDesktopClient(JSON.stringify(clientDocument())), {
    clientId,
    clientSecret,
  });
  for (const input of [
    "invalid",
    {},
    { web: clientDocument().installed },
    {
      installed: {
        client_id: "wrong-host.invalid",
        client_secret: clientSecret,
      },
    },
    { installed: { client_id: clientId, client_secret: "line\nsecret" } },
  ])
    assert.throws(() => parseDesktopClient(input));
});

test("client files inside the checkout, including symlinks into it, are rejected without copying credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "varka-oauth-test-"));
  try {
    const checkout = path.join(directory, "checkout");
    await mkdir(checkout);
    const outside = path.join(directory, "client.json");
    const inside = path.join(checkout, "client.json");
    await writeFile(outside, JSON.stringify(clientDocument()), { mode: 0o600 });
    await writeFile(inside, JSON.stringify(clientDocument()), { mode: 0o600 });
    assert.deepEqual(await loadDesktopClient(outside, checkout), {
      clientId,
      clientSecret,
    });
    await assert.rejects(
      loadDesktopClient(inside, checkout),
      /outside the repository/,
    );
    const link = path.join(directory, "linked-client.json");
    await symlink(inside, link);
    await assert.rejects(
      loadDesktopClient(link, checkout),
      /outside the repository/,
    );
    await assert.rejects(
      loadDesktopClient(checkout, checkout),
      /outside the repository/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OAuth authorization uses PKCE, unpredictable state, the exact narrow scopes and loopback redirect", () => {
  const request = createAuthorizationRequest({
    clientId,
    redirectUri,
    state,
    verifier,
  });
  const url = new URL(request.url);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.pathname, "/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(url.searchParams.get("scope"), GOOGLE_RELEASE_SCOPES.join(" "));
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier).digest("base64url"),
  );
  assert.ok(!request.url.includes(clientSecret));
  const first = createAuthorizationRequest({ clientId, redirectUri });
  const second = createAuthorizationRequest({ clientId, redirectUri });
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.verifier, second.verifier);
  for (const address of [
    "http://localhost:54321/",
    "https://127.0.0.1:54321/",
    "http://127.0.0.1:54321/callback",
    "https://evil.invalid/",
  ])
    assert.throws(() =>
      createAuthorizationRequest({ clientId, redirectUri: address }),
    );
});

test("callback validation rejects wrong method, host, state, path and duplicate query parameters", () => {
  const options = { redirectUri, state };
  const base = {
    method: "GET",
    host: "127.0.0.1:54321",
    url: `/?state=${state}&code=${authCode}`,
  };
  assert.deepEqual(validateCallbackRequest(base, options), {
    kind: "code",
    status: 200,
    code: authCode,
  });
  for (const changed of [
    { method: "POST" },
    { host: "localhost:54321" },
    { host: "evil.invalid" },
    { url: `/?state=wrong&code=${authCode}` },
    { url: `/?state=${state}&code=first&code=second` },
    { url: `/?state=${state}&state=${state}&code=${authCode}` },
    { url: `/other?state=${state}&code=${authCode}` },
    { url: `//evil.invalid/?state=${state}&code=${authCode}` },
    { url: `/?state=${state}&code=${authCode}&error=denied` },
    { url: `/?state=${state}&code=bad%0Acode` },
  ])
    assert.equal(
      validateCallbackRequest({ ...base, ...changed }, options).kind,
      "invalid",
    );
  assert.equal(
    validateCallbackRequest(
      { ...base, url: `/?state=${state}&error=access_denied` },
      options,
    ).kind,
    "denied",
  );
});

test("loopback callback ignores a forged attempt, accepts valid authorization once and does not echo the code", async () => {
  const receiver = await waitForAuthorizationCode({ state, timeoutMs: 2000 });
  try {
    const invalid = await fetch(
      `${receiver.redirectUri}?state=wrong&code=${authCode}`,
    );
    assert.equal(invalid.status, 400);
    assert.ok(!(await invalid.text()).includes(authCode));
    const response = await fetch(
      `${receiver.redirectUri}?state=${state}&code=${authCode}`,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(!(await response.text()).includes(authCode));
    assert.equal(await receiver.authorizationCode, authCode);
  } finally {
    await receiver.close();
  }
  await assert.rejects(fetch(receiver.redirectUri));
});

test("loopback callback denial and timeout close safely without exposing provider text", async () => {
  const denied = await waitForAuthorizationCode({ state, timeoutMs: 1000 });
  try {
    const response = await fetch(
      `${denied.redirectUri}?state=${state}&error=secret-provider-text`,
    );
    assert.ok(!(await response.text()).includes("secret-provider-text"));
    await assert.rejects(denied.authorizationCode, /declined/);
  } finally {
    await denied.close();
  }
  const timed = await waitForAuthorizationCode({ state, timeoutMs: 30 });
  await assert.rejects(timed.authorizationCode, /timed out/);
  await timed.close();
  await assert.rejects(fetch(timed.redirectUri));
});

test("refresh token validation refuses missing tokens or missing release scopes", () => {
  assert.equal(validateTokenResponse(tokenDocument()), refreshToken);
  for (const changes of [
    { refresh_token: undefined },
    { access_token: "" },
    { scope: "openid" },
    { token_type: 1 },
    { refresh_token: "unsafe\nvalue" },
    { refresh_token: "unsafe\0value" },
    { refresh_token: "unsafe value" },
  ])
    assert.throws(() =>
      validateTokenResponse({ ...tokenDocument(), ...changes }),
    );
});

test("gh subprocess targets github.com and sends credentials through its stdin only", async () => {
  const previousHost = process.env.GH_HOST;
  process.env.GH_HOST = "enterprise.example.test";
  let captured,
    sent = "";
  try {
    const result = await runGhCommand(["secret", "set", "TEST_SECRET"], {
      input: refreshToken,
      spawnImpl: (command, args, options) => {
        captured = { command, args, options };
        const child = new EventEmitter();
        child.kill = () => {};
        child.stdin = new PassThrough();
        child.stdin.on("data", (chunk) => {
          sent += chunk;
        });
        child.stdin.on("finish", () =>
          process.nextTick(() => child.emit("close", 0)),
        );
        return child;
      },
    });
    assert.equal(result, 0);
    assert.equal(captured.command, "gh");
    assert.equal(captured.options.env.GH_HOST, "github.com");
    assert.deepEqual(captured.options.stdio, ["pipe", "ignore", "ignore"]);
    assert.ok(!captured.args.join(" ").includes(refreshToken));
    assert.equal(sent, refreshToken);
  } finally {
    if (previousHost === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = previousHost;
  }
});

function flow(overrides = {}) {
  const calls = [],
    logs = [],
    fetches = [];
  let closed = 0,
    opened = 0;
  const dependencies = {
    readClient: async () => ({ clientId, clientSecret }),
    runGh: async (args, options = {}) => {
      calls.push({ args, input: options.input });
      return 0;
    },
    createReceiver: async () => ({
      redirectUri,
      authorizationCode: Promise.resolve(authCode),
      close: async () => {
        closed++;
      },
    }),
    openBrowser: async () => {
      opened++;
    },
    fetchImpl: async (url, options) => {
      fetches.push({ url, options });
      return { ok: true, json: async () => tokenDocument() };
    },
    log: (value) => logs.push(value),
    ...overrides,
  };
  return {
    dependencies,
    calls,
    logs,
    fetches,
    closed: () => closed,
    opened: () => opened,
  };
}
const flowOptions = {
  client: "/not-read-in-this-test.json",
  repo,
  environment: "github-pages",
  openBrowser: true,
};

test("setup preflights GitHub before Google, exchanges PKCE code, and uploads secrets only through stdin", async () => {
  const fixture = flow();
  const result = await authorizeGoogleRelease(
    flowOptions,
    fixture.dependencies,
  );
  assert.equal(fixture.closed(), 1);
  assert.equal(fixture.opened(), 1);
  assert.deepEqual(fixture.calls[0].args, [
    "auth",
    "status",
    "--hostname",
    "github.com",
  ]);
  assert.deepEqual(fixture.calls[1].args, [
    "api",
    "--hostname",
    "github.com",
    `repos/${repo}/environments/github-pages`,
    "--silent",
  ]);
  assert.equal(fixture.fetches.length, 1);
  assert.equal(fixture.fetches[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(fixture.fetches[0].options.redirect, "error");
  const body = new URLSearchParams(fixture.fetches[0].options.body);
  assert.equal(body.get("code"), authCode);
  assert.equal(body.get("client_secret"), clientSecret);
  const authUrl = new URL(
    fixture.logs.find((line) => line.startsWith("https://")),
  );
  assert.equal(
    authUrl.searchParams.get("code_challenge"),
    createHash("sha256").update(body.get("code_verifier")).digest("base64url"),
  );
  const uploads = fixture.calls.slice(2);
  assert.deepEqual(
    uploads.map((call) => call.input),
    [clientId, clientSecret, refreshToken],
  );
  assert.deepEqual(
    uploads.map((call) => call.args[2]),
    [
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_REFRESH_TOKEN",
    ],
  );
  for (const call of uploads) {
    assert.ok(call.args.includes(`github.com/${repo}`));
    for (const secret of [clientSecret, refreshToken, authCode])
      assert.ok(!call.args.join(" ").includes(secret));
  }
  for (const secret of [clientSecret, refreshToken, authCode])
    assert.ok(!fixture.logs.join("\n").includes(secret));
  assert.deepEqual(
    result.secretsWritten,
    uploads.map((call) => call.args[2]),
  );
  assert.ok(!JSON.stringify(result).includes(refreshToken));
});

test("GitHub authentication and environment failures stop before opening Google", async () => {
  for (const failedCall of [1, 2]) {
    let calls = 0,
      receivers = 0;
    const fixture = flow({
      runGh: async () => (++calls === failedCall ? 1 : 0),
      createReceiver: async () => {
        receivers++;
        throw Error("should not start");
      },
    });
    await assert.rejects(
      authorizeGoogleRelease(flowOptions, fixture.dependencies),
      /GitHub|environment/,
    );
    assert.equal(receivers, 0);
    assert.equal(fixture.fetches.length, 0);
  }
});

test("Google exchange, token validation and callback errors never upload secrets and always close the listener", async () => {
  const cases = [
    {
      fetchImpl: async () => {
        throw Error(`${clientSecret} ${authCode}`);
      },
    },
    {
      fetchImpl: async () => ({
        ok: false,
        json: async () => {
          throw Error(refreshToken);
        },
      }),
    },
    {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ ...tokenDocument(), refresh_token: undefined }),
      }),
    },
  ];
  for (const overrides of cases) {
    const fixture = flow(overrides);
    await assert.rejects(
      authorizeGoogleRelease(flowOptions, fixture.dependencies),
      (error) => {
        for (const secret of [clientSecret, refreshToken, authCode])
          assert.ok(!error.message.includes(secret));
        return true;
      },
    );
    assert.equal(
      fixture.calls.filter((call) => call.args[0] === "secret").length,
      0,
    );
    assert.equal(fixture.closed(), 1);
  }
});

test("partial GitHub upload failure is redacted and warns that a complete rerun is required", async () => {
  let uploads = 0;
  const fixture = flow({
    runGh: async (args) => {
      if (args[0] === "secret" && ++uploads === 2) throw Error(refreshToken);
      return 0;
    },
  });
  await assert.rejects(
    authorizeGoogleRelease(flowOptions, fixture.dependencies),
    (error) => {
      assert.match(error.message, /after 1 of 3 secrets/);
      assert.match(error.message, /rerun setup/);
      assert.ok(!error.message.includes(refreshToken));
      return true;
    },
  );
  assert.equal(fixture.closed(), 1);
});

test("browser-opening failure uses a manual URL without changing the credential transfer", async () => {
  const fixture = flow({
    openBrowser: async () => {
      throw Error(clientSecret);
    },
  });
  await authorizeGoogleRelease(flowOptions, fixture.dependencies);
  assert.match(fixture.logs.join("\n"), /manually/);
  assert.ok(!fixture.logs.join("\n").includes(clientSecret));
  assert.equal(fixture.closed(), 1);
});

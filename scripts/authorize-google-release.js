import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GOOGLE_RELEASE_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/script.projects",
  "https://www.googleapis.com/auth/script.deployments",
]);
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CHECKOUT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SECRET_NAMES = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
];

const failure = (message) => new Error(message);
const isObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
function validateTarget({ repo, environment = "github-pages" }) {
  if (
    typeof repo !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repo) ||
    [".", ".."].includes(repo.split("/")[1])
  )
    throw failure("Use --repo with an explicit GitHub owner/repository name.");
  if (
    typeof environment !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(environment)
  )
    throw failure("Use a simple, explicit GitHub environment name.");
  return { repo, environment };
}

export function parseAuthorizationArgs(args) {
  const options = { environment: "github-pages", openBrowser: true };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (
      ![
        "--client",
        "--repo",
        "--environment",
        "--no-browser",
        "--help",
      ].includes(flag) ||
      seen.has(flag)
    )
      throw failure("Unknown or repeated option. Run with --help for usage.");
    seen.add(flag);
    if (flag === "--no-browser") options.openBrowser = false;
    else if (flag === "--help") options.help = true;
    else {
      const value = args[++index];
      if (typeof value !== "string" || !value || value.startsWith("--"))
        throw failure(
          "A required option value is missing. Run with --help for usage.",
        );
      options[flag.slice(2)] = value;
    }
  }
  if (options.help) return options;
  if (!options.client)
    throw failure(
      "Provide --client with a downloaded Desktop OAuth client JSON file outside this checkout.",
    );
  return { ...options, ...validateTarget(options) };
}

export function parseDesktopClient(input) {
  let document;
  try {
    document = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw failure("The OAuth client file is not valid JSON.");
  }
  const installed = document?.installed;
  if (!isObject(document) || !isObject(installed) || document.web)
    throw failure(
      "Download an OAuth client of type Desktop app, not Web application.",
    );
  const { client_id: clientId, client_secret: clientSecret } = installed;
  if (
    typeof clientId !== "string" ||
    clientId.length > 512 ||
    !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId) ||
    typeof clientSecret !== "string" ||
    !clientSecret.length ||
    clientSecret.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(clientSecret)
  )
    throw failure(
      "The Desktop OAuth client file is missing valid client credentials.",
    );
  // Never trust endpoints supplied by the downloaded file.
  return { clientId, clientSecret };
}

export async function loadDesktopClient(
  clientPath,
  checkoutRoot = CHECKOUT_ROOT,
) {
  let resolved, root, details, source;
  try {
    resolved = await realpath(path.resolve(clientPath));
    root = await realpath(checkoutRoot);
    details = await stat(resolved);
  } catch {
    throw failure(
      "The OAuth client file could not be read. Keep it outside the repository.",
    );
  }
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
    throw failure(
      "Move the OAuth client file outside the repository before continuing.",
    );
  if (!details.isFile() || details.size > 65536)
    throw failure("The OAuth client path must be a small regular JSON file.");
  try {
    source = await readFile(resolved, "utf8");
  } catch {
    throw failure("The OAuth client file could not be read.");
  }
  return parseDesktopClient(source);
}

function validateRedirect(redirectUri) {
  let redirect;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw failure("Invalid local OAuth redirect address.");
  }
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    !redirect.port ||
    redirect.pathname !== "/" ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  )
    throw failure(
      "OAuth must return to an IPv4 loopback listener with a random port.",
    );
  return redirect;
}

export function createAuthorizationRequest({
  clientId,
  redirectUri,
  state = randomBytes(32).toString("base64url"),
  verifier = randomBytes(32).toString("base64url"),
}) {
  validateRedirect(redirectUri);
  if (
    !/^[A-Za-z0-9_-]{43,128}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)
  )
    throw failure("Invalid OAuth state or PKCE verifier.");
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_RELEASE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.href, state, verifier };
}

const sameState = (actual, expected) => {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const first = Buffer.from(actual),
    second = Buffer.from(expected);
  return first.length === second.length && timingSafeEqual(first, second);
};

export function validateCallbackRequest(
  { method, host, url },
  { redirectUri, state },
) {
  const redirect = validateRedirect(redirectUri);
  if (
    method !== "GET" ||
    host !== redirect.host ||
    typeof url !== "string" ||
    !url.startsWith("/")
  )
    return { kind: "invalid", status: 400 };
  let callback;
  try {
    callback = new URL(url, redirect);
  } catch {
    return { kind: "invalid", status: 400 };
  }
  if (
    callback.origin !== redirect.origin ||
    callback.pathname !== "/" ||
    callback.hash
  )
    return { kind: "invalid", status: 400 };
  const keys = [...callback.searchParams.keys()];
  if (
    keys.length !== new Set(keys).size ||
    !sameState(callback.searchParams.get("state"), state)
  )
    return { kind: "invalid", status: 400 };
  const code = callback.searchParams.get("code"),
    error = callback.searchParams.get("error");
  if (error && !code) return { kind: "denied", status: 200 };
  if (
    error ||
    typeof code !== "string" ||
    !code ||
    code.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(code)
  )
    return { kind: "invalid", status: 400 };
  return { kind: "code", status: 200, code };
}

export async function waitForAuthorizationCode({
  state,
  timeoutMs = 300000,
} = {}) {
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(state))
    throw failure("Invalid OAuth callback state.");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000)
    throw failure("Invalid OAuth callback timeout.");
  let resolveCode,
    rejectCode,
    timer,
    finished = false,
    redirectUri;
  const authorizationCode = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  authorizationCode.catch(() => {});
  const server = createServer((request, response) => {
    const result = validateCallbackRequest(
      { method: request.method, host: request.headers.host, url: request.url },
      { redirectUri, state },
    );
    response.writeHead(result.status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    });
    const body =
      result.kind === "invalid"
        ? "Invalid authorization callback. Return to the setup terminal."
        : result.kind === "denied"
          ? "Authorization was not completed. Return to the setup terminal."
          : "Google authorization received. Return to the setup terminal; you may close this page.";
    response.end(body, () => {
      if (result.kind === "invalid" || finished) return;
      finished = true;
      clearTimeout(timer);
      if (result.kind === "code") resolveCode(result.code);
      else
        rejectCode(
          failure(
            "Google authorization was declined; no GitHub secrets were changed.",
          ),
        );
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const close = () =>
    new Promise((resolve) => {
      clearTimeout(timer);
      server.close(() => resolve());
      server.closeAllConnections();
    });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch {
    await close();
    throw failure("Could not start the local Google authorization callback.");
  }
  redirectUri = `http://127.0.0.1:${server.address().port}/`;
  timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    rejectCode(
      failure(
        "Google authorization timed out; no GitHub secrets were changed.",
      ),
    );
    void close();
  }, timeoutMs);
  return { redirectUri, authorizationCode, close };
}

export function validateTokenResponse(value) {
  if (
    !isObject(value) ||
    typeof value.access_token !== "string" ||
    !value.access_token ||
    typeof value.refresh_token !== "string" ||
    !value.refresh_token ||
    value.refresh_token.length > 8192 ||
    !/^[\x21-\x7e]+$/.test(value.refresh_token) ||
    (value.token_type !== undefined &&
      (typeof value.token_type !== "string" ||
        value.token_type.toLowerCase() !== "bearer"))
  )
    throw failure(
      "Google did not issue a usable refresh token. Revoke this app's old grant if necessary, then authorize again.",
    );
  if (value.scope !== undefined) {
    if (
      typeof value.scope !== "string" ||
      !GOOGLE_RELEASE_SCOPES.every((scope) =>
        value.scope.split(/\s+/).includes(scope),
      )
    )
      throw failure(
        "Google did not grant both Apps Script release permissions. No GitHub secrets were changed.",
      );
  }
  return value.refresh_token;
}

export function runGhCommand(
  args,
  { input = "", timeoutMs = 30000, spawnImpl = spawn } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("gh", args, {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      env: { ...process.env, GH_HOST: "github.com" },
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(failure("GitHub CLI request timed out."));
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        failure(
          "GitHub CLI could not be started. Install gh and sign in first.",
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function openAuthorizationBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.once("error", () =>
      reject(failure("Open the authorization URL manually in your browser.")),
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function authorizeGoogleRelease(
  options,
  {
    fetchImpl = globalThis.fetch,
    runGh = runGhCommand,
    openBrowser = openAuthorizationBrowser,
    createReceiver = waitForAuthorizationCode,
    readClient = loadDesktopClient,
    log = console.log,
    timeoutMs = 300000,
  } = {},
) {
  const { repo, environment } = validateTarget(options);
  const client = await readClient(options.client);
  try {
    if ((await runGh(["auth", "status", "--hostname", "github.com"])) !== 0)
      throw failure(
        "Sign in with gh auth login before running Google authorization.",
      );
  } catch {
    throw failure(
      "GitHub CLI is not ready. Install gh and run gh auth login first.",
    );
  }
  try {
    if (
      (await runGh([
        "api",
        "--hostname",
        "github.com",
        `repos/${repo}/environments/${environment}`,
        "--silent",
      ])) !== 0
    )
      throw failure("Environment unavailable.");
  } catch {
    throw failure(
      "Create the target GitHub environment and verify your repository permissions before continuing.",
    );
  }
  const state = randomBytes(32).toString("base64url");
  const receiver = await createReceiver({ state, timeoutMs });
  try {
    const authorization = createAuthorizationRequest({
      clientId: client.clientId,
      redirectUri: receiver.redirectUri,
      state,
    });
    log(
      "Authorize with the Google account that owns the existing Apps Script deployment:",
    );
    log(authorization.url);
    if (options.openBrowser !== false) {
      try {
        await openBrowser(authorization.url);
      } catch {
        log("Open the authorization URL above manually in your browser.");
      }
    }
    const code = await receiver.authorizationCode;
    let response, value;
    try {
      response = await fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code,
          code_verifier: authorization.verifier,
          redirect_uri: receiver.redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      });
      if (!response.ok) throw failure("Token exchange rejected.");
      value = await response.json();
    } catch {
      throw failure(
        "Google token exchange failed. No GitHub secrets were changed; authorize again after checking your OAuth setup.",
      );
    }
    const refreshToken = validateTokenResponse(value);
    const values = [client.clientId, client.clientSecret, refreshToken];
    let written = 0;
    try {
      for (let index = 0; index < SECRET_NAMES.length; index++) {
        const result = await runGh(
          [
            "secret",
            "set",
            SECRET_NAMES[index],
            "--repo",
            `github.com/${repo}`,
            "--env",
            environment,
          ],
          { input: values[index] },
        );
        if (result !== 0) throw failure("Secret upload failed.");
        written++;
      }
    } catch {
      throw failure(
        `GitHub credential upload stopped after ${written} of 3 secrets. Some credentials may have changed; rerun setup before deploying.`,
      );
    }
    log(
      `Google release credentials stored in GitHub environment ${environment} for ${repo}. No tokens were printed or saved to disk.`,
    );
    return { repo, environment, secretsWritten: [...SECRET_NAMES] };
  } finally {
    await receiver.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseAuthorizationArgs(process.argv.slice(2));
    if (options.help)
      console.log(
        "Usage: node scripts/authorize-google-release.js --client /outside/repo/desktop-client.json --repo owner/repository [--environment github-pages] [--no-browser]",
      );
    else await authorizeGoogleRelease(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

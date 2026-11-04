import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://script.googleapis.com/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ID_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
export const MANAGED_SCRIPT_FILES = Object.freeze([
  {
    file: "PwaBridge.gs",
    name: "PwaBridge",
    type: "SERVER_JS",
    entry: "pwaDispatch",
  },
  { file: "PwaBridge.html", name: "PwaBridge", type: "HTML" },
  {
    file: "Workspace.gs",
    name: "Workspace",
    type: "SERVER_JS",
    entry: "workspaceDispatch_",
  },
  {
    file: "WorkspaceNotifications.gs",
    name: "WorkspaceNotifications",
    type: "SERVER_JS",
    entry: "workspaceNotification_",
  },
]);

function failure(message) {
  // Never attach a network cause, response body, remote source, or credentials.
  return new Error(message);
}

export function validateReleaseEnvironment(env) {
  const value = {};
  for (const name of ["APPS_SCRIPT_ID", "APPS_SCRIPT_DEPLOYMENT_ID"]) {
    if (typeof env[name] !== "string" || !ID_PATTERN.test(env[name]))
      throw failure(`Set a valid ${name}; no deployment was attempted.`);
    value[name] = env[name];
  }
  for (const name of [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REFRESH_TOKEN",
  ]) {
    const secret = typeof env[name] === "string" ? env[name].trim() : "";
    if (!secret || secret.length > 20000 || /[\r\n\x00]/.test(secret))
      throw failure(
        `Configure ${name} in GitHub Actions Secrets; no deployment was attempted.`,
      );
    value[name] = secret;
  }
  if (env.GITHUB_SHA && !/^[a-f0-9]{40,64}$/i.test(env.GITHUB_SHA))
    throw failure("GITHUB_SHA is not a valid commit identifier.");
  value.GITHUB_SHA = env.GITHUB_SHA || "";
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function scriptFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 500)
    throw failure(
      "The existing Apps Script project has no valid complete file set.",
    );
  const keys = new Set();
  let length = 0;
  return files.map((file) => {
    if (
      !file ||
      typeof file.name !== "string" ||
      !file.name ||
      file.name.length > 200 ||
      !["SERVER_JS", "HTML", "JSON"].includes(file.type) ||
      (file.source !== undefined && typeof file.source !== "string")
    )
      throw failure(
        "The existing Apps Script project contains unsupported file metadata.",
      );
    const key = `${file.type}:${file.name}`;
    if (keys.has(key))
      throw failure(
        "The existing Apps Script project contains duplicate files.",
      );
    keys.add(key);
    const source = file.source ?? "";
    length += source.length;
    if (length > 20000000)
      throw failure("The Apps Script source exceeds the release safety limit.");
    // File.functionSet and future read-only API metadata must not be uploaded.
    return { name: file.name, type: file.type, source };
  });
}
function filesFingerprint(files) {
  return fingerprint(
    scriptFiles(files).sort((a, b) =>
      `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`),
    ),
  );
}
function originalsFingerprint(files) {
  return filesFingerprint(
    scriptFiles(files).filter((file) => !managedDescriptor(file)),
  );
}
function managedDescriptor(file) {
  const base = file.name.replace(/(?:\.(?:gs|html))+$/i, "");
  const candidates = MANAGED_SCRIPT_FILES.filter(
    (entry) => entry.name.toLowerCase() === base.toLowerCase(),
  );
  if (!candidates.length) return null;
  const entry = candidates.find((candidate) => candidate.type === file.type);
  if (!entry)
    throw failure(
      "A managed Apps Script filename has an unexpected file type; resolve the collision before releasing.",
    );
  if (entry.type === "HTML" && file.name !== entry.name)
    throw failure(
      "The bridge HTML file must be named PwaBridge (without an extra extension) for the existing template hook.",
    );
  if (
    entry.type === "SERVER_JS" &&
    !new RegExp(`^${entry.name}(?:\\.gs)*$`, "i").test(file.name)
  )
    throw failure(
      "A managed server filename has an unexpected extension; resolve it before releasing.",
    );
  return entry;
}

export function manifestFor(files) {
  const manifests = scriptFiles(files).filter(
    (file) => file.type === "JSON" && file.name === "appsscript",
  );
  if (manifests.length !== 1)
    throw failure(
      "The existing project must contain its appsscript JSON manifest.",
    );
  let manifest;
  try {
    manifest = JSON.parse(manifests[0].source);
  } catch {
    throw failure(
      "The existing appsscript manifest is not valid JSON; it was not changed.",
    );
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw failure(
      "The existing appsscript manifest is invalid; it was not changed.",
    );
  if (manifest.runtimeVersion && manifest.runtimeVersion !== "V8")
    throw failure(
      "The existing project must use the Apps Script V8 runtime before releasing this code.",
    );
  return manifest;
}

export function mergeScriptFiles(remoteFiles, managedFiles) {
  const files = scriptFiles(remoteFiles);
  manifestFor(files);
  const found = new Map();
  const originals = [];
  for (const file of files) {
    const managed = managedDescriptor(file);
    if (managed) {
      if (found.has(managed.file))
        throw failure(
          "Multiple aliases of a managed Apps Script file exist. Resolve duplicates in the editor before releasing.",
        );
      found.set(managed.file, file);
    } else originals.push(file);
  }
  const source = originals
    .filter((file) => file.type === "SERVER_JS")
    .map((file) => file.source)
    .join("\n");
  for (const name of [
    "doGet",
    "webLogin",
    "webAuth_",
    "book_",
    "rows_",
    "totalState_",
    "v3Lock_",
    "v5Decode_",
  ])
    if (!new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(source))
      throw failure(
        `The selected project lacks the original VARKA ${name} function. Check APPS_SCRIPT_ID; no source was uploaded.`,
      );
  if (!/\bpwaPage_\s*\(/.test(source))
    throw failure(
      "The original doGet bridge hook to pwaPage_ is missing. Complete the one-time bridge setup before releasing.",
    );
  const supplied = Object.keys(managedFiles || {});
  if (
    supplied.length !== MANAGED_SCRIPT_FILES.length ||
    supplied.some(
      (file) => !MANAGED_SCRIPT_FILES.some((entry) => entry.file === file),
    )
  )
    throw failure(
      "Only the four allowlisted repository Apps Script files may be overlaid.",
    );
  for (const entry of MANAGED_SCRIPT_FILES) {
    if (
      typeof managedFiles[entry.file] !== "string" ||
      !managedFiles[entry.file].trim()
    )
      throw failure(
        `The managed repository file ${entry.file} is missing or empty.`,
      );
    if (
      entry.entry &&
      new RegExp(`\\bfunction\\s+${entry.entry}\\s*\\(`).test(source)
    )
      throw failure(
        "An unmanaged file declares a managed entry point. Resolve the duplicate source before releasing.",
      );
  }
  const merged = files.map((file) => {
    const entry = managedDescriptor(file);
    return entry ? { ...file, source: managedFiles[entry.file] } : file;
  });
  for (const entry of MANAGED_SCRIPT_FILES)
    if (!found.has(entry.file))
      merged.push({
        name: entry.name,
        type: entry.type,
        source: managedFiles[entry.file],
      });
  return merged;
}

function deploymentConfiguration(deployment, scriptId, deploymentId) {
  const config = deployment?.deploymentConfig;
  if (
    deployment?.deploymentId !== deploymentId ||
    config?.scriptId !== scriptId ||
    !Number.isSafeInteger(config.versionNumber) ||
    config.versionNumber < 1 ||
    config.manifestFileName !== "appsscript"
  )
    throw failure(
      "The selected existing deployment has an unexpected project, version, or manifest. Check the configured IDs.",
    );
  const expectedUrl = `https://script.google.com/macros/s/${deploymentId}/exec`;
  const webApps = (deployment.entryPoints || []).filter(
    (entry) => entry.entryPointType === "WEB_APP",
  );
  if (
    webApps.length !== 1 ||
    webApps[0].webApp?.url !== expectedUrl ||
    !webApps[0].webApp.entryPointConfig?.access ||
    !webApps[0].webApp.entryPointConfig?.executeAs
  )
    throw failure(
      "The selected deployment is not the existing public-URL VARKA web app. No new deployment will be created.",
    );
  return {
    scriptId: config.scriptId,
    versionNumber: config.versionNumber,
    manifestFileName: config.manifestFileName,
    ...(config.description === undefined
      ? {}
      : { description: config.description }),
  };
}
function entryPointsFingerprint(deployment) {
  return fingerprint(
    [...(deployment.entryPoints || [])].sort((a, b) =>
      JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))),
    ),
  );
}
export function validateDeploymentConfig(
  deployment,
  files,
  scriptId,
  deploymentId,
) {
  const config = deploymentConfiguration(deployment, scriptId, deploymentId);
  const manifest = manifestFor(files);
  const webApp = deployment.entryPoints.find(
    (entry) => entry.entryPointType === "WEB_APP",
  ).webApp.entryPointConfig;
  if (
    !manifest.webapp ||
    !manifest.webapp.access ||
    !manifest.webapp.executeAs ||
    manifest.webapp.access !== webApp.access ||
    manifest.webapp.executeAs !== webApp.executeAs
  )
    throw failure(
      "The appsscript manifest needs explicit webapp access and executeAs matching the existing deployment. Set the matching values once in Apps Script; the release will not fill or broaden permissions.",
    );
  return config;
}

async function loadManagedFiles() {
  return Object.fromEntries(
    await Promise.all(
      MANAGED_SCRIPT_FILES.map(async (entry) => [
        entry.file,
        await readFile(
          new URL(`../apps-script/${entry.file}`, import.meta.url),
          "utf8",
        ),
      ]),
    ),
  );
}

/** All network and output dependencies are injectable; tests never use Google. */
export async function deployAppsScript({
  env = process.env,
  fetchImpl = globalThis.fetch,
  managedFiles,
  log = () => {},
  writeOutput = async () => {},
  timeoutMs = 30000,
} = {}) {
  const settings = validateReleaseEnvironment(env);
  if (typeof fetchImpl !== "function")
    throw failure("A supported Node.js fetch implementation is required.");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw failure(
      "The release request timeout must be between 1 and 60000 milliseconds.",
    );
  const local = managedFiles || (await loadManagedFiles());
  // Validate local inputs before refreshing any credentials.
  for (const entry of MANAGED_SCRIPT_FILES)
    if (typeof local[entry.file] !== "string" || !local[entry.file].trim())
      throw failure(
        `The managed repository file ${entry.file} is missing or empty.`,
      );
  async function jsonRequest(
    url,
    { method = "GET", headers = {}, body } = {},
    stage,
  ) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw failure(
        `${stage}: the request failed or timed out. Any attempted write may have completed; inspect the current project/deployment before retrying. Pages must not be published from this failed run.`,
      );
    }
    if (!response.ok)
      throw failure(
        `${stage}: Google returned HTTP ${Number.isInteger(response.status) ? response.status : "error"}. Response details are withheld to protect credentials and script source. Check authorization, API access, and release settings before retrying.`,
      );
    try {
      return await response.json();
    } catch {
      throw failure(
        `${stage}: Google returned an invalid JSON response. The release stopped without automatic rollback.`,
      );
    }
  }
  log("Authorizing the Apps Script release.");
  const token = await jsonRequest(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: settings.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: settings.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: settings.GOOGLE_OAUTH_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }).toString(),
    },
    "Google authorization",
  );
  if (
    typeof token.access_token !== "string" ||
    !token.access_token ||
    /[\r\n\x00]/.test(token.access_token)
  )
    throw failure(
      "Google authorization returned no valid access token. Renew the owner authorization.",
    );
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
  };
  const project = `${API}/projects/${settings.APPS_SCRIPT_ID}`;
  const deploymentUrl = `${project}/deployments/${settings.APPS_SCRIPT_DEPLOYMENT_ID}`;
  const getContent = (version) =>
    jsonRequest(
      `${project}/content${version ? `?versionNumber=${version}` : ""}`,
      { headers },
      "Read Apps Script content",
    );
  const getDeployment = () =>
    jsonRequest(deploymentUrl, { headers }, "Read existing deployment");
  const existing = await getDeployment();
  const remote = await getContent();
  const initialConfig = validateDeploymentConfig(
    existing,
    remote.files,
    settings.APPS_SCRIPT_ID,
    settings.APPS_SCRIPT_DEPLOYMENT_ID,
  );
  const merged = mergeScriptFiles(remote.files, local);
  const expectedHash = filesFingerprint(merged);
  const originalHash = filesFingerprint(remote.files);
  const deployed = await getContent(initialConfig.versionNumber);
  validateDeploymentConfig(
    existing,
    deployed.files,
    settings.APPS_SCRIPT_ID,
    settings.APPS_SCRIPT_DEPLOYMENT_ID,
  );
  if (
    originalsFingerprint(remote.files) !== originalsFingerprint(deployed.files)
  )
    throw failure(
      "Unmanaged original files or the manifest differ between HEAD and the current deployment. Review and manually deploy those edits first; automation will not publish unreviewed original code.",
    );
  const sameDeployment = (candidate) => {
    const candidateConfig = deploymentConfiguration(
      candidate,
      settings.APPS_SCRIPT_ID,
      settings.APPS_SCRIPT_DEPLOYMENT_ID,
    );
    if (
      fingerprint(candidateConfig) !== fingerprint(initialConfig) ||
      entryPointsFingerprint(candidate) !== entryPointsFingerprint(existing)
    )
      throw failure(
        "The existing deployment changed during this release. Stop and review it; no automatic rollback will overwrite the newer deployment.",
      );
  };
  // updateContent has no compare-and-swap parameter. Recheck immediately before
  // writing, and again after upload/version creation; owner edits should pause.
  if (filesFingerprint((await getContent()).files) !== originalHash)
    throw failure(
      "Apps Script HEAD changed while preparing this release. No source was uploaded; rerun after reviewing the concurrent edit.",
    );
  sameDeployment(await getDeployment());
  if (expectedHash !== originalHash) {
    log(
      "Updating the four managed files while preserving the complete original project.",
    );
    await jsonRequest(
      `${project}/content`,
      { method: "PUT", headers, body: JSON.stringify({ files: merged }) },
      "Upload Apps Script source",
    );
  }
  if (filesFingerprint((await getContent()).files) !== expectedHash)
    throw failure(
      "Apps Script HEAD does not match the intended merged release. No version was deployed; inspect concurrent edits before retrying.",
    );
  let versionNumber = initialConfig.versionNumber;
  let changed = false;
  if (filesFingerprint(deployed.files) !== expectedHash) {
    log("Creating an immutable Apps Script version.");
    const version = await jsonRequest(
      `${project}/versions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          description: settings.GITHUB_SHA
            ? `VARKA GitHub ${settings.GITHUB_SHA}`
            : "VARKA manual release",
        }),
      },
      "Create Apps Script version",
    );
    if (
      !Number.isSafeInteger(version.versionNumber) ||
      version.versionNumber < 1
    )
      throw failure(
        "Google returned no valid immutable version number. No deployment update was attempted.",
      );
    versionNumber = version.versionNumber;
    if (
      filesFingerprint((await getContent(versionNumber)).files) !== expectedHash
    )
      throw failure(
        "The created version does not match the reviewed source. The existing deployment was not updated; inspect concurrent HEAD edits.",
      );
    if (filesFingerprint((await getContent()).files) !== expectedHash)
      throw failure(
        "Apps Script HEAD changed after version creation. The existing deployment was not updated; review the concurrent edit.",
      );
    sameDeployment(await getDeployment());
    await jsonRequest(
      deploymentUrl,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          deploymentConfig: { ...initialConfig, versionNumber },
        }),
      },
      "Update existing Apps Script deployment",
    );
    changed = true;
  }
  const verified = await getDeployment();
  const verifiedConfig = validateDeploymentConfig(
    verified,
    merged,
    settings.APPS_SCRIPT_ID,
    settings.APPS_SCRIPT_DEPLOYMENT_ID,
  );
  if (
    fingerprint(verifiedConfig) !==
      fingerprint({ ...initialConfig, versionNumber }) ||
    entryPointsFingerprint(verified) !== entryPointsFingerprint(existing)
  )
    throw failure(
      "Deployment verification failed: version, URL, or access settings differ. Pages must not be published; inspect the existing deployment without automatic rollback.",
    );
  const result = {
    execUrl: `https://script.google.com/macros/s/${settings.APPS_SCRIPT_DEPLOYMENT_ID}/exec`,
    scriptVersion: versionNumber,
    deploymentId: settings.APPS_SCRIPT_DEPLOYMENT_ID,
    changed,
  };
  await writeOutput(
    `exec_url=${result.execUrl}\nscript_version=${versionNumber}\ndeployment_id=${result.deploymentId}\n`,
  );
  log(
    changed
      ? "Existing Apps Script deployment updated and verified; its URL and access settings are unchanged."
      : "Existing Apps Script deployment already matches this release; its URL and access settings are verified.",
  );
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  deployAppsScript({
    log: (message) => console.log(message),
    writeOutput: async (value) => {
      if (process.env.GITHUB_OUTPUT)
        await appendFile(process.env.GITHUB_OUTPUT, value, { mode: 0o600 });
    },
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

import { fileURLToPath } from "node:url";
import path from "node:path";

export async function requireCurrentMain({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const repository = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  const token = env.GH_TOKEN;
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    typeof sha !== "string" ||
    !/^[a-f0-9]{40}$/i.test(sha) ||
    typeof token !== "string" ||
    !token ||
    /[\r\n\x00]/.test(token)
  )
    throw Error("The current-main check requires a valid GitHub release context.");
  let response;
  let current;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${repository}/git/ref/heads/main`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw Error();
    current = await response.json();
  } catch {
    // Neither the bearer token nor raw GitHub errors belong in release logs.
    throw Error("Could not verify the current main commit. Nothing was deployed.");
  }
  if (current?.object?.type !== "commit" || current.object.sha !== sha)
    throw Error(
      "Main has advanced beyond this tested commit. Release the current main commit instead of an older run.",
    );
  return sha;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  requireCurrentMain().then(
    () => console.log("The tested commit is the current main commit."),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}

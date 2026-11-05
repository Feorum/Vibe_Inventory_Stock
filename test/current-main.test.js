import test from "node:test";
import assert from "node:assert/strict";
import { requireCurrentMain } from "../scripts/require-current-main.js";

const env = {
  GITHUB_REPOSITORY: "Feorum/Vibe_Inventory_Stock",
  GITHUB_SHA: "a".repeat(40),
  GH_TOKEN: "private-fixture-token",
};

test("the current-main gate checks the authenticated exact main commit", async () => {
  const actual = await requireCurrentMain({
    env,
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        "https://api.github.com/repos/Feorum/Vibe_Inventory_Stock/git/ref/heads/main",
      );
      assert.equal(options.headers.Authorization, `Bearer ${env.GH_TOKEN}`);
      assert.equal(options.redirect, "error");
      return {
        ok: true,
        json: async () => ({ object: { type: "commit", sha: env.GITHUB_SHA } }),
      };
    },
  });
  assert.equal(actual, env.GITHUB_SHA);
});

test("an old queued or manually rerun commit cannot replace a newer main release", async () => {
  await assert.rejects(
    requireCurrentMain({
      env,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ object: { type: "commit", sha: "b".repeat(40) } }),
      }),
    }),
    /Main has advanced/,
  );
});

test("missing context and API failures fail closed without disclosing credentials or raw errors", async () => {
  let calls = 0;
  await assert.rejects(
    requireCurrentMain({
      env: { ...env, GH_TOKEN: "" },
      fetchImpl: async () => { calls++; },
    }),
    /valid GitHub release context/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    requireCurrentMain({
      env,
      fetchImpl: async () => { throw Error(env.GH_TOKEN); },
    }),
    (error) => {
      assert.match(error.message, /Could not verify/);
      assert.ok(!error.message.includes(env.GH_TOKEN));
      return true;
    },
  );
  await assert.rejects(
    requireCurrentMain({
      env,
      fetchImpl: async () => ({
        ok: false,
        json: async () => { throw Error("must not read the error body"); },
      }),
    }),
    /Could not verify/,
  );
});

import { assertIsolated } from "./isolation";
assertIsolated();
// Separate from the extension suite: checks the daemon's lifecycle CAS contract.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const binary = process.env.KATA_TEST_EXECUTABLE;
if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to an absolute Kata binary path.");
const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "omp-kata-revisions-"));
const cwd = path.join(scratch, "workspace");
mkdirSync(cwd);
const env: NodeJS.ProcessEnv = { ...process.env, KATA_HOME: path.join(scratch, "khome"), KATA_AUTHOR: "revision-a" };
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_SESSION_ID"]) delete env[key];
function command(args: string[]) { assertIsolated(env); return execFileSync(binary!, args, { cwd, env, timeout: 15000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function kata(args: string[]) { return JSON.parse(command([...args, "--json"])); }
try {
  command(["init", "--project", "revision-conformance"]);
  const original = kata(["create", "Ownership revision contract", "--force-new"]).issue;
  const claimed = kata(["claim", original.short_id, "--if-unowned"]).issue;
  const reassigned = kata(["claim", original.short_id, "--as", "revision-b", "--force"]).issue;
  const closed = kata(["close", original.short_id, "--wontfix", "--message", "Retired the isolated ownership revision conformance fixture after validating the daemon contract."]).issue;
  const reopened = kata(["reopen", original.short_id]).issue;
  const ownerChangeInvalidatesCAS = claimed.owner === "revision-a" && reassigned.owner === "revision-b" && claimed.revision > original.revision && reassigned.revision > claimed.revision;
  const closureInvalidatesCAS = closed.status === "closed" && closed.revision > reassigned.revision;
  const reopenAdvancesOnce = reopened.status === "open" && reopened.revision === closed.revision + 1;
  console.log(JSON.stringify({ binary, version: command(["version"]).trim(), scratch, revisions: [original.revision, claimed.revision, reassigned.revision, closed.revision, reopened.revision], ownerChangeInvalidatesCAS, closureInvalidatesCAS, reopenAdvancesOnce }, null, 2));
  if (!ownerChangeInvalidatesCAS || !closureInvalidatesCAS || !reopenAdvancesOnce) process.exitCode = 1;
} finally { command(["daemon", "stop"]); }

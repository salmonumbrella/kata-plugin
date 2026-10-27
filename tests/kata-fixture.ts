import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertIsolated } from "./isolation";

const exec = promisify(execFile);
export function isolatedKata(binary: string, env: NodeJS.ProcessEnv, cwd: string, defaultTimeout = 5000) {
  return async (args: string[], workspace = cwd, timeout = defaultTimeout) => {
    assertIsolated(env);
    try { return { ...await exec(binary, args, { env, cwd: workspace, timeout }), code: 0, killed: false }; }
    catch (error: any) { return { stdout: error.stdout || "", stderr: error.stderr || error.message, code: error.code || 1, killed: !!error.killed }; }
  };
}

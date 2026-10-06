import { expect, test } from "bun:test";
import { assertIsolated } from "./isolation";
import { kataCommands } from "../kata";
assertIsolated();

test("only command positions are Kata invocations", () => {
  const command = `echo 'kata --as actor-b'; KATA_HOME=/tmp/store kata claim abc && command '/opt/homebrew/bin/kata' list`;
  expect(kataCommands(command).map(c => c.words.map(w => w.value))).toEqual([["claim", "abc"], ["list"]]);
});
test("quoted heredoc text is never a Kata command", () => {
  const command = "cat <<'DOC'\nkata --as fake claim xyz\nDOC\nkata list";
  expect(kataCommands(command).map(c => c.words.map(w => w.value))).toEqual([["list"]]);
});
test("the configured executable variable is recognized without evaluating shell code", () => {
  expect(kataCommands('"$KATA_OMP_EXECUTABLE" list')).toHaveLength(1);
  expect(kataCommands('"${KATA_OMP_EXECUTABLE}" list')).toHaveLength(1);
});

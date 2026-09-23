const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => {
  const mod = await import("../../src/services/tools/runCommandTool.ts");
  // Most tests care about the behaviour, not the description.
  return { ...mod, runCommandTool: mod.createRunCommandTool() };
};

function stubBridge(runCommand) {
  global.window = { electronAPI: runCommand ? { runCommand } : {} };
}

test("the command is handed to the main process untouched", async () => {
  const { runCommandTool } = await load();
  const calls = [];
  stubBridge(async (request) => {
    calls.push(request);
    return { ok: true, message: "Launched `code`." };
  });

  const result = await runCommandTool.execute({ command: "  code ~/notes.md  " });

  assert.deepEqual(calls, ["code ~/notes.md"]);
  assert.deepEqual(result, {
    success: true,
    data: { command: "code ~/notes.md", status: "launched" },
    displayText: "Launched `code`.",
  });
});

test("a refusal comes back as a failed tool call carrying the reason", async () => {
  const { runCommandTool } = await load();
  stubBridge(async () => ({ ok: false, message: "Declined — nothing was run." }));

  const result = await runCommandTool.execute({ command: "xterm" });

  assert.equal(result.success, false);
  assert.equal(result.data, null);
  assert.equal(result.displayText, "Declined — nothing was run.");
});

test("an empty or non-string command never reaches main", async () => {
  const { runCommandTool } = await load();
  let called = false;
  stubBridge(async () => {
    called = true;
    return { ok: true, message: "" };
  });

  for (const command of ["", "   ", 42, null, undefined, {}]) {
    const result = await runCommandTool.execute({ command });
    assert.equal(result.success, false);
  }
  assert.equal(called, false);
});

test("a build without the bridge fails rather than throwing", async () => {
  const { runCommandTool } = await load();
  stubBridge(null);

  const result = await runCommandTool.execute({ command: "code" });

  assert.equal(result.success, false);
  assert.match(result.displayText, /unavailable/);
});

test("captured output rides in data — which is what the model reads", async () => {
  const { runCommandTool } = await load();
  stubBridge(async () => ({
    ok: true,
    message: "Ran `ls /etc`:",
    capture: { output: "hosts\npasswd\n", exitCode: 0, timedOut: false, truncated: false },
  }));

  const result = await runCommandTool.execute({ command: "ls /etc" });

  // The cloud path stringifies `data` and the AI-SDK path returns it directly;
  // `displayText` only reaches the card. So the output has to be in both.
  assert.equal(result.data.status, "ran");
  assert.equal(result.data.output, "hosts\npasswd\n");
  assert.equal(result.data.exitCode, 0);
  assert.match(result.displayText, /hosts/);
});

test("a launch with no output is unchanged", async () => {
  const { runCommandTool } = await load();
  stubBridge(async () => ({ ok: true, message: "Launched `code`." }));

  const result = await runCommandTool.execute({ command: "code" });

  assert.deepEqual(result.data, { command: "code", status: "launched" });
  assert.equal(result.displayText, "Launched `code`.");
});

test("long output is capped on both paths", async () => {
  const { runCommandTool } = await load();
  const output = "x".repeat(9000);
  stubBridge(async () => ({
    ok: true,
    message: "Ran `ls -R`:",
    capture: { output, exitCode: 0, timedOut: false, truncated: false },
  }));

  const result = await runCommandTool.execute({ command: "ls -R" });

  // A local model's window is small: the full 9 KB would crowd out the very
  // conversation it is meant to answer.
  assert.equal(result.data.output.length, 1500);
  assert.equal(result.data.truncated, true);
  assert.ok(result.displayText.length < 4200, "the card is bounded too");
});

test("the tool declares its side effect and its one parameter", async () => {
  const { runCommandTool } = await load();

  assert.equal(runCommandTool.name, "run_command");
  assert.equal(runCommandTool.readOnly, false);
  assert.deepEqual(runCommandTool.parameters.required, ["command"]);
  assert.equal(runCommandTool.parameters.additionalProperties, false);
});

test("the description names what the user registered, and nothing behind it", async () => {
  const { createRunCommandTool } = await load();

  const tool = createRunCommandTool({ names: ["weather", "search", "vscode"] });

  assert.match(tool.description, /registered these names: weather, search, vscode/);
  // The reason the names are there at all: without them a model asked about the
  // weather sends `search for weather`, which matches the user's *search* alias
  // and opens a web search instead of the page they configured.
  assert.match(tool.description, /how's the weather/);
  assert.match(tool.parameters.properties.command.description, /weather/);
});

test("no registered names means no list in the description", async () => {
  const { createRunCommandTool } = await load();

  // The feature is off when the file is absent, and an empty "registered these
  // names:" would tell the model there is a list when there isn't.
  assert.doesNotMatch(createRunCommandTool().description, /registered these names/);
  assert.doesNotMatch(createRunCommandTool({ names: [] }).description, /registered these names/);
});

test("the tool survives the system-prompt builder", async () => {
  // getAgentSystemPrompt drops any tool missing from TOOL_INSTRUCTIONS, which
  // would leave run_command registered but invisible to the model — a silent
  // failure nothing else would catch.
  const { getAgentSystemPrompt } = await import("../../src/config/prompts.ts");
  const { runCommandTool } = await load();

  const prompt = getAgentSystemPrompt([runCommandTool.name]);

  assert.match(prompt, /run_command/);
  assert.match(prompt, /registered name/);
});

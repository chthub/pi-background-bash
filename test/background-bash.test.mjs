import { test } from "node:test";
import assert from "node:assert/strict";
import { createMock, createControllableBrain, script, text, toolCall } from "./harness/index.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const EXT = new URL("../extensions/background-bash.ts", import.meta.url).pathname;
const PBB_CLI = new URL("../bin/pbb.js", import.meta.url).pathname;
const PIL_CLI = new URL("../node_modules/pi-lane/bin/pil.js", import.meta.url).pathname;
const TIMEOUT = 45_000;
const PI_BINARY = resolvePiBinary();
const CODEMODE_RESULT_PREFIX = "PBB_CODEMODE_RESULT=";

function resolvePiBinary() {
  if (process.env.PBB_TEST_PI_BINARY) return resolve(process.env.PBB_TEST_PI_BINARY);
  // Read the installed package's actual bin entry: recent Pi releases bundle
  // the CLI under dist/bundle, and a global `pi` may be a different version.
  let directory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  while (true) {
    const packagePath = join(directory, "package.json");
    if (existsSync(packagePath)) {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent" && pkg.bin?.pi) {
        return join(directory, pkg.bin.pi);
      }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot resolve the installed Pi CLI");
    directory = parent;
  }
}

const bg = (command, timeout) =>
  toolCall("bash", timeout == null ? { command, background: true } : { command, timeout, background: true });

const sh = (command, timeout) =>
  toolCall("bash", timeout == null ? { command } : { command, timeout });

const shBg = (command, timeout) =>
  toolCall("bash", timeout == null ? { command, background: true } : { command, timeout, background: true });

function requestText(req) {
  return JSON.stringify(req);
}

function messageTexts(req) {
  const out = [];
  for (const message of req.messages ?? []) {
    if (typeof message.content === "string") {
      out.push(message.content);
      continue;
    }
    for (const part of message.content ?? []) {
      if (typeof part.text === "string") out.push(part.text);
      if (typeof part.content === "string") out.push(part.content);
    }
  }
  return out;
}

function backgroundResultTexts(req) {
  return messageTexts(req).filter((text) => text.includes('<pi_context source="pi-background-bash" kind="background_bash_result"'));
}

function backgroundResultText(req) {
  return backgroundResultTexts(req).at(-1) ?? "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readSessionEntries(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function createBgMock(brain, options = {}) {
  const { extensions = [], ...rest } = options;
  return createMock({
    brain,
    piBinary: PI_BINARY,
    extensions: [EXT, ...extensions],
    // pi-mock's Anthropic route misses Pi's /v1/v1/messages?beta=true URL;
    // use its OpenAI Responses route to exercise the extension instead.
    piProvider: "openai",
    piModel: "gpt-4o",
    startupTimeoutMs: 20_000,
    runTimeoutMs: TIMEOUT,
    ...rest,
  });
}

function codemode(code) {
  return toolCall("codemode", { code });
}

function codemodeJson(events) {
  const result = events.find((event) => event.type === "tool_execution_end" && event.toolName === "codemode");
  assert.ok(result, "expected a real codemode tool result");
  assert.equal(result.isError, false, JSON.stringify(result.result));
  const output = result.result.content.find((part) => part.type === "text" && part.text.startsWith(CODEMODE_RESULT_PREFIX));
  assert.ok(output, `missing codemode JSON output: ${JSON.stringify(result.result)}`);
  return JSON.parse(output.text.slice(CODEMODE_RESULT_PREFIX.length));
}

function assertCompletedResult(value, output, exitCode = 0) {
  assert.equal(typeof value, "object");
  assert.equal(value.status, "completed");
  assert.equal(value.output, output);
  assert.equal(value.exit_code, exitCode);
  assert.equal(value.truncated, false);
  assert.equal(typeof value.wall_time_seconds, "number");
  assert.ok(Number.isFinite(value.wall_time_seconds) && value.wall_time_seconds >= 0);
  assert.equal(value.full_output_path, undefined);
}

const CODEMODE_PI_ARGS = ["-e", "builtin:codemode", "--tools", "bash,codemode"];

function createCodemodeMock(brain, options) {
  return createBgMock(brain, {
    ...options,
    piArgs: CODEMODE_PI_ARGS,
    env: { HOME: options.cwd, PBB_ROOT: join(options.cwd, "pbb"), ...options.env },
  });
}

function makeConfiguredCwd(config) {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-cwd-${process.pid}-${Date.now()}-`));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "background-bash.json"), JSON.stringify(config));
  return dir;
}

async function waitForCondition(predicate, timeoutMs = TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

for (const autoBackgroundAfterSeconds of [0, 5]) {
  test(`codemode bash resolves completed objects preserving whitespace, stderr, and empty output (auto ${autoBackgroundAfterSeconds}s)`, async () => {
    const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds });
    const commands = ["printf '  codemode-ok \\n\\n'", ":", "printf '\\tstderr-only \\n' >&2"];
    const mock = await createCodemodeMock(script(
      codemode(`
        const values = [];
        for (const command of ${JSON.stringify(commands)}) values.push(await tools.bash({ command }));
        text(${JSON.stringify(CODEMODE_RESULT_PREFIX)} + JSON.stringify(values));
      `),
      text("checked completed bash objects"),
    ), { cwd });

    try {
      const values = codemodeJson(await mock.run("inspect programmatic bash results", TIMEOUT));
      assert.equal(values.length, 3);
      assertCompletedResult(values[0], "  codemode-ok \n\n");
      assertCompletedResult(values[1], "");
      assertCompletedResult(values[2], "\tstderr-only \n");
    } finally {
      await mock.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

for (const autoBackgroundAfterSeconds of [0, 5]) {
  test(`codemode bash resolves nonzero exits while direct bash remains an error result (auto ${autoBackgroundAfterSeconds}s)`, async () => {
    const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds });
    const command = "printf 'exit-seven\\n'; exit 7";
    const mock = await createCodemodeMock(script(
      codemode(`text(${JSON.stringify(CODEMODE_RESULT_PREFIX)} + JSON.stringify(await tools.bash({ command: ${JSON.stringify(command)} })));`),
      sh(command),
      text("checked both nonzero exit contracts"),
    ), { cwd });

    try {
      const events = await mock.run("inspect exit seven through codemode and direct bash", TIMEOUT);
      assertCompletedResult(codemodeJson(events), "exit-seven\n", 7);
      const direct = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "bash").at(-1);
      assert.ok(direct, "expected direct bash result");
      assert.equal(direct.isError, true);
      assert.match(JSON.stringify(direct.result.content), /Command exited with code 7/);
      assertCompletedResult(direct.result.structuredContent, "exit-seven\n", 7);
    } finally {
      await mock.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("codemode bash caps structured output at its UTF-8 boundaries and saves the full snapshot", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 0 });
  // Both 512 KiB cuts bisect a multibyte character. Keep the large value inside
  // codemode so Pi's separate model-facing output cap does not hide a failure.
  const command = "python3 - <<'PY'\nimport sys\nsys.stdout.write('X' + '\u{1f642}' * 140000 + 'MIDDLE_OMITTED' + '\u20ac' * 200000)\nPY";
  const mock = await createCodemodeMock(script(
    codemode(`
      const value = await tools.bash({ command: ${JSON.stringify(command)} });
      const expected = 'X' + '\u{1f642}'.repeat(Math.floor((512 * 1024 - 1) / 4))
        + '\\n[... output omitted ...]\\n' + '\u20ac'.repeat(Math.floor(512 * 1024 / 3));
      text(${JSON.stringify(CODEMODE_RESULT_PREFIX)} + JSON.stringify({
        ...value, output: undefined, output_length: value.output.length,
        exact_head_tail: value.output === expected,
        has_replacement_character: value.output.includes('\ufffd'),
      }));
    `),
    text("checked bounded structured output"),
  ), { cwd });
  let fullOutputPath;

  try {
    const value = codemodeJson(await mock.run("inspect large Unicode bash output", TIMEOUT));
    fullOutputPath = value.full_output_path;
    assert.equal(value.status, "completed");
    assert.equal(value.exit_code, 0);
    assert.equal(value.truncated, true);
    assert.equal(value.exact_head_tail, true);
    assert.equal(value.has_replacement_character, false);
    assert.ok(value.output_length < 1024 * 1024 + 128);
    assert.equal(typeof value.wall_time_seconds, "number");
    assert.equal(typeof fullOutputPath, "string");
    assert.equal(readFileSync(fullOutputPath, "utf8"), "X" + "\u{1f642}".repeat(140000) + "MIDDLE_OMITTED" + "\u20ac".repeat(200000));
  } finally {
    await mock.close();
    if (fullOutputPath) rmSync(fullOutputPath, { force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const explicit of [true, false]) {
  const mode = explicit ? "explicit" : "automatic";
  test(`codemode bash ${mode} backgrounding returns running acknowledgement before completion`, async () => {
    const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: explicit ? 5 : 0.1 });
    const command = `printf 'early-output\\n'; sleep 0.5; printf '${mode}-codemode-done\\n'`;
    const args = explicit ? { command, background: true } : { command };
    const mock = await createCodemodeMock(script(
      codemode(`text(${JSON.stringify(CODEMODE_RESULT_PREFIX)} + JSON.stringify(await tools.bash(${JSON.stringify(args)})));`),
      text("received background acknowledgement"),
      text("received actual background completion"),
    ), { cwd });

    try {
      const value = codemodeJson(await mock.run(`inspect ${mode} background bash acknowledgement`, TIMEOUT));
      assert.equal(value.status, "running");
      assert.equal(value.output, "");
      assert.equal(value.exit_code, null);
      assert.equal(value.truncated, false);
      assert.equal(value.job_id, "bg001");
      assert.equal(typeof value.wall_time_seconds, "number");
      assert.ok(value.wall_time_seconds >= 0);
      assert.equal(value.full_output_path, undefined);

      const { request } = await mock.waitForRequest((req) => backgroundResultText(req).includes(`${mode}-codemode-done`), TIMEOUT);
      const completion = backgroundResultText(request);
      assert.match(completion, /id="bg001"/);
      assert.match(completion, /outcome="exit"/);
      assert.match(completion, /exit_code="0"/);
      assert.match(completion, /early-output/);
      assert.match(completion, new RegExp(`${mode}-codemode-done`));
    } finally {
      await mock.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

for (const autoBackgroundAfterSeconds of [0, 5]) {
  test(`codemode bash timeout rejects instead of resolving a completed result (auto ${autoBackgroundAfterSeconds}s)`, async () => {
    const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds });
    const mock = await createCodemodeMock(script(
      codemode(`
        try {
          const value = await tools.bash({ command: 'sleep 5', timeout: 0.2 });
          text(${JSON.stringify(CODEMODE_RESULT_PREFIX)} + JSON.stringify({ rejected: false, value }));
        } catch (error) {
          text(${JSON.stringify(CODEMODE_RESULT_PREFIX)} + JSON.stringify({ rejected: true, message: String(error) }));
        }
      `),
      text("checked timeout rejection"),
    ), { cwd });

    try {
      const result = codemodeJson(await mock.run("inspect timeout rejection", TIMEOUT));
      assert.equal(result.rejected, true);
      assert.match(result.message, /Command timed out after 0\.2 seconds/);
      assert.equal(result.value, undefined);
    } finally {
      await mock.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("codemode bash abort fails the script and terminates the foreground process", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 0 });
  const pidPath = join(cwd, "abort.pid");
  const marker = join(cwd, "should-not-finish");
  const command = "printf '%s' \"$$\" > abort.pid; sleep 30; printf finished > should-not-finish";
  const mock = await createCodemodeMock(script(
    codemode(`text(${JSON.stringify(CODEMODE_RESULT_PREFIX)} + JSON.stringify(await tools.bash({ command: ${JSON.stringify(command)} })));`),
    text("abort must not produce a normal continuation"),
  ), { cwd });

  try {
    await mock.prompt("start a foreground command then abort it");
    const pid = await waitForCondition(() => existsSync(pidPath) && Number(readFileSync(pidPath, "utf8")));
    await mock.abort();
    const result = await mock.waitFor((event) => event.type === "tool_execution_end" && event.toolName === "codemode", TIMEOUT);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.result.content), /abort|cancel/i);
    assert.doesNotMatch(JSON.stringify(result.result.content), /PBB_CODEMODE_RESULT=/);
    await waitForCondition(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
      }
    });
    assert.equal(existsSync(marker), false);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash override returns normal results before the auto-background threshold", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 5 });
  const mock = await createBgMock(script(
    sh("echo foreground"),
    text("saw foreground result"),
  ), { cwd });

  try {
    const events = await mock.run("run a quick bash command", TIMEOUT);
    const toolResults = events.filter((event) => event.type === "tool_execution_end");
    assert.match(JSON.stringify(toolResults), /foreground/);
    assert.doesNotMatch(JSON.stringify(toolResults), /moved to background/);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash override truncates verbose foreground results before they enter model context", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 5 });
  const command = "python3 - <<'PY'\nfor i in range(10000):\n    print(f'VERBOSE_LINE_{i:05d} ' + 'x' * 80)\nPY";
  const mock = await createBgMock(script(
    sh(command),
    text("saw truncated foreground result"),
  ), { cwd });

  try {
    await mock.run("run a verbose quick bash command", TIMEOUT);
    const request = requestText(mock.requests.at(-1));
    assert.match(request, /Full output: \/.*\.log/);
    assert.match(request, /VERBOSE_LINE_09999/);
    assert.doesNotMatch(request, /VERBOSE_LINE_00000/);
    assert.ok(request.length < 180_000, `foreground result sent to the model was not capped enough (${request.length} chars)`);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("context guard trims oversized historical tool results before replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-context-guard-${process.pid}-${Date.now()}-`));
  const sessionFile = join(dir, "session.jsonl");
  const now = new Date().toISOString();
  const toolCallId = "call_contextGuard123|fc_contextGuard456";
  const hugeResult = [
    "HUGE_CONTEXT_START should be trimmed away",
    ...Array.from({ length: 6000 }, (_, i) => `HUGE_CONTEXT_LINE_${String(i).padStart(5, "0")} ${"x".repeat(80)}`),
    "HUGE_CONTEXT_END should remain",
  ].join("\n");
  const entries = [
    { type: "session", version: 3, id: "context-guard-session", timestamp: now, cwd: dir },
    {
      type: "message",
      id: "user-root",
      parentId: null,
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "run huge historical command" }], timestamp: Date.now() },
    },
    {
      type: "message",
      id: "assistant-call",
      parentId: "user-root",
      timestamp: now,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "python huge.py" } }],
        stopReason: "toolUse",
        provider: "faux",
        api: "faux",
        model: "faux",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "huge-result",
      parentId: "assistant-call",
      timestamp: now,
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "bash",
        content: [{ type: "text", text: hugeResult }],
        details: {},
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "followup-user",
      parentId: "huge-result",
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "continue after huge output" }], timestamp: Date.now() },
    },
  ];
  writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const mock = await createBgMock(script(
    text("context guard kept request small"),
  ), { sessionFile, cwd: dir });

  try {
    await mock.run("continue after huge historical output", TIMEOUT);
    const request = requestText(mock.requests.at(-1));
    // Newer Pi may compact the old result before our context guard runs.
    assert.ok(request.includes("bash result trimmed by pi-background-bash context guard") || request.includes("context guard kept request small"));
    if (request.includes("bash result trimmed by pi-background-bash context guard")) {
      assert.match(request, /HUGE_CONTEXT_END should remain/);
    }
    assert.doesNotMatch(request, /HUGE_CONTEXT_START should be trimmed away/);
    assert.ok(request.length < 180_000, `historical tool result was not capped enough (${request.length} chars)`);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash override preserves shell semantics, cwd, environment, redirects, pipes, and subshells", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 5 });
  const mock = await createBgMock(script(
    sh("printf 'env=%s cwd=%s pipe=' \"$PBB_TEST_VAR\" \"$(pwd)\"; printf hi | tr a-z A-Z; printf ' redirect='; echo redirected > out.txt; cat out.txt; printf ' subshell='; (printf sub); set -e; true"),
    text("saw shell semantics"),
  ), { cwd, env: { PBB_TEST_VAR: "env-ok" } });

  try {
    const events = await mock.run("run shell semantics characterization", TIMEOUT);
    const all = JSON.stringify(events);
    assert.match(all, /env=env-ok/);
    assert.match(all, new RegExp(`cwd=${escapeRegExp(realpathSync(cwd))}`));
    assert.match(all, /pipe=HI/);
    assert.match(all, /redirect=redirected/);
    assert.match(all, /subshell=sub/);
    assert.equal(readFileSync(join(cwd, "out.txt"), "utf8").trim(), "redirected");
    assert.doesNotMatch(JSON.stringify(events.filter((event) => event.type === "tool_execution_end")), /moved to background/);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash override automatically moves slow commands to background and injects final result", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 0.1 });
  const mock = await createBgMock(script(
    sh("sleep 0.3; echo auto-done"),
    text("initial turn complete"),
    text("saw auto background result"),
  ), { cwd });

  try {
    const events = await mock.run("run a slow bash command", TIMEOUT);
    const all = JSON.stringify(events);
    assert.match(all, /Bash job bg001 moved to background after 0\.1s\./);

    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /<pi_context source="pi-background-bash" kind="background_bash_result" id="bg001"/);
    assert.match(textReq, /tool_call_id="[^"]+"/);
    assert.match(textReq, /command="sleep 0\.3; echo auto-done"/);
    assert.match(textReq, /outcome="exit"/);
    assert.match(textReq, /exit_code="0"/);
    assert.match(textReq, /auto-done/);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash background true starts immediately in background and injects final result", async () => {
  const mock = await createBgMock(script(
    shBg("sleep 0.2; echo explicit-bg-done"),
    text("initial turn complete"),
    text("saw explicit background result"),
  ));

  try {
    const events = await mock.run("run a bash command explicitly in the background", TIMEOUT);
    const all = JSON.stringify(events);
    assert.match(all, /Bash job bg001 started in background\./);
    assert.doesNotMatch(all, /moved to background after/);

    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /id="bg001"/);
    assert.match(textReq, /command="sleep 0\.2; echo explicit-bg-done"/);
    assert.match(textReq, /explicit-bg-done/);
  } finally {
    await mock.close();
  }
});

test("bash background true returns immediately, then injects completion and triggers a turn", async () => {
  const mock = await createBgMock(script(
    bg("sleep 0.1; echo done"),
    text("initial turn complete"),
    text("saw background result"),
  ));

  try {
    const events = await mock.run("start a background command", TIMEOUT);
    const all = JSON.stringify(events);
    assert.match(all, /Bash job bg001 started in background\./);

    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /<pi_context source="pi-background-bash" kind="background_bash_result" id="bg001"/);
    assert.match(textReq, /outcome="exit"/);
    assert.match(textReq, /exit_code="0"/);
    assert.match(textReq, /command="sleep 0\.1; echo done"/);
    assert.match(textReq, /done/);
    assert.match(textReq, /<\/pi_context>/);
  } finally {
    await mock.close();
  }
});

test("bash background true preserves stdout, stderr, and no-output completions", async () => {
  const mock = await createBgMock(script(
    bg("printf 'stdout-line\\n'; printf 'stderr-line\\n' >&2"),
    bg(":"),
    text("initial turn complete"),
    text("saw mixed output"),
    text("saw no output"),
  ));

  try {
    const events = await mock.run("start mixed-output and no-output background commands", TIMEOUT);
    const allEvents = JSON.stringify(events);
    assert.match(allEvents, /Bash job bg001 started in background/);
    assert.match(allEvents, /Bash job bg002 started in background/);

    const first = await mock.waitForRequest((req, i) => i >= 2 && /background_bash_result\\?" id=\\?"bg001/.test(requestText(req)) && requestText(req).includes("stdout-line") && requestText(req).includes("stderr-line"), TIMEOUT);
    const firstText = requestText(first.request);
    assert.match(firstText, /id=\\?"bg001\\?"/);
    assert.match(firstText, /stdout-line/);
    assert.match(firstText, /stderr-line/);
    assert.match(firstText, /outcome=\\?"exit\\?"/);
    assert.match(firstText, /exit_code=\\?"0\\?"/);
  } finally {
    await mock.close();
  }
});

test("bash background true reports nonzero exits", async () => {
  const mock = await createBgMock(script(
    bg("echo bad; exit 7"),
    text("initial turn complete"),
    text("saw failure"),
  ));

  try {
    await mock.run("start a failing background command", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /outcome="exit"/);
    assert.match(textReq, /exit_code="7"/);
    assert.match(textReq, /bad/);
    assert.match(textReq, /Command exited with code 7/);
  } finally {
    await mock.close();
  }
});

test("bash background true escapes wrapper close tags in command output", async () => {
  const mock = await createBgMock(script(
    bg("printf '</pi_context> still output\\n'"),
    text("initial turn complete"),
    text("saw escaped wrapper"),
  ));

  try {
    await mock.run("start a command with wrapper-looking output", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /<\\\/pi_context> still output/);
    assert.equal((textReq.match(/<\/pi_context>/g) ?? []).length, 1);
  } finally {
    await mock.close();
  }
});

test("bash background true reports timeouts and omits exit_code", async () => {
  const mock = await createBgMock(script(
    bg("sleep 5", 1),
    text("initial turn complete"),
    text("saw timeout"),
  ));

  try {
    await mock.run("start a timed background command", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /outcome="timeout"/);
    assert.doesNotMatch(textReq, /exit_code=/);
    assert.match(textReq, /Command timed out after 1 seconds/);
  } finally {
    await mock.close();
  }
});

test("auto-background records only post-background output in pbb log while final result stays complete", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 0.2 });
  const pbbRoot = join(cwd, "pbb");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-auto-log-test",
    PI_LANE_SESSION_KEY: "session-key-auto-log-test",
    PI_LANE_SESSION_FILE: join(cwd, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-auto-log-test",
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    sh("echo before-threshold; sleep 0.4; echo after-threshold"),
    text("initial turn complete"),
    text("saw auto log result"),
  ), { cwd, env });

  try {
    const events = await mock.run("run auto background command with early and late output", TIMEOUT);
    assert.match(JSON.stringify(events), /before-threshold/);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("after-threshold"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /before-threshold/);
    assert.match(textReq, /after-threshold/);
    const jobPath = join(pbbRoot, "sessions", "session-key-auto-log-test", "instances", "instance-auto-log-test", "jobs", "bg001.json");
    const logPath = join(pbbRoot, "sessions", "session-key-auto-log-test", "instances", "instance-auto-log-test", "logs", "bg001.log");
    await waitForCondition(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("after-threshold"));
    assert.match(readFileSync(logPath, "utf8"), /after-threshold/);
    const job = JSON.parse(readFileSync(jobPath, "utf8"));
    assert.equal(job.jobId, "bg001");
    assert.equal(job.runner, "pbb");
    assert.equal(typeof job.pid, "number");
    assert.equal(typeof job.pgid, "number");
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("background log is reset when a job id is reused in a later runtime", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 5 });
  const pbbRoot = join(cwd, "pbb");
  const sessionKey = "session-key-reused-log-test";
  const instanceId = "instance-reused-log-test";
  const logDir = join(pbbRoot, "sessions", sessionKey, "instances", instanceId, "logs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "bg001.log"), "stale-previous-job-output\n");

  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-reused-log-test",
    PI_LANE_SESSION_KEY: sessionKey,
    PI_LANE_SESSION_FILE: join(cwd, "session.jsonl"),
    PI_LANE_INSTANCE_ID: instanceId,
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    bg("sleep 0.1; echo fresh-reused-log-output"),
    text("initial turn complete"),
    text("saw fresh reused log result"),
  ), { cwd, env });

  try {
    await mock.run("start a background command after a stale log exists", TIMEOUT);
    const logPath = join(logDir, "bg001.log");
    await waitForCondition(() => readFileSync(logPath, "utf8").includes("fresh-reused-log-output"));
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /fresh-reused-log-output/);
    assert.doesNotMatch(log, /stale-previous-job-output/);
    assert.doesNotMatch(log, /\[pbb: output snapshot replaced\]/);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});


test("bash background true uses sequential per-session job ids", async () => {
  const mock = await createBgMock(script(
    [bg("sleep 0.2; echo first"), bg("sleep 0.1; echo second")],
    text("initial turn complete"),
    text("saw one result"),
    text("saw another result"),
  ));

  try {
    const events = await mock.run("start two background commands", TIMEOUT);
    const all = JSON.stringify(events);
    assert.match(all, /Bash job bg001 started in background\./);
    assert.match(all, /Bash job bg002 started in background\./);

    const first = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const second = await mock.waitForRequest((req, i) => i > first.index && requestText(req).includes("<pi_context"), TIMEOUT);
    const both = [...backgroundResultTexts(first.request), ...backgroundResultTexts(second.request)].join("\n");
    assert.match(both, /id="bg001"/);
    assert.match(both, /id="bg002"/);
  } finally {
    await mock.close();
  }
});

test("bash background job ids continue from padded session history after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-id-restore-${process.pid}-${Date.now()}-`));
  const sessionFile = join(dir, "session.jsonl");

  const first = await createBgMock(script(
    bg("echo first-id"),
    text("first id started"),
    text("first id done"),
  ), { sessionFile });
  try {
    const events = await first.run("start first padded id job", TIMEOUT);
    assert.match(JSON.stringify(events), /Bash job bg001 started in background/);
    await first.waitForRequest((req, i) => i >= 2 && requestText(req).includes("first-id"), TIMEOUT);
  } finally {
    await first.close();
  }

  const second = await createBgMock(script(
    bg("echo second-id"),
    text("second id started"),
    text("second id done"),
  ), { sessionFile });
  try {
    const events = await second.run("start second padded id job", TIMEOUT);
    assert.match(JSON.stringify(events), /Bash job bg002 started in background/);
  } finally {
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb CLI defaults to current instance and requires explicit scope for other instances", () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-scope-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const base = join(pbbRoot, "sessions", "scope-key", "instances");
  mkdirSync(join(base, "current", "jobs"), { recursive: true });
  mkdirSync(join(base, "other", "jobs"), { recursive: true });
  writeFileSync(join(base, "current", "jobs", "bg001.json"), JSON.stringify({ jobId: "bg001", globalJobId: "current:bg001", status: "running", command: "current job", startedAt: new Date().toISOString(), instanceId: "current" }));
  writeFileSync(join(base, "other", "jobs", "bg001.json"), JSON.stringify({ jobId: "bg001", globalJobId: "other:bg001", status: "running", command: "other job", startedAt: new Date().toISOString(), instanceId: "other" }));

  try {
    const env = { ...process.env, PBB_ROOT: pbbRoot, PI_LANE_SESSION_KEY: "scope-key", PI_LANE_SESSION_ID: "scope-session", PI_LANE_INSTANCE_ID: "current", PI_LANE_CURRENT_LANE: "main" };
    const current = execFileSync(process.execPath, [PBB_CLI, "list"], { env, encoding: "utf8" });
    assert.match(current, /current job/);
    assert.doesNotMatch(current, /other job/);
    assert.doesNotMatch(current, /<summary>/);

    const session = execFileSync(process.execPath, [PBB_CLI, "list", "--scope", "session"], { env, encoding: "utf8" });
    assert.match(session, /current job/);
    assert.match(session, /other job/);

    assert.throws(() => execFileSync(process.execPath, [PBB_CLI, "status", "bg001", "--scope", "session"], { env, encoding: "utf8", stdio: "pipe" }), /Command failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb hard-fails when tracked pi-lane liveness command is unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-pil-missing-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const base = join(pbbRoot, "sessions", "missing-pil-key", "instances", "current", "jobs");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "bg001.json"), JSON.stringify({ jobId: "bg001", globalJobId: "current:bg001", status: "running", command: "job", startedAt: new Date().toISOString(), instanceId: "current" }));

  try {
    const env = { ...process.env, PBB_PIL_BIN: join(dir, "missing-pil"), PBB_ROOT: pbbRoot, PI_LANE_SESSION_KEY: "missing-pil-key", PI_LANE_SESSION_ID: "missing-pil-session", PI_LANE_INSTANCE_ID: "current", PI_LANE_CURRENT_LANE: "main" };
    assert.throws(
      () => execFileSync(process.execPath, [PBB_CLI, "list"], { env, encoding: "utf8", stdio: "pipe" }),
      /pi_lane_unavailable/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb shows pi-lane owner liveness and stale status", () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-live-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const laneRoot = join(dir, "lane");
  const key = "live-key";
  const pbbBase = join(pbbRoot, "sessions", key, "instances");
  const laneBase = join(laneRoot, "sessions", key, "instances");
  mkdirSync(join(pbbBase, "current", "jobs"), { recursive: true });
  mkdirSync(join(pbbBase, "stale", "jobs"), { recursive: true });
  mkdirSync(laneBase, { recursive: true });
  writeFileSync(join(pbbBase, "current", "jobs", "bg001.json"), JSON.stringify({ jobId: "bg001", globalJobId: "current:bg001", status: "running", command: "live", startedAt: new Date().toISOString(), instanceId: "current", laneRoot }));
  writeFileSync(join(pbbBase, "stale", "jobs", "bg001.json"), JSON.stringify({ jobId: "bg001", globalJobId: "stale:bg001", status: "running", command: "stale", startedAt: new Date().toISOString(), instanceId: "stale", laneRoot }));
  writeFileSync(join(laneBase, "current.json"), JSON.stringify({ instanceId: "current", status: "idle", lastSeenAt: new Date().toISOString() }));
  writeFileSync(join(laneBase, "stale.json"), JSON.stringify({ instanceId: "stale", status: "disconnected", lastSeenAt: "2000-01-01T00:00:00.000Z" }));

  try {
    const env = { ...process.env, PBB_PIL_BIN: PIL_CLI, PBB_ROOT: pbbRoot, PI_LANE_ROOT: laneRoot, PI_LANE_SESSION_KEY: key, PI_LANE_SESSION_ID: "live-session", PI_LANE_INSTANCE_ID: "current", PI_LANE_CURRENT_LANE: "main" };
    const current = execFileSync(process.execPath, [PBB_CLI, "list"], { env, encoding: "utf8" });
    assert.match(current, /owner=live/);
    const session = execFileSync(process.execPath, [PBB_CLI, "list", "--scope", "session"], { env, encoding: "utf8" });
    assert.match(session, /owner=live/);
    assert.match(session, /owner=stale/);
    const instances = execFileSync(process.execPath, [PBB_CLI, "instances"], { env, encoding: "utf8" });
    assert.match(instances, /instance=current live=true/);
    assert.match(instances, /instance=stale live=false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb lists and tails current pi-lane instance background jobs", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-pbb-test",
    PI_LANE_SESSION_KEY: "session-key-pbb-test",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-test",
    PI_LANE_CURRENT_LANE: "main",
    PI_LANE_ROOT: join(dir, "lane"),
  };

  const mock = await createBgMock(script(
    bg("sleep 0.3; echo pbb-done"),
    sh(`node ${JSON.stringify(PBB_CLI)} list`),
    text("listed pbb job"),
    text("saw pbb result"),
  ), { env });

  try {
    const events = await mock.run("start a background command and inspect it with pbb", TIMEOUT);
    const all = JSON.stringify(events);
    assert.match(all, /source=\\?"pbb\\?"/);
    assert.match(all, /job=bg001/);
    assert.match(all, /instance-pbb-test/);

    await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("pbb-done"), TIMEOUT);
    const jobPath = join(pbbRoot, "sessions", "session-key-pbb-test", "instances", "instance-pbb-test", "jobs", "bg001.json");
    const logPath = join(pbbRoot, "sessions", "session-key-pbb-test", "instances", "instance-pbb-test", "logs", "bg001.log");
    await waitForCondition(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("pbb-done"));
    assert.equal(JSON.parse(readFileSync(jobPath, "utf8")).sessionId, "session-pbb-test");
    assert.match(readFileSync(logPath, "utf8"), /pbb-done/);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb kill requests abort a live current-instance background job", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-kill-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const marker = join(dir, "should-not-exist");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-pbb-kill-test",
    PI_LANE_SESSION_KEY: "session-key-pbb-kill-test",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-kill-test",
    PI_LANE_CURRENT_LANE: "main",
  };

  const mock = await createBgMock(script(
    bg(`sleep 5; echo survived > ${JSON.stringify(marker)}`),
    sh(`node ${JSON.stringify(PBB_CLI)} kill bg001`),
    text("requested kill"),
    text("saw aborted result"),
  ), { env });

  try {
    const events = await mock.run("start and kill a background command", TIMEOUT);
    assert.match(JSON.stringify(events), /kill requested for bg001/);
    const jobPath = join(pbbRoot, "sessions", "session-key-pbb-kill-test", "instances", "instance-pbb-kill-test", "jobs", "bg001.json");
    const logPath = join(pbbRoot, "sessions", "session-key-pbb-kill-test", "instances", "instance-pbb-kill-test", "logs", "bg001.log");
    await waitForCondition(() => existsSync(jobPath) && JSON.parse(readFileSync(jobPath, "utf8")).outcome === "abort");
    assert.match(readFileSync(logPath, "utf8"), /Command aborted/);
    assert.equal(existsSync(marker), false);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb kill honors --signal for live current-instance jobs", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-kill-signal-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const marker = join(dir, "should-not-exist");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-pbb-kill-signal-test",
    PI_LANE_SESSION_KEY: "session-key-pbb-kill-signal-test",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-kill-signal-test",
    PI_LANE_CURRENT_LANE: "main",
  };

  const mock = await createBgMock(script(
    bg(`bash -c 'trap "" TERM; sleep 5; echo survived > ${JSON.stringify(marker)}'`),
    sh(`node ${JSON.stringify(PBB_CLI)} kill bg001 --signal KILL`),
    text("requested kill signal"),
    text("saw signal abort"),
  ), { env });

  try {
    const events = await mock.run("start and kill a signal-resistant background command", TIMEOUT);
    assert.match(JSON.stringify(events), /kill requested for bg001/);
    const jobPath = join(pbbRoot, "sessions", "session-key-pbb-kill-signal-test", "instances", "instance-pbb-kill-signal-test", "jobs", "bg001.json");
    await waitForCondition(() => existsSync(jobPath) && JSON.parse(readFileSync(jobPath, "utf8")).outcome === "abort");
    const job = JSON.parse(readFileSync(jobPath, "utf8"));
    assert.equal(job.killSignal, "SIGKILL");
    assert.equal(existsSync(marker), false);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default PBB runner preserves shell semantics, cwd, env, stdout, stderr, and nonzero style", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 5 });
  const pbbRoot = join(cwd, "pbb");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-pbb-runner-semantics",
    PI_LANE_SESSION_KEY: "session-key-pbb-runner-semantics",
    PI_LANE_SESSION_FILE: join(cwd, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-runner-semantics",
    PI_LANE_CURRENT_LANE: "main",
    PBB_TEST_VAR: "runner-env-ok",
  };
  const mock = await createBgMock(script(
    bg("printf 'env=%s cwd=%s pipe=' \"$PBB_TEST_VAR\" \"$(pwd)\"; printf hi | tr a-z A-Z; printf ' err-line\\n' >&2; echo redirected > out.txt; cat out.txt; exit 9"),
    text("initial runner semantics turn"),
    text("saw runner semantics result"),
  ), { cwd, env });

  try {
    await mock.run("start pbb runner shell semantics command", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("runner-env-ok"), TIMEOUT);
    const result = requestText(request);
    assert.match(result, /env=runner-env-ok/);
    assert.match(result, new RegExp(`cwd=${escapeRegExp(realpathSync(cwd))}`));
    assert.match(result, /pipe=HI/);
    assert.match(result, /err-line/);
    assert.match(result, /redirected/);
    assert.match(result, /Command exited with code 9/);
    assert.match(result, /exit_code=\\?"9\\?"/);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("auto-background timeout kills process group descendants", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 0.1 });
  const marker = join(cwd, "should-not-exist");
  const env = {
    PBB_ROOT: join(cwd, "pbb"),
    PI_LANE_SESSION_ID: "session-auto-timeout",
    PI_LANE_SESSION_KEY: "session-key-auto-timeout",
    PI_LANE_SESSION_FILE: join(cwd, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-auto-timeout",
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    sh(`sh -c 'sleep 2; echo survived > ${JSON.stringify(marker)}'`, 1),
    text("initial auto timeout turn"),
    text("saw auto timeout result"),
  ), { cwd, env });

  try {
    const events = await mock.run("auto-background and timeout a descendant command", TIMEOUT);
    assert.match(JSON.stringify(events), /Bash job bg001 moved to background after 0\.1s\./);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("Command timed out after 1 seconds"), TIMEOUT);
    assert.match(requestText(request), /outcome=\\?"timeout\\?"/);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(existsSync(marker), false);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("default PBB runner preserves timeout style and kills process group descendants", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-runner-timeout-${process.pid}-${Date.now()}-`));
  const marker = join(dir, "should-not-exist");
  const env = {
    PBB_ROOT: join(dir, "pbb"),
    PI_LANE_SESSION_ID: "session-pbb-runner-timeout",
    PI_LANE_SESSION_KEY: "session-key-pbb-runner-timeout",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-runner-timeout",
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    bg(`sh -c 'sleep 2; echo survived > ${JSON.stringify(marker)}'`, 1),
    text("initial runner timeout turn"),
    text("saw runner timeout result"),
  ), { env });

  try {
    await mock.run("start pbb runner timed command", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("Command timed out after 1 seconds"), TIMEOUT);
    const result = requestText(request);
    assert.match(result, /outcome=\\?"timeout\\?"/);
    assert.doesNotMatch(result, /exit_code=/);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(existsSync(marker), false);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default PBB runner session shutdown kills process group descendants", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-runner-shutdown-${process.pid}-${Date.now()}-`));
  const marker = join(dir, "should-not-exist");
  const env = {
    PBB_ROOT: join(dir, "pbb"),
    PI_LANE_SESSION_ID: "session-pbb-runner-shutdown",
    PI_LANE_SESSION_KEY: "session-key-pbb-runner-shutdown",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-runner-shutdown",
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    bg(`sh -c 'sleep 2; echo survived > ${JSON.stringify(marker)}'`),
    text("started runner shutdown job"),
  ), { env });

  try {
    await mock.run("start pbb runner long command", TIMEOUT);
  } finally {
    await mock.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(existsSync(marker), false);
  rmSync(dir, { recursive: true, force: true });
});

test("default PBB runner records pid/pgid and pbb kill terminates the process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-runner-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const marker = join(dir, "should-not-exist");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-pbb-runner-test",
    PI_LANE_SESSION_KEY: "session-key-pbb-runner-test",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-runner-test",
    PI_LANE_CURRENT_LANE: "main",
  };

  const mock = await createBgMock(script(
    bg(`sh -c 'sleep 5; echo survived > ${JSON.stringify(marker)}'`),
    sh(`node ${JSON.stringify(PBB_CLI)} kill bg001`),
    text("requested runner kill"),
    text("saw runner abort"),
  ), { env });

  try {
    const events = await mock.run("start and kill a pbb-runner background command", TIMEOUT);
    assert.match(JSON.stringify(events), /kill requested for bg001/);
    const jobPath = join(pbbRoot, "sessions", "session-key-pbb-runner-test", "instances", "instance-pbb-runner-test", "jobs", "bg001.json");
    await waitForCondition(() => existsSync(jobPath) && JSON.parse(readFileSync(jobPath, "utf8")).outcome === "abort");
    const job = JSON.parse(readFileSync(jobPath, "utf8"));
    assert.equal(job.runner, "pbb");
    assert.equal(typeof job.pid, "number");
    assert.equal(typeof job.pgid, "number");
    assert.equal(existsSync(marker), false);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb kill --stale can signal a recorded stale process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-stale-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const marker = join(dir, "should-not-exist");
  const key = "stale-kill-key";
  const instance = "stale-owner";
  const jobDir = join(pbbRoot, "sessions", key, "instances", instance, "jobs");
  mkdirSync(jobDir, { recursive: true });
  const child = spawn("bash", ["-lc", `sleep 5; echo survived > ${JSON.stringify(marker)}`], { detached: true, stdio: "ignore" });
  child.unref();

  try {
    writeFileSync(join(jobDir, "bg999.json"), JSON.stringify({ jobId: "bg999", globalJobId: `${instance}:bg999`, status: "running", command: "stale", startedAt: new Date().toISOString(), instanceId: instance, runner: "pbb", pid: child.pid, pgid: child.pid }));
    const env = { ...process.env, PBB_ROOT: pbbRoot, PI_LANE_SESSION_KEY: key, PI_LANE_SESSION_ID: "stale-session", PI_LANE_INSTANCE_ID: "current" };
    const out = execFileSync(process.execPath, [PBB_CLI, "kill", "bg999", "--instance", instance, "--stale"], { env, encoding: "utf8" });
    assert.match(out, /stale process-group kill sent/);
    await waitForCondition(() => {
      try {
        process.kill(child.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5_000);
    assert.equal(existsSync(marker), false);
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session start repairs detached background bash tool results before replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-repair-${process.pid}-${Date.now()}-`));
  const sessionFile = join(dir, "session.jsonl");
  const now = new Date().toISOString();
  const toolCallId = "call_pbbRepair123|fc_pbbRepair456";
  const entries = [
    { type: "session", version: 3, id: "repair-session", timestamp: now, cwd: dir },
    {
      type: "message",
      id: "user-root",
      parentId: null,
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "start background command" }], timestamp: Date.now() },
    },
    {
      type: "message",
      id: "assistant-call",
      parentId: "user-root",
      timestamp: now,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "sleep 60" } }],
        stopReason: "toolUse",
        provider: "faux",
        api: "faux",
        model: "faux",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "detached-result",
      parentId: null,
      timestamp: now,
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "bash",
        content: [{ type: "text", text: "Bash job bg001 moved to background after 30s." }],
        details: { jobId: "bg001", command: "sleep 60", outcome: "running", exitCode: null, toolCallId },
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "followup-user",
      parentId: "detached-result",
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "continue after background" }], timestamp: Date.now() },
    },
  ];
  writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const mock = await createBgMock(script(
    text("repaired detached background result"),
  ), { sessionFile, cwd: dir });

  try {
    await mock.run("continue after repair", TIMEOUT);
    const repaired = readSessionEntries(sessionFile).find((entry) => entry.id === "detached-result");
    assert.equal(repaired.parentId, "assistant-call");
    const apiItems = mock.requests.at(-1)._raw.input;
    const call = apiItems.find((item) => item.type === "function_call" && item.name === "bash");
    const result = apiItems.find((item) => item.type === "function_call_output");
    assert.equal(call.call_id, toolCallId.split("|")[0]);
    assert.equal(result.call_id, call.call_id);
    assert.match(result.output, /Bash job bg001 moved to background/);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash background completion is steered into the active turn at the next tool boundary", async () => {
  const cb = createControllableBrain();
  const mock = await createBgMock(cb.brain);

  try {
    await mock.prompt("start a short background command");
    const startCall = await cb.waitForCall(TIMEOUT);
    startCall.respond(bg("sleep 0.2; echo race-done"));

    const startContinuation = await cb.waitForCall(TIMEOUT);
    startContinuation.respond(text("background command started"));
    await mock.waitFor((event) => event.type === "agent_end" && JSON.stringify(event).includes("background command started"), TIMEOUT);

    await mock.prompt("do unrelated work while the background command finishes");
    const unrelatedCall = await cb.waitForCall(TIMEOUT);

    // Complete the background job while the unrelated provider request is
    // pending. It must enter Pi's steering queue, not start a nested request.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(cb.pending().length, 0, "background result should not call the provider while another call is in flight");

    unrelatedCall.respond(sh("echo tool-boundary"));
    const continuation = await cb.waitForCall((req) => requestText(req).includes("tool-boundary"), TIMEOUT);
    assert.match(backgroundResultText(continuation.request), /race-done/);
    continuation.respond(text("saw steered background result"));
    await mock.waitFor((event) => event.type === "agent_end" && JSON.stringify(event).includes("saw steered background result"), TIMEOUT);
  } finally {
    await mock.close();
  }
});

test("bash background true records provenance even when session parentId points at current head", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-session-${process.pid}-${Date.now()}-`));
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, "");

  const mock = await createBgMock(script(
    bg("sleep 1.5; echo provenance-done", 10),
    text("started background job"),
    text("unrelated turn complete"),
    text("saw provenance result"),
  ), { sessionFile });

  try {
    const initialEvents = await mock.run("start a slow background command", TIMEOUT);
    const startEvent = initialEvents.find((event) => event.type === "tool_execution_start" && event.toolName === "bash");
    assert.ok(startEvent, "expected bash tool_execution_start event");
    const toolCallId = startEvent.toolCallId;

    const startResultEvent = initialEvents.find((event) => event.type === "tool_execution_end" && event.toolName === "bash");
    assert.ok(startResultEvent, "expected bash tool_execution_end event");
    assert.equal(startResultEvent.result.details.toolCallId, toolCallId);
    assert.match(startResultEvent.result.details.startedAt, /^\d{4}-\d{2}-\d{2}T/);

    await mock.prompt("do unrelated work while the background command runs", TIMEOUT);
    await mock.waitFor((event) => event.type === "agent_end" && JSON.stringify(event).includes("saw provenance result"), TIMEOUT);

    const entries = readSessionEntries(sessionFile);
    const toolCallEntry = entries.find((entry) =>
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      entry.message.content?.some((part) => part.type === "toolCall" && part.name === "bash" && part.id === toolCallId)
    );
    assert.ok(toolCallEntry, "expected original bash assistant tool call in session JSONL");

    const toolResultEntry = entries.find((entry) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "bash" &&
      entry.message.details?.toolCallId === toolCallId
    );
    assert.ok(toolResultEntry, "expected start tool result details to include original toolCallId");

    const unrelatedAssistantEntry = entries.find((entry) =>
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      entry.message.content?.some((part) => part.type === "text" && part.text === "unrelated turn complete")
    );
    assert.ok(unrelatedAssistantEntry, "expected unrelated assistant turn in session JSONL");

    const customEntry = entries.find((entry) =>
      entry.type === "custom_message" &&
      entry.customType === "background_bash_result" &&
      entry.details?.jobId === "bg001"
    );
    assert.ok(customEntry, "expected background_bash_result custom message in session JSONL");

    // Pi appends follow-up custom messages to the current session head. The raw
    // parentId can therefore point at unrelated work; provenance must come from
    // stable metadata on the result itself, not from parentId adjacency.
    assert.equal(customEntry.parentId, unrelatedAssistantEntry.id);
    assert.notEqual(customEntry.parentId, toolResultEntry.id);

    assert.equal(customEntry.details.toolCallId, toolCallId);
    assert.equal(customEntry.details.startedAt, toolResultEntry.message.details.startedAt);
    assert.match(customEntry.content, new RegExp(`tool_call_id="${escapeRegExp(toolCallId)}"`));
    assert.match(customEntry.content, /started_at="\d{4}-\d{2}-\d{2}T[^"]+"/);
    assert.match(customEntry.content, /id="bg001"/);

    const sessionText = readFileSync(sessionFile, "utf8");
    const occurrences = sessionText.match(new RegExp(escapeRegExp(toolCallId), "g")) ?? [];
    assert.ok(occurrences.length >= 3, "original toolCallId should grep across initiation, start result, and completion result");
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash background true kills active jobs when the session closes", async () => {
  const marker = join(tmpdir(), `pi-background-bash-survived-${process.pid}-${Date.now()}`);
  rmSync(marker, { force: true });
  const mock = await createBgMock(script(
    bg(`sleep 2; echo survived > ${JSON.stringify(marker)}`),
    text("initial turn complete"),
  ));

  try {
    await mock.run("start a long background command", TIMEOUT);
  } finally {
    await mock.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(existsSync(marker), false, "background job should be killed on session close");
});

test("bash background true truncates verbose PBB results and pbb tail --full returns complete output", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-truncate-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-truncate-test",
    PI_LANE_SESSION_KEY: "session-key-truncate-test",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-truncate-test",
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    bg("python3 - <<'PY'\nfor i in range(2105): print(f'line {i}')\nPY"),
    text("initial turn complete"),
    text("saw truncated result"),
  ), { env });

  try {
    await mock.run("start a verbose background command", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /\[truncated tail: kept 2000\/2105 lines, max 51200 bytes\. Full output: pbb tail bg001 --full\]/);
    assert.match(textReq, /line 2104/);
    assert.doesNotMatch(textReq, /line 0\nline 1\nline 2/);

    const tail = execFileSync(process.execPath, [PBB_CLI, "tail", "bg001", "--full"], { env: { ...process.env, ...env }, encoding: "utf8" });
    assert.match(tail, /line 0/);
    assert.match(tail, /line 2104/);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

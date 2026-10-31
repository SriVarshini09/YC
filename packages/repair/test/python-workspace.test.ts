import { describe, expect, it } from "vitest";
import type { ExecResult, NetworkMode, Sandbox, SnapshotFile } from "@shapi/sandbox";
import { REGISTRY_HOSTS } from "@shapi/sandbox";
import { PYTHON_VENV, checkSuite, failingTests, sandboxWorkspace, suiteCounts } from "@shapi/repair";

// U-03 / V-01 for Python: dependencies from PyPI into SHAPI's virtualenv, then the repository's pytest suite with no network.
function pythonSandbox(answers: (command: string, args: string[]) => Partial<ExecResult> = () => ({})) {
  const files = new Map<string, string>();
  const log: string[] = [];
  let network: NetworkMode = "off";
  const sandbox: Sandbox = {
    provider: "e2b",
    id: "py-1",
    root: "/home/user/repo",
    async write(fs: SnapshotFile[]) {
      for (const f of fs) files.set(f.path, String(f.content));
    },
    async read(file) {
      return files.get(file);
    },
    async exec(command: string, args: string[]): Promise<ExecResult> {
      log.push(`[${network}] ${[command, ...args].join(" ")}`);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...answers(command, args) };
    },
    async setNetwork(mode) {
      network = mode;
    },
    async extend() {},
    async close() {},
  };
  return { sandbox, log };
}

const repo: SnapshotFile[] = [
  { path: "requirements.txt", content: "requests==2.32.5\n" },
  { path: "requirements-dev.txt", content: "pytest==8.3.0\n" },
  { path: "app/client.py", content: "import requests\n" },
  { path: "tests/test_client.py", content: "def test_ok():\n    assert True\n" },
];

describe("a Python repository in the sandbox", () => {
  it("reaches PyPI during install only", () => {
    expect(REGISTRY_HOSTS).toEqual(expect.arrayContaining(["pypi.org", "files.pythonhosted.org", "registry.npmjs.org"]));
  });

  it("installs its requirements and pytest into a virtualenv with only the registries reachable, then cuts the network", async () => {
    const { sandbox, log } = pythonSandbox();
    const ws = await sandboxWorkspace(sandbox, repo);
    const venv = `${PYTHON_VENV}/bin/python`;
    expect(log).toEqual([
      `[registry] python3 -m venv ${PYTHON_VENV}`,
      `[registry] ${venv} -m pip install --disable-pip-version-check --no-input -r requirements.txt`,
      `[registry] ${venv} -m pip install --disable-pip-version-check --no-input -r requirements-dev.txt`,
      `[registry] ${venv} -m pip install --disable-pip-version-check --no-input pytest`,
    ]);
    expect(ws.install.python?.exitCode).toBe(0);
    await ws.runTest("test/shapi/test_x.py");
    await ws.runSuite!();
    expect(log.slice(4)).toEqual([`[off] ${venv} test/shapi/test_x.py`, `[off] ${venv} -m pytest -q -rfE --color=no -p no:cacheprovider --ignore=test/shapi`]);
  });

  it("installs a pyproject project with pip install -e, keeps a failed install as a report, and treats no collected tests as no suite", async () => {
    const { sandbox, log } = pythonSandbox((command, args) => (args.includes("-e") ? { exitCode: 1, stderr: "build failed" } : args.includes("pytest") && args[0] === "-m" && args[1] === "pytest" ? { exitCode: 5 } : {}));
    const ws = await sandboxWorkspace(sandbox, [{ path: "pyproject.toml", content: "[project]\nname='x'\n" }, { path: "x.py", content: "" }]);
    expect(log[1]).toContain("pip install --disable-pip-version-check --no-input -e .");
    expect(ws.install.python).toMatchObject({ exitCode: 1 });
    expect(ws.install.python?.output).toContain("build failed");
    expect(await ws.runSuite!()).toBeUndefined();
  });
});

describe("pytest output", () => {
  const before = "....F.\n=========================== short test summary info ============================\nFAILED tests/test_a.py::test_old - AssertionError: x\n========================= 1 failed, 5 passed, 2 warnings in 0.52s =========================\n";
  const after = "......F\nFAILED tests/test_a.py::test_old - AssertionError: x\nFAILED tests/test_b.py::test_new - KeyError\nERROR tests/test_c.py - ImportError\n2 failed, 5 passed, 1 error in 0.61s\n";

  it("reads pytest's counts, without warnings, and its failing tests", () => {
    expect(suiteCounts(before)).toBe("1 failed, 5 passed");
    expect([...failingTests(after)]).toEqual(["tests/test_a.py::test_old", "tests/test_b.py::test_new", "tests/test_c.py"]);
  });

  it("reads them through ANSI colors too (pytest colors its output whenever FORCE_COLOR is set, even to 0)", () => {
    const esc = String.fromCharCode(27);
    const colored = `${esc}[32m.${esc}[0m${esc}[32m.${esc}[0m\n${esc}[32m${esc}[1m126 passed${esc}[0m${esc}[32m in 2.31s${esc}[0m\n${esc}[31mFAILED${esc}[0m tests/test_a.py::test_x - KeyError\n`;
    expect(suiteCounts(colored)).toBe("126 passed");
    expect([...failingTests(colored)]).toEqual(["tests/test_a.py::test_x"]);
  });

  it("rejects a fix that makes a passing pytest test fail, and ignores one that already failed", async () => {
    const check = await checkSuite({ passed: false, exitCode: 1, output: before, command: "pytest" }, async () => ({ passed: false, exitCode: 1, output: after, command: "pytest" }));
    expect(check).toMatchObject({ status: "failed", before: "1 failed, 5 passed", after: "2 failed, 5 passed, 1 error" });
    expect(check.detail).toContain("tests/test_b.py::test_new");
    expect(check.detail).not.toContain("tests/test_a.py::test_old");
  });
});

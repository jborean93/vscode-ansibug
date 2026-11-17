import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
    expandInterpreterPath,
    findVenvPythons,
    resolvePython,
} from "../../python";

const OK = "#!/bin/sh\necho '3.12.1 0.4.0 2.18.2'\n";
const NO_ANSIBUG = "#!/bin/sh\necho 'Traceback (most recent call last):' >&2\n" +
    "echo \"ModuleNotFoundError: No module named 'ansibug'\" >&2\nexit 1\n";
const NO_ANSIBLE = "#!/bin/sh\necho \"ModuleNotFoundError: No module named 'ansible'\" >&2\nexit 1\n";
const BROKEN = "#!/bin/sh\necho 'Traceback (most recent call last):' >&2\necho 'SyntaxError: bad' >&2\nexit 1\n";

/** Creates a fake venv whose python runs the given shell script. */
function makeVenv(root: string, name: string, script: string): string {
    const bin = path.join(root, name, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(root, name, "pyvenv.cfg"), "home = /usr/bin\n");
    const python = path.join(bin, "python");
    fs.writeFileSync(python, script, { mode: 0o755 });
    return python;
}

suite("Python interpreter resolution", () => {
    let root: string;
    setup(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "ansibug-test-"));
    });
    teardown(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test("finds .venv before venv and ignores folders without pyvenv.cfg", () => {
        const dotVenv = makeVenv(root, ".venv", OK);
        const venv = makeVenv(root, "venv", OK);
        fs.mkdirSync(path.join(root, "env", "bin"), { recursive: true });
        assert.deepStrictEqual(findVenvPythons(root), [dotVenv, venv]);

        fs.rmSync(path.join(root, ".venv", "pyvenv.cfg"));
        assert.deepStrictEqual(findVenvPythons(root), [venv]);
    });

    test("expands workspaceFolder and relative paths but not bare names", () => {
        assert.strictEqual(
            expandInterpreterPath("${workspaceFolder}/.venv/bin/python", "/ws"),
            "/ws/.venv/bin/python"
        );
        assert.strictEqual(expandInterpreterPath(".venv/bin/python", "/ws"), "/ws/.venv/bin/python");
        assert.strictEqual(expandInterpreterPath("python3", "/ws"), "python3");
        assert.strictEqual(expandInterpreterPath(".venv/bin/python"), ".venv/bin/python");
    });

    test("skips candidates without ansibug, activates the venv and logs why", async () => {
        const bad = makeVenv(root, "bad", NO_ANSIBUG);
        const good = makeVenv(root, "good", OK);
        const lines: string[] = [];
        const [python, env] = await resolvePython(
            [
                { source: "PATH", python: "/does/not/exist/python" },
                { source: "Python extension", python: bad },
                { source: "PATH", python: bad },
                { source: "venv", python: makeVenv(root, "noansible", NO_ANSIBLE) },
                { source: "venv", python: makeVenv(root, "broken", BROKEN) },
                { source: ".venv", python: good },
            ],
            false,
            { PATH: "/usr/bin", PYTHONHOME: "/x" },
            root,
            (m) => lines.push(m),
        );
        assert.strictEqual(python, good);
        assert.strictEqual(env.VIRTUAL_ENV, path.join(root, "good"));
        assert.strictEqual(env.PATH, `${path.dirname(good)}${path.delimiter}/usr/bin`);
        assert.strictEqual(env.PYTHONHOME, undefined);
        assert.deepStrictEqual(lines, [
            "  PATH: /does/not/exist/python: not found",
            `  Python extension: ${path.join("bad", "bin", "python")}: ansibug not installed`,
            `  venv: ${path.join("noansible", "bin", "python")}: ansible-core not installed`,
            `  venv: ${path.join("broken", "bin", "python")}: exited with 1: SyntaxError: bad`,
            `  Using ${path.join("good", "bin", "python")} (.venv): Python 3.12.1, ansibug 0.4.0, ansible-core 2.18.2`,
        ]);
    });

    test("does not set VIRTUAL_ENV for a non-venv interpreter", async () => {
        const python = makeVenv(root, "sys", OK);
        fs.rmSync(path.join(root, "sys", "pyvenv.cfg"));
        const [, env] = await resolvePython(
            [{ source: "ansibug.interpreterPath", python }], true, { PATH: "/usr/bin" });
        assert.strictEqual(env.VIRTUAL_ENV, undefined);
    });

    test("explicit interpreter error names the setting and reason", async () => {
        const bad = makeVenv(root, "bad", NO_ANSIBUG);
        await assert.rejects(
            resolvePython(
                [{ source: "ansibug.interpreterPath", python: bad }], true, { PATH: "/usr/bin" }, root),
            {
                message: `Failed to start ansibug with ansibug.interpreterPath '${path.join("bad", "bin", "python")}': ` +
                    "ansibug not installed. See the Ansibug output for details.",
            }
        );
    });

    test("auto-detect error is short", async () => {
        const bad = makeVenv(root, "bad", NO_ANSIBUG);
        await assert.rejects(
            resolvePython([{ source: ".venv", python: bad }], false, { PATH: "/usr/bin" }),
            (err: Error) => err.message.startsWith("No detected Python interpreter can run ansibug") && !err.message.includes(bad)
        );
    });
});

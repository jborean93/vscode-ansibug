import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";

export type Env = { [key: string]: string };

/**
 * Builds the env for running the interpreter, activating it if it is a venv.
 * @param python - The interpreter path or command name.
 * @param baseEnv - The environment to start from.
 * @returns The environment to run the interpreter with.
 */
export function buildPythonEnv(python: string, baseEnv: Env): Env {
    const env = { ...baseEnv };
    if (path.isAbsolute(python)) {
        const binDir = path.dirname(python);
        env.PATH = `${binDir}${path.delimiter}${baseEnv.PATH ?? ""}`;

        const venvDir = path.dirname(binDir);
        if (fs.existsSync(path.join(venvDir, "pyvenv.cfg"))) {
            env.VIRTUAL_ENV = venvDir;
            delete env.PYTHONHOME;
        }
    }
    return env;
}

/**
 * Gets the interpreters of the .venv/venv virtual environments in a folder.
 * @param folder - The folder to look in.
 * @returns The interpreter paths that exist.
 */
export function findVenvPythons(folder: string): string[] {
    // shortcut: POSIX venv layout only, Ansible does not run on a Windows controller.
    return [".venv", "venv"]
        .filter((v) => fs.existsSync(path.join(folder, v, "pyvenv.cfg")))
        .map((v) => path.join(folder, v, "bin", "python"))
        .filter((p) => fs.existsSync(p));
}

/**
 * Expands ${workspaceFolder} and makes a relative path absolute to the folder.
 * @param value - The configured interpreter path.
 * @param folder - The workspace folder path, if any.
 * @returns The expanded path.
 */
export function expandInterpreterPath(value: string, folder?: string): string {
    if (!folder) {
        return value;
    }
    const expanded = value.replace(/\$\{workspaceFolder\}/g, folder);
    // Bare names like "python3" are looked up in PATH, keep them as is.
    return expanded.includes("/") || expanded.includes("\\")
        ? path.resolve(folder, expanded)
        : expanded;
}

export type Candidate = { source: string; python: string };

// Checks ansibug and ansible-core import and reports their versions in one process.
const PROBE = "import sys, importlib.metadata as m, ansibug; from ansible.release import __version__ as a; " +
    "print(sys.version.split()[0], m.version('ansibug'), a)";

/**
 * Picks the Python interpreter to run ansibug with.
 * An explicit interpreter must work, otherwise each candidate is tried in
 * order and the first that can import ansibug and ansible-core is used.
 * @param candidates - The interpreters to try in priority order.
 * @param explicit - Whether the single candidate was set by the user.
 * @param baseEnv - The environment to run with.
 * @param folder - The workspace folder, used to shorten logged paths.
 * @param log - Called with each line describing what was tried.
 * @returns The interpreter and the environment to run it with.
 */
export async function resolvePython(
    candidates: Candidate[],
    explicit: boolean,
    baseEnv: Env,
    folder?: string,
    log: (msg: string) => void = () => { },
): Promise<[string, Env]> {
    const display = (p: string) =>
        folder && p.startsWith(folder + path.sep) ? path.relative(folder, p) : p;

    const tried = new Set<string>();
    let lastFailure = "";
    for (const { source, python } of candidates) {
        if (tried.has(python)) {
            continue;
        }
        tried.add(python);

        const env = buildPythonEnv(python, baseEnv);
        const [out, rc] = await executeCommand(python, ["-c", PROBE], env);
        if (rc === 0) {
            const [pyVer, ansibugVer, ansibleVer] = out.trim().split(/\s+/);
            log(`  Using ${display(python)} (${source}): ` +
                `Python ${pyVer}, ansibug ${ansibugVer}, ansible-core ${ansibleVer}`);
            return [python, env];
        }

        const lastLine = out.trim().split("\n").pop() ?? "";
        lastFailure = out.includes("ENOENT")
            ? "not found"
            : out.includes("No module named 'ansibug'")
                ? "ansibug not installed"
                : out.includes("No module named 'ansible'")
                    ? "ansible-core not installed"
                    : `exited with ${rc}: ${lastLine}`;
        log(`  ${source}: ${display(python)}: ${lastFailure}`);
    }

    throw new Error(explicit
        ? `Failed to start ansibug with ${candidates[0].source} '${display(candidates[0].python)}': ` +
        `${lastFailure}. See the Ansibug output for details.`
        : "No detected Python interpreter can run ansibug. Set ansibug.interpreterPath " +
        "or install ansibug and ansible-core into a .venv in the workspace. See the Ansibug output for details."
    );
}

/**
 * Runs a command and returns the output and rc.
 * @param command - The command to run.
 * @param commandArgs - Arguments to provide to the command.
 * @param env - The environment to run the process with.
 * @returns The command output and return code.
 */
export function executeCommand(
    command: string,
    commandArgs: string[],
    env: Env,
): Promise<[string, number]> {
    return new Promise((resolve) => {
        const proc = child_process.spawn(command, commandArgs, {
            env: env,
            shell: false,
            stdio: "pipe",
            windowsHide: true,
        });

        let procOut = "";
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (data) => {
            procOut += data.toString();
        });

        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (data) => {
            procOut += data.toString();
        });

        proc.on("error", (error) => {
            let rc = -1;
            if ("errno" in error) {
                rc = error.errno as number;
            }
            resolve([error.message, rc]);
        });
        proc.on("close", (rc) => {
            resolve([procOut, rc ?? 0]);
        });
    });
}

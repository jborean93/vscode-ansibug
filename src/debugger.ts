import * as vscode from "vscode";
import * as glob from "glob";
import * as fs from "fs";
import * as path from "path";
import {
    Candidate,
    Env,
    expandInterpreterPath,
    findVenvPythons,
    resolvePython,
} from "./python";

export class DebuggerCommands {
    public static readonly PICK_ANSIBLE_PLAYBOOK =
        "ansibug.pickAnsiblePlaybook";
    public static readonly PICK_ANSIBLE_PROCESS =
        "ansibug.pickAnsibleProcess";
}

export class DebuggerManager {
    constructor() { }

    /**
     * Prompt the user for a playbook filename.
     * @returns The entered playbook filename.
     */
    public pickAnsiblePlaybook(): Thenable<string | undefined> {
        return vscode.window.showInputBox({
            title: "Enter Ansible Playbook File",
            placeHolder: "Enter the name of the playbook file to debug.",
        });
    }

    /**
     * Prompts the user for a ansible-playbook process.
     * @returns The process id selected.
     */
    public pickAnsibleProcess(): Thenable<string | undefined> {
        // See get_pid_info_path() in ansibug
        const tmpDir = process.env.TMPDIR || "/tmp";

        const playbookProcesses: { label: string; description: string }[] = [];
        for (const procFile of glob.globIterateSync(`${tmpDir}/ansibug-pid-*`)) {
            const procInfoRaw = fs.readFileSync(procFile, "utf8");
            let procInfo;
            try {
                procInfo = JSON.parse(procInfoRaw);
            } catch (SyntaxError) {
                continue;
            }

            if (procInfo.pid && this.isAlive(procInfo.pid)) {
                playbookProcesses.push({
                    label: procInfo.pid.toString(),
                    description: procInfo.playbook_file || "Unknown playbook",
                });
            }
        }

        if (playbookProcesses.length === 0) {
            throw new Error(
                "Cannot find an available ansible-playbook process to debug"
            );
        }

        return vscode.window
            .showQuickPick(playbookProcesses, {
                canPickMany: false,
            })
            .then((v) => v?.label);
    }

    private isAlive(pid: number): boolean {
        try {
            // Signal of 0 checks if the process exists or not.
            return process.kill(pid, 0);
        } catch {
            return false;
        }
    }
}

export class AnsibleDebugConfigurationProvider
    implements vscode.DebugConfigurationProvider {
    /**
     * Massage a debug configuration just before a debug session is being
     * launched. This is used to provide the default debug launch configuration
     * that launches the current file.
     */
    resolveDebugConfiguration(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        // if launch.json is missing or empty
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;

            // Both ansible and yaml is used in case the file hasn't been explicitly
            // marked as ansible and is just yaml.
            if (
                editor?.document?.languageId === "ansible" ||
                editor?.document?.languageId === "yaml"
            ) {
                config = {
                    request: "launch",
                    type: "ansible",
                    name: "Ansibug: Run Current Playbook File",
                    playbook: "${file}",
                };
            }
        }

        // Ensures the Debug Console window isn't open by default, Ansible's
        // debuggers works more with the terminal.
        config.internalConsoleOptions = "neverOpen";

        return config;
    }
}

/**
 * Creates the debug adapter executable for debugging.
 * @param session - The debug session being started.
 * @param log - The channel to log the interpreter lookup to.
 * @returns The debug adapter executable.
 */
export async function createAnsibleDebugAdapter(
    session: vscode.DebugSession,
    log: vscode.LogOutputChannel,
): Promise<vscode.DebugAdapterDescriptor> {
    const folder = session.workspaceFolder;
    const config = vscode.workspace.getConfiguration("ansibug");

    const ansibugArgs = ["dap"];

    const logFile = config.get("logFile", null);
    if (logFile) {
        ansibugArgs.push(
            "--log-file",
            logFile,
            "--log-level",
            config.get("logLevel", "info")
        );
    }

    const baseEnv: Env = {
        NO_COLOR: "0",
        ANSIBLE_FORCE_COLOR: "0",
        PYTHONBREAKPOINT: "0",
    };
    for (const e in process.env) {
        baseEnv[e] = process.env[e] ?? "";
    }

    const folderPath = folder?.uri.fsPath;
    const candidates: Candidate[] = [];
    // Also looks up the interpreterPath in the Ansible extension for ease of use.
    for (const [section, key] of [["ansibug", "interpreterPath"], ["ansible.python", "interpreterPath"]]) {
        const value = vscode.workspace.getConfiguration(section, folder).get<string>(key);
        if (value) {
            candidates.push({
                source: `${section}.${key}`,
                python: expandInterpreterPath(value, folderPath),
            });
            break;
        }
    }
    const explicit = candidates.length > 0;
    log.info(`Looking for a Python interpreter with ansibug${folderPath ? ` for ${folderPath}` : ""}`);
    if (!explicit) {
        // We try and find a suitable Python interpreter from the Python extensions if present, before
        // falling back to .venv, venv, and the system PATH.
        candidates.push(...await getExtensionInterpreter(
            "ms-python.vscode-python-envs", "Python Environments extension", log,
            async (api) => (await api?.getEnvironment?.(folder?.uri))?.execInfo?.run?.executable));
        candidates.push(...await getExtensionInterpreter(
            "ms-python.python", "Python extension", log,
            async (api) => api?.environments?.getActiveEnvironmentPath?.(folder?.uri)?.path));
        for (const python of folderPath ? findVenvPythons(folderPath) : []) {
            candidates.push({ source: path.basename(path.dirname(path.dirname(python))), python });
        }
        candidates.push({ source: "PATH", python: "python3" }, { source: "PATH", python: "python" });
    }

    // DebugAdapterExecutable does not have a way to retrieve stderr when
    // failing to start, resolvePython tests ansibug can run first.
    const [command, env] = await resolvePython(
        candidates, explicit, baseEnv, folderPath, (m) => log.info(m));

    return new vscode.DebugAdapterExecutable(
        command,
        ["-m", "ansibug", ...ansibugArgs],
        { env: env }
    );
}

/**
 * Gets the selected interpreter from a Python extension's API, activating the
 * extension if it is installed but not loaded yet.
 * @param id - The extension id.
 * @param source - The name to log the interpreter under.
 * @param log - The channel to log why no interpreter was returned.
 * @param getPath - Gets the interpreter path from the extension's exports.
 * @returns The interpreter candidate, or an empty list if unavailable.
 */
async function getExtensionInterpreter(
    id: string,
    source: string,
    log: vscode.LogOutputChannel,
    getPath: (api: any) => Promise<string | undefined>,
): Promise<Candidate[]> {
    const ext = vscode.extensions.getExtension(id);
    if (!ext) {
        log.info(`  ${source}: not installed`);
        return [];
    }
    try {
        const python = await getPath(await ext.activate());
        if (!python) {
            log.info(`  ${source}: no selected interpreter available from its API`);
            return [];
        }
        return [{ source, python }];
    } catch (e) {
        log.warn(`  ${source}: failed to get the selected interpreter: ${e}`);
        return [];
    }
}

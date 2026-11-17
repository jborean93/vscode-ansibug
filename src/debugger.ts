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
import { isPlaybook, splitArgs } from "./playbook";

export class DebuggerCommands {
    public static readonly PICK_ANSIBLE_PLAYBOOK =
        "ansibug.pickAnsiblePlaybook";
    public static readonly PICK_ANSIBLE_PROCESS =
        "ansibug.pickAnsibleProcess";
    public static readonly DEBUG_PLAYBOOK =
        "ansibug.debugPlaybook";
    public static readonly DEBUG_PLAYBOOK_WITH_ARGS =
        "ansibug.debugPlaybookWithArgs";
    public static readonly CLEAR_PLAYBOOK_ARGS =
        "ansibug.clearPlaybookArgs";
    public static readonly SAVE_PLAYBOOK_LAUNCH_CONFIG =
        "ansibug.savePlaybookLaunchConfig";
}

/** Context key set when the active editor is a playbook. */
export const IS_PLAYBOOK_CONTEXT = "ansibug.isPlaybook";

export class DebuggerManager {
    constructor(private readonly state: vscode.Memento) { }

    /**
     * Starts debugging a playbook without a launch configuration.
     * @param uri - The playbook, defaults to the active editor file.
     * @param promptArgs - Prompt for the ansible-playbook arguments, defaulting
     * to the last ones used for this playbook.
     */
    public async debugPlaybook(uri: vscode.Uri | undefined, promptArgs: boolean): Promise<void> {
        uri = this.playbookUri(uri);
        const key = `playbookArgs:${uri.toString()}`;
        let args = "";
        if (promptArgs) {
            const value = await vscode.window.showInputBox({
                title: `Debug ${path.basename(uri.fsPath)} with Arguments`,
                prompt: "Arguments for ansible-playbook, excluding the playbook",
                placeHolder: "-i inventory.ini -e key=value --check",
                value: this.state.get<string>(key, ""),
                validateInput: (v) => {
                    try {
                        splitArgs(v);
                        return undefined;
                    } catch (e) {
                        return (e as Error).message;
                    }
                },
            });
            if (value === undefined) {
                return;
            }
            args = value;
            await this.state.update(key, value);
        }

        const folder = vscode.workspace.getWorkspaceFolder(uri);
        await vscode.debug.startDebugging(folder, {
            type: "ansible",
            request: "launch",
            name: `Ansibug: ${path.basename(uri.fsPath)}`,
            playbook: uri.fsPath,
            args: splitArgs(args),
            cwd: folder?.uri.fsPath ?? path.dirname(uri.fsPath),
        });
    }

    /**
     * Adds a launch configuration for the playbook with the last arguments
     * used by debugPlaybook.
     * @param uri - The playbook, defaults to the active editor file.
     */
    public async savePlaybookLaunchConfig(uri: vscode.Uri | undefined): Promise<void> {
        uri = this.playbookUri(uri);
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) {
            throw new Error("The playbook must be in a workspace folder to save a launch configuration");
        }
        const name = `Ansibug: ${path.basename(uri.fsPath)}`;
        const launch = vscode.workspace.getConfiguration("launch", folder.uri);
        const configs = launch.get<vscode.DebugConfiguration[]>("configurations", []);
        await launch.update("configurations", [...configs, {
            name: name,
            type: "ansible",
            request: "launch",
            playbook: `\${workspaceFolder}/${path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/")}`,
            args: splitArgs(this.state.get<string>(`playbookArgs:${uri.toString()}`, "")),
            cwd: "${workspaceFolder}",
        }], vscode.ConfigurationTarget.WorkspaceFolder);
        vscode.window.showInformationMessage(`Added launch configuration '${name}'`);
    }

    /**
     * Removes the arguments remembered by debugPlaybook for all playbooks.
     */
    public async clearPlaybookArgs(): Promise<void> {
        const keys = this.state.keys().filter((k) => k.startsWith("playbookArgs:"));
        for (const key of keys) {
            await this.state.update(key, undefined);
        }
        vscode.window.showInformationMessage(`Cleared saved arguments for ${keys.length} playbook(s)`);
    }

    private playbookUri(uri: vscode.Uri | undefined): vscode.Uri {
        uri ??= vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
            throw new Error("Open an Ansible playbook to debug");
        }
        return uri;
    }

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

export class AnsiblePlaybookCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    private readonly configListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("ansibug.showCodeLens")) {
            this.changed.fire();
        }
    });
    readonly onDidChangeCodeLenses = this.changed.event;

    dispose(): void {
        this.configListener.dispose();
        this.changed.dispose();
    }

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (
            !vscode.workspace.getConfiguration("ansibug", document.uri).get("showCodeLens", true) ||
            !isPlaybook(document.getText())
        ) {
            return [];
        }
        const range = new vscode.Range(0, 0, 0, 0);
        return [
            new vscode.CodeLens(range, {
                title: "$(debug-alt) Debug",
                command: DebuggerCommands.DEBUG_PLAYBOOK,
                arguments: [document.uri],
            }),
            new vscode.CodeLens(range, {
                title: "Debug with Args...",
                command: DebuggerCommands.DEBUG_PLAYBOOK_WITH_ARGS,
                arguments: [document.uri],
            }),
        ];
    }
}

/**
 * Sets the playbook context key for the editor title debug buttons.
 * @param editor - The active editor.
 */
export function setPlaybookContext(editor: vscode.TextEditor | undefined): void {
    const doc = editor?.document;
    vscode.commands.executeCommand(
        "setContext",
        IS_PLAYBOOK_CONTEXT,
        doc?.uri.scheme === "file" &&
        (doc.languageId === "ansible" || doc.languageId === "yaml") &&
        isPlaybook(doc.getText()));
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

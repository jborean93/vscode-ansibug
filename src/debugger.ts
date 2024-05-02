import * as vscode from "vscode";
import * as glob from "glob";
import * as fs from "fs";
import * as path from "path";

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
 * @param settings - The extension settings.
 * @returns The debug adapter executable.
 */
export function createAnsibleDebugAdapter(): vscode.DebugAdapterExecutable {
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

    const [command, commandArgs, newEnv] = withPythonModule(
        config,
        "ansibug",
        ansibugArgs
    );

    const dapOptions: vscode.DebugAdapterExecutableOptions = {
        env: newEnv,
    };
    return new vscode.DebugAdapterExecutable(command, commandArgs, dapOptions);


}

/**
 * Builds the command, args, and env vars needed to run a Python module.
 * @param config - The extension configuration.
 * @param module - The python module to invoke.
 * @param moduleArgs - The arguments to invoke with the module.
 * @returns The executable, arguments, and environment variables to run.
 */
function withPythonModule(
    config: vscode.WorkspaceConfiguration,
    module: string,
    moduleArgs: string[]
): [string, string[], { [key: string]: string }] {
    let command: string = "python";

    let commandArgs: string[] = ["-m", module];
    commandArgs.push(...moduleArgs);

    const newEnv: { [key: string]: string } = {
        NO_COLOR: "0",
        ANSIBLE_FORCE_COLOR: "0",
        PYTHONBREAKPOINT: "0",
    };
    for (const e in process.env) {
        newEnv[e] = process.env[e] ?? "";
    }

    // Also looks up the interpreterPath in the Ansible extension for ease of use.
    const ansibleConfig = vscode.workspace.getConfiguration("ansible.python");

    const interpreterPath = config.get(
        "interpreterPath", null
    ) ?? ansibleConfig.get("interpreterPath", null);
    if (interpreterPath) {
        const virtualEnv = path.resolve(interpreterPath, "../..");
        const pathEntry = path.join(virtualEnv, "bin");

        newEnv.VIRTUAL_ENV = virtualEnv;
        newEnv.PATH = `${pathEntry}${path.delimiter}${process.env.PATH}`;
        delete newEnv.PYTHONHOME;
    }

    return [command, commandArgs, newEnv];

}

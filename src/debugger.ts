import * as vscode from "vscode";
import * as child_process from "child_process";
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
export async function createAnsibleDebugAdapter(): Promise<vscode.DebugAdapterDescriptor> {
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

    const [command, commandArgs, newEnv] = await withPythonModule(
        config,
        "ansibug",
        ansibugArgs
    );

    const dapOptions: vscode.DebugAdapterExecutableOptions = {
        env: newEnv,
    };

    // DebugAdapterExecutable does not have a way to retrieve stderr when
    // failing to start. We do a quick test to ensure that ansibug is
    // available and can import using the same environment as the DAP.
    const [testOut, testRC] = await executeCommand(
        command,
        ["-m", "ansibug", "--help"],
        newEnv);
    if (testRC !== 0) {
        throw new Error(`Failed to start ansibug, process exited with ${testRC}: ${testOut}`);
    }

    return new vscode.DebugAdapterExecutable(command, commandArgs, dapOptions);
}

/**
 * Runs a command and returns the output and rc.
 * @param command - The command to run.
 * @param commandArgs - Arguments to provide to the command.
 * @param env - The environment to run the process with.
 * @returns The command output and return code.
 */
function executeCommand(
    command: string,
    commandArgs: string[],
    env: { [key: string]: string },
): Promise<[string, number]> {
    return new Promise((resolve, _) => {
        const proc = child_process.spawn(command, commandArgs, {
            env: env,
            shell: false,
            stdio: "pipe",
            windowsHide: true,
        });

        var procOut = "";
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (data) => {
            procOut += data.toString();
        });

        proc.stderr.setEncoding('utf8');
        proc.stderr.on('data', (data) => {
            procOut += data.toString();
        });

        proc.on('error', (error) => {
            var rc = -1;
            if ('errno' in error) {
                rc = error.errno as number;
            }
            resolve([error.message, rc]);
        });
        proc.on('close', (rc) => {
            resolve([procOut, rc ?? 0]);
        });
    });
}

/**
 * Builds the command, args, and env vars needed to run a Python module.
 * @param config - The extension configuration.
 * @param module - The python module to invoke.
 * @param moduleArgs - The arguments to invoke with the module.
 * @returns The executable, arguments, and environment variables to run.
 */
async function withPythonModule(
    config: vscode.WorkspaceConfiguration,
    module: string,
    moduleArgs: string[]
): Promise<[string, string[], { [key: string]: string }]> {
    // let command: string = "python4";

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

    let command = undefined;
    const interpreterPath = config.get(
        "interpreterPath", null
    ) ?? ansibleConfig.get("interpreterPath", null);
    if (interpreterPath) {
        command = interpreterPath;
        const virtualEnv = path.resolve(interpreterPath, "../..");
        const pathEntry = path.dirname(interpreterPath);

        newEnv.VIRTUAL_ENV = virtualEnv;
        newEnv.PATH = `${pathEntry}${path.delimiter}${process.env.PATH}`;
        delete newEnv.PYTHONHOME;
    }
    else {
        for (const pythonCandidate of ["python3", "python"]) {
            if (await isInPath(pythonCandidate, newEnv.PATH)) {
                command = pythonCandidate;
                break;
            }
        }

        if (command == undefined) {
            throw new Error("Failed to find Python interpreter in PATH to run ansibug");
        }
    }

    return [command, commandArgs, newEnv];

}

/**
 * Checks if the executable specified is in the PATH provided.
 * @param executable: The executable to check for.
 * @param envPath: The PATH env value to check.
 * @returns Whether the executable is in the PATH or not.
 */
async function isInPath(
    executable: string,
    envPath: string,
): Promise<boolean> {
    const pathSplit = envPath.split(path.delimiter) || [];
    for (const pathDir of pathSplit) {
        const testPath = path.join(pathDir, executable);

        try {
            const fsStat = await fs.promises.stat(testPath);
            if (fsStat.isFile()) {
                return true;
            }
        }
        catch (e) {
            continue;
        }
    }
    return false;
}

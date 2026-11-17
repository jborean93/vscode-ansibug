import * as vscode from 'vscode';

import {
    AnsibleDebugConfigurationProvider,
    DebuggerManager,
    DebuggerCommands,
    createAnsibleDebugAdapter,
} from "./debugger";

export function activate(context: vscode.ExtensionContext) {
    console.log('Starting ansibug extension');

    const debuggerManager = new DebuggerManager();
    const log = vscode.window.createOutputChannel("Ansibug", { log: true });
    context.subscriptions.push(log);
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory(
            "ansible",
            {
                createDebugAdapterDescriptor: async (session) => {
                    return await createAnsibleDebugAdapter(session, log);
                },
            }
        )
    );

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterTrackerFactory("ansible", {
            createDebugAdapterTracker: () => {
                // VS Code reports the stdio stream closing on a normal exit as
                // a "read error", only surface it if the adapter failed.
                let lastError = "";
                return {
                    onError: (e) => { lastError = e.message; },
                    onExit: (code, signal) => {
                        if (!code && !signal) {
                            log.info("ansibug dap exited");
                            return;
                        }
                        const hint = vscode.workspace.getConfiguration("ansibug").get("logFile")
                            ? "See ansibug.logFile for details."
                            : "Set ansibug.logFile to capture its log.";
                        const error = lastError ? ` (${lastError})` : "";
                        log.error(`ansibug dap exited with ${signal ? `signal ${signal}` : `code ${code}`}${error}. ${hint}`);
                    },
                };
            },
        })
    );

    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(
            "ansible",
            new AnsibleDebugConfigurationProvider()
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            DebuggerCommands.PICK_ANSIBLE_PLAYBOOK,
            () => {
                return debuggerManager.pickAnsiblePlaybook();
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            DebuggerCommands.PICK_ANSIBLE_PROCESS,
            () => {
                return debuggerManager.pickAnsibleProcess();
            }
        )
    );
}

export function deactivate() { }

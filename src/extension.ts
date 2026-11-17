import * as vscode from 'vscode';

import {
    AnsibleDebugConfigurationProvider,
    AnsiblePlaybookCodeLensProvider,
    DebuggerManager,
    DebuggerCommands,
    createAnsibleDebugAdapter,
    setPlaybookContext,
} from "./debugger";

export function activate(context: vscode.ExtensionContext) {
    console.log('Starting ansibug extension');

    const debuggerManager = new DebuggerManager(context.workspaceState);
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

    const codeLensProvider = new AnsiblePlaybookCodeLensProvider();
    context.subscriptions.push(
        vscode.commands.registerCommand(
            DebuggerCommands.DEBUG_PLAYBOOK,
            (uri?: vscode.Uri) => debuggerManager.debugPlaybook(uri, false)
        ),
        vscode.commands.registerCommand(
            DebuggerCommands.DEBUG_PLAYBOOK_WITH_ARGS,
            (uri?: vscode.Uri) => debuggerManager.debugPlaybook(uri, true)
        ),
        vscode.commands.registerCommand(
            DebuggerCommands.CLEAR_PLAYBOOK_ARGS,
            () => debuggerManager.clearPlaybookArgs()
        ),
        vscode.commands.registerCommand(
            DebuggerCommands.SAVE_PLAYBOOK_LAUNCH_CONFIG,
            (uri?: vscode.Uri) => debuggerManager.savePlaybookLaunchConfig(uri)
        ),
        codeLensProvider,
        vscode.languages.registerCodeLensProvider(
            [{ language: "ansible", scheme: "file" }, { language: "yaml", scheme: "file" }],
            codeLensProvider
        ),
        vscode.window.onDidChangeActiveTextEditor(setPlaybookContext),
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document === vscode.window.activeTextEditor?.document) {
                setPlaybookContext(vscode.window.activeTextEditor);
            }
        }),
    );
    setPlaybookContext(vscode.window.activeTextEditor);
}

export function deactivate() { }

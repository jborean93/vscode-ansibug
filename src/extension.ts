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
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory(
            "ansible",
            {
                createDebugAdapterDescriptor: async () => {
                    return await createAnsibleDebugAdapter();
                },
            }
        )
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

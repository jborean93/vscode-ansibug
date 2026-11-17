# Change Log

All notable changes to the "ansibug" extension will be documented in this file.

## 0.3.0 - TBD

+ Bumped the minimum VS Code version to `1.100.0`
+ Updated the development dependencies
+ Support `${workspaceFolder}` and relative paths in `ansibug.interpreterPath` and read it from the workspace folder of the debug session
+ When no interpreter is configured, try the interpreter selected in the Python Environments and Python extensions, then `.venv`/`venv` in the workspace, then `PATH`, using the first that has `ansibug` installed
+ Only set `VIRTUAL_ENV` when the interpreter is part of a virtual environment
+ Log the interpreters tried, the one used with its Python, ansibug and ansible-core versions, and the debug adapter exit status to the `Ansibug` output channel
+ Added `Debug` and `Debug with Args...` actions to playbooks, through a CodeLens at the top of the file and the editor title run menu, to debug without a launch configuration
  + The arguments are remembered per playbook and can be saved to `launch.json` with `Ansibug: Save Ansible Playbook Arguments as Launch Configuration` or cleared with `Ansibug: Clear Saved Ansible Playbook Arguments`
  + Set `ansibug.showCodeLens` to `false` to hide the CodeLens actions

## 0.2.0 - 2025-02-24

+ Added the extension option `ansibug.tempDir` to control the temporary directory used to store the Ansible launch script
+ Document the `env` option in a launch configuration for specifying environment variables

## 0.1.2 - 2024-05-03

+ Add extra logic for finding the Python interpreter in the PATH or from the settings

## 0.1.1 - 2024-05-03

+ Add basic check to verify `ansibug` can be spawned as the DAP process
+ Use the default scope for `ansibug.interpreterPath`

## 0.1.0 - 2024-05-02

+ Initial release

import { parse } from "yaml";

const PLAY_KEYS = ["hosts", "import_playbook", "ansible.builtin.import_playbook"];

/**
 * Checks if the YAML text looks like a playbook rather than a task or vars
 * file. The first play must start with name, hosts or import_playbook and
 * contain hosts or import_playbook.
 * @param text - The YAML document text.
 * @returns Whether the text is a playbook.
 */
export function isPlaybook(text: string): boolean {
    let data;
    try {
        // Silent so unknown tags like !vault don't log warnings.
        data = parse(text, { logLevel: "silent" });
    } catch {
        return false;
    }
    const play = Array.isArray(data) ? data[0] : undefined;
    if (!play || typeof play !== "object" || Array.isArray(play)) {
        return false;
    }
    const keys = Object.keys(play);
    return ["name", ...PLAY_KEYS].includes(keys[0]) && keys.some((k) => PLAY_KEYS.includes(k));
}

// shortcut: quotes only, no backslash escapes, upgrade if users need them.
const ARG = /(?:[^\s'"]+|'[^']*'|"[^"]*")+/g;

/**
 * Splits a command line string into arguments, single and double quotes
 * group text with spaces like a shell.
 * @param value - The command line string.
 * @returns The split arguments.
 */
export function splitArgs(value: string): string[] {
    if (/['"]/.test(value.replace(ARG, ""))) {
        throw new Error("Unterminated quote in arguments");
    }
    return (value.match(ARG) ?? []).map((a) => a.replace(/'([^']*)'|"([^"]*)"/g, "$1$2"));
}

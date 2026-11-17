import * as assert from "assert";

import { isPlaybook, splitArgs } from "../../playbook";

suite("isPlaybook", () => {
    test("play with hosts", () => {
        assert.ok(isPlaybook("---\n- name: play\n  hosts: all\n  tasks: []\n"));
        assert.ok(isPlaybook("- hosts: localhost\n"));
    });

    test("import_playbook", () => {
        assert.ok(isPlaybook("- import_playbook: other.yml\n"));
        assert.ok(isPlaybook("- ansible.builtin.import_playbook: other.yml\n"));
    });

    test("leading comments and document start", () => {
        assert.ok(isPlaybook("# comment\n\n---\n- name: play # x\n  vars:\n    a: 1\n  hosts: all\n"));
        assert.ok(isPlaybook("-   name: play\r\n    hosts: all\r\n"));
        assert.ok(isPlaybook("- {hosts: all}\n"));
        assert.ok(isPlaybook("- hosts: all\n  vars:\n    a: !vault |\n      abc\n"));
    });

    test("not a play", () => {
        assert.ok(!isPlaybook("- test: abc\n  hosts: localhost\n"));
        assert.ok(!isPlaybook("- name: task\n  block:\n    - hosts: x\n"));
        assert.ok(!isPlaybook("- name: task\n  debug:\n- name: other\n  hosts: all\n"));
        assert.ok(!isPlaybook(""));
        assert.ok(!isPlaybook("- hosts\n"));
        assert.ok(!isPlaybook("- a: [\n"));
    });

    test("task and vars files", () => {
        assert.ok(!isPlaybook("- name: task\n  ansible.builtin.debug:\n    msg: hosts\n"));
        assert.ok(!isPlaybook("hosts: value\nother: 1\n"));
    });
});

suite("splitArgs", () => {
    test("whitespace", () => {
        assert.deepStrictEqual(splitArgs("  -i inv   --check\t-v "), ["-i", "inv", "--check", "-v"]);
        assert.deepStrictEqual(splitArgs(""), []);
    });

    test("quotes", () => {
        assert.deepStrictEqual(
            splitArgs(`-e '{"a": "b c"}' -e "x=y z" --tags=''`),
            ["-e", '{"a": "b c"}', "-e", "x=y z", "--tags="]);
        assert.deepStrictEqual(splitArgs(`a"b c"d ''`), ["ab cd", ""]);
    });

    test("unterminated quote", () => {
        assert.throws(() => splitArgs(`-e "a`), /Unterminated quote/);
    });
});

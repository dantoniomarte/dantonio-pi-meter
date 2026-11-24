// Syntax gate over the whole loadable surface (Gitea issue #2 regression).
//
// package.json declares ./extensions/meter.ts as the package's only pi
// extension entry, so any file under extensions/ that fails to parse kills
// every pi process in the agent home at startup: the interactive shell and
// every subagent child exit 1 before running a single turn. 822b73b shipped
// exactly that: one stray brace, suite green, shell down.
//
// `node --check` is NOT a valid gate for TypeScript (it skips type stripping
// and both false-passes and false-fails); stripTypeScriptTypes runs the same
// strip+parse step the loader does, with no dependency resolution needed.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const extensionsDir = join(repoRoot, "extensions");
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
	pi?: { extensions?: string[] };
};

test("every extensions/*.ts parses, manifest entries included", () => {
	const declared = manifest.pi?.extensions ?? [];
	assert.ok(declared.length > 0, "package.json must declare at least one pi extension entry");

	const files = readdirSync(extensionsDir).filter((file) => file.endsWith(".ts")).sort();
	assert.ok(files.length > 0, "the gate found no extension files; extensions/ is the loadable surface");

	const failures: string[] = [];
	for (const file of files) {
		try {
			stripTypeScriptTypes(readFileSync(join(extensionsDir, file), "utf8"));
		} catch (error) {
			failures.push(`${file}: ${(error as Error).message}`);
		}
	}

	// The entry the loader executes must never sit outside the parsed set.
	for (const entry of declared) {
		const path = join(repoRoot, entry.replace(/^\.\//, ""));
		assert.ok(existsSync(path), `declared entry ${entry} must exist`);
		assert.ok(
			files.includes(basename(entry)),
			`declared entry ${entry} lives outside extensions/ and escapes this gate`,
		);
	}

	assert.deepStrictEqual(
		failures,
		[],
		`unparseable extension files (fatal for every pi process in the agent home):\n${failures.join("\n")}`,
	);
});

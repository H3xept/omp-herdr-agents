import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { allocateName, buildChildArgv, chooseModel } from "../src/agents";

const HERDR_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

describe("allocateName", () => {
	test("turns arbitrary labels into valid herdr agent names", () => {
		const taken = new Set<string>();
		for (const label of ["Scout", "My Reviewer!!", "42-fix", "___", "a".repeat(80)]) {
			expect(allocateName(label, taken)).toMatch(HERDR_NAME);
		}
	});

	test("never reuses a live or already-allocated name", () => {
		const taken = new Set(["scout"]);
		const first = allocateName("scout", taken);
		const second = allocateName("Scout", taken);
		expect(first).toBe("scout-2");
		expect(second).toBe("scout-3");
		expect(taken.has(first) && taken.has(second)).toBe(true);
	});
});

describe("buildChildArgv", () => {
	const base = { childExtension: "/x/child.ts", systemPromptFile: "/run/system-prompt.md", model: {} };
	const toolsFlag = (argv: string[]) => argv[argv.indexOf("--tools") + 1];

	test("an agent with a tool list can still message its parent", () => {
		expect(toolsFlag(buildChildArgv({ ...base, tools: ["read", "grep"] }))).toBe("read,grep,message_parent");
	});

	test("an agent without a tool list gets every tool", () => {
		expect(buildChildArgv({ ...base, tools: [] })).not.toContain("--tools");
	});
});

describe("chooseModel", () => {
	// Tests only read provider/id; a full Model carries pricing and limits irrelevant here.
	const opus = { provider: "anthropic", id: "claude-opus" } as unknown as Model;
	const flash = { provider: "openrouter", id: "glm-flash" } as unknown as Model;
	const models = {
		resolve: (spec: string) => (spec.startsWith("@smol") ? flash : spec.startsWith("anthropic/") ? opus : undefined),
		current: () => opus,
	};

	test("uses the first pattern that resolves, keeping the agent's thinking level", () => {
		expect(chooseModel(["@missing", "@smol"], "medium", models)).toEqual({ model: "openrouter/glm-flash", thinking: "medium" });
	});

	test("a thinking suffix on the winning pattern overrides the agent's level", () => {
		expect(chooseModel(["anthropic/claude-opus:high"], "low", models)).toEqual({
			model: "anthropic/claude-opus",
			thinking: "high",
		});
	});

	test("falls back to the session's current model when nothing resolves", () => {
		expect(chooseModel(["@missing"], undefined, models)).toEqual({ model: "anthropic/claude-opus", thinking: undefined });
	});
});

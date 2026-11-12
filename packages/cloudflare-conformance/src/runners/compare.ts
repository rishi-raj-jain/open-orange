import { isDeepStrictEqual } from "node:util";

import type { FixtureOutcome } from "./protocol.js";

export interface DifferentialFixture {
	cases: string[];
	id: string;
	modulePath: string;
	orangeEnv?: Record<string, unknown>;
	workerdConfigPath: string;
}

export interface DifferentialRunners {
	orange(
		modulePath: string,
		testCase: string,
		env?: Record<string, unknown>,
	): Promise<FixtureOutcome>;
	workerd(configPath: string, testCase: string): Promise<FixtureOutcome>;
}

async function captureOutcome(
	run: () => Promise<FixtureOutcome>,
): Promise<{ outcome?: FixtureOutcome; failure?: string }> {
	try {
		return { outcome: await run() };
	} catch (error: unknown) {
		return { failure: error instanceof Error ? error.message : String(error) };
	}
}

export function compareFixtureOutcomes(
	fixtureId: string,
	testCase: string,
	reference: FixtureOutcome,
	candidate: FixtureOutcome,
): string[] {
	return isDeepStrictEqual(reference, candidate)
		? []
		: [
				`differential fixture ${fixtureId}/${testCase} differed: workerd=${JSON.stringify(
					reference,
				)} orange=${JSON.stringify(candidate)}`,
			];
}

export async function checkDifferentialFixtures(
	fixtures: readonly DifferentialFixture[],
	runners: DifferentialRunners,
): Promise<string[]> {
	const errors: string[] = [];
	for (const fixture of fixtures) {
		for (const testCase of fixture.cases) {
			const [reference, candidate] = await Promise.all([
				captureOutcome(() => runners.workerd(fixture.workerdConfigPath, testCase)),
				captureOutcome(() =>
					runners.orange(fixture.modulePath, testCase, fixture.orangeEnv),
				),
			]);
			if (reference.failure !== undefined) {
				errors.push(
					`differential fixture ${fixture.id}/${testCase} workerd failed: ${reference.failure}`,
				);
			}
			if (candidate.failure !== undefined) {
				errors.push(
					`differential fixture ${fixture.id}/${testCase} Orange failed: ${candidate.failure}`,
				);
			}
			if (reference.outcome !== undefined && candidate.outcome !== undefined) {
				errors.push(
					...compareFixtureOutcomes(
						fixture.id,
						testCase,
						reference.outcome,
						candidate.outcome,
					),
				);
			}
		}
	}
	return errors;
}

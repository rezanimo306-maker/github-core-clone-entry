// Scenario constants, computed from the kit's fixed scenario seed
// (SCENARIO_SEED_HEX 6a09e667f3bcc909 in program/env/src/wire.ts).
// The seed is fixed in the kit, so the viewer/stranger identities are fixed too:
//   viewer adaiversen (id 1000), teammate quinnkeller, stranger olgabauer,
//   org faint-meadow-org, viewer's first repo amber-thistle (id 5000).
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const TEAMMATE_LOGIN = 'quinnkeller';
export const STRANGER_LOGIN = 'olgabauer';
export const ORG_LOGIN = 'faint-meadow-org';
export const VIEWER_FIRST_REPO = 'amber-thistle';
export const VIEWER_FIRST_REPO_ID = 5000;

// Identity the harness uses for git commits (CONFORMANCE_IDENTITY).
export const COMMIT_AUTHOR = 'Conformance <conformance@make.fun>';
export const COMMIT_EMAIL = 'conformance@make.fun';
// Bench epoch (bench.ts): commit timestamps during benchmarks.
export const BENCH_EPOCH = 1700000000;

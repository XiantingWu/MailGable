> Before opening a substantial code change, please open an issue first — see [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution model.

## Summary — what changed?

<!-- Brief description of the change. -->

## Why?

<!-- Problem, motivation, or linked proposal. -->

## How was it tested?

<!-- Commands, scenarios, and environments exercised locally. -->

## Impact

* Does it change deployment or operator steps? <!-- yes/no + notes -->
* Does it change the D1 schema? <!-- yes/no + migration file -->
* Does it change provider behavior or delivery semantics? <!-- yes/no + notes -->
* Does it change security or credentials handling? <!-- yes/no + notes -->
* Does documentation need updating? <!-- yes/no + files -->

## Verification Checklist

- [ ] `npm ci` succeeds
- [ ] `npm test` passes
- [ ] `npm run test:worker` passes
- [ ] `npm run check` passes
- [ ] `npm run test:e2e` passes
- [ ] Tests added or updated where applicable
- [ ] Documentation updated to match behavior
- [ ] No secrets, tokens, or personal email data were added

# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/khzhuman/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/khzhuman/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line tool that applies the edits AI models write to a tree of text files, in four formats: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. It finds the lines each edit names at the first of three matching tiers — exact, trailing-whitespace tolerant, then indentation tolerant — and writes every change or none, printing what it changed or why it failed. Node 22 and its standard library alone; `SPEC.md` is the whole contract.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

## The files

- `main.ts`: the CLI, run as `node main.ts [options] [PATCH]` with the working directory as the root of the tree. The patch comes from the PATCH file, or from standard input when PATCH is absent or `-`. `--format` picks one of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects it). `--check` does everything but write. `--strict` matches lines exactly.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit code, everything written to stdout and every file afterwards are exactly what SPEC.md says. Standard error is never compared. Practice: 100 of 100 passed, practice score 1000.

---

<sub>Entered on [make.fun](https://make.fun/?ref=kac21arh&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

# Testing

## Reproducing a load flake

A web test that passes alone but fails on a busy machine (CI, a shared host) depends on timing. Make it red on demand before fixing it:

1. Saturate the CPU with N busy loops, where N is 1 to 1.5 × `nproc`, and kill them on exit so none outlives the shell (bash; zsh does not word-split `$pids`):

   ```sh
   n=$(nproc)   # up to 1.5 × nproc
   pids=""
   trap 'kill $pids' EXIT
   for _ in $(seq "$n"); do node -e "while(1){}" & pids="$pids $!"; done
   ```

2. Run only the suspect files under that load: `pnpm --dir web test <files>`.
3. The reproduction counts when it is red at the base commit and green with the fix over 5 runs each. Then run the full `pnpm test:web` under the same load: it passes 5 runs in a row.

Reference numbers from #13 on a 4-core machine: 3 loops failed 2 of 5 runs, 6 loops failed 5 of 5.

The fix belongs in the test: fake timers, or awaiting the state the assertion needs. Production code and timeouts stay as they are (`CODING_STANDARDS.md`). `pnpm check:web` enforces the timeout half with `scripts/check-test-timeouts.mjs`: an explicit `timeout` option in a web test passes only with a `// test-timeout-allowed: <reason>` comment on the line above, for a wait on a real production delay at least as long as the 1 s default.

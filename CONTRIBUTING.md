# Contributing

Bug reports and setup questions are genuinely welcome — open an issue, or start a discussion if it's a
question rather than a defect. Please include what the issue template asks for; it's the difference between
one exchange and four.

## Pull requests

Small, focused changes are easiest to accept. For anything larger, open an issue first so we can agree on the
shape before you spend the time.

```bash
pnpm install
pnpm test        # lints the OpenAPI spec, checks the generated types match it, then runs the suite
pnpm typecheck
```

- **Conventional commits** (`fix:`, `feat:`, `docs:`, `refactor:`).
- **Tests green before you push.** The suite runs entirely against an in-memory simulator; nothing touches a
  real console.
- **Never point a test at real hardware.** `pnpm test:live` exists for that, it is opt-in, and it is not run
  in CI.
- **Changed the API?** Edit `contract/bridge.openapi.yaml`, run `pnpm contract:generate`, and commit the
  regenerated `src/contract.ts`. `pnpm test` fails if the two have drifted, and a separate test diffs the
  spec against the routes the server actually registers.
- **User-facing change?** Add a line to `CHANGELOG.md` under Unreleased. If it needs anyone to edit their
  configuration, it goes under **Action required** — people run this with `latest`.

## Things that are deliberately out of scope

One door per bridge. UniFi Protect only. No Home Assistant integration. These aren't oversights, and a PR
adding them is unlikely to be merged — please open an issue first if you disagree.

## Licence

By contributing you agree your work is licensed under Apache-2.0, as in `LICENSE`. Note `NOTICE`: the code is
free to fork, the name is not.

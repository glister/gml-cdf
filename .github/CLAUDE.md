# GitHub Actions security

- **SHA-pin all third-party actions.** Every `uses:` for an external action must
  reference a full 40-char commit SHA (immutable), with the version as a trailing
  comment, e.g. `uses: actions/checkout@<sha> # v4.2.2`. Tags like `@v4` are
  mutable and a supply-chain risk. Local actions (`uses: ./...`) are exempt.
  Resolve a SHA with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`.
- **`pnpm lint:pins`** (`scripts/check-action-pins.sh`) enforces this —
  dependency-free, run in pre-commit and the `workflow-lint` CI gate.
- **Dependabot** (`.github/dependabot.yml`, `github-actions` ecosystem) opens
  weekly PRs bumping each SHA and its version comment.
- **`.github/workflows/workflow-lint.yml`** runs on PRs touching `.github/**`: pin
  check + actionlint + a [zizmor](https://docs.zizmor.sh) audit
  (`--min-severity=medium --offline`), all **blocking**. A legitimate finding is
  dismissed with a documented `# zizmor: ignore[<audit>]` comment.

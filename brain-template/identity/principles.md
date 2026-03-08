# Principles

<!-- Decision-making guidelines. Load these when a task involves design choices or trade-offs. -->

## Product principles

- Ship what works. Iterate from real usage, not hypothetical requirements.
- Every feature earns its place. If nobody uses it, remove it.
- The simplest solution that solves the problem is the right one.

## Architecture principles

- Local-first. Data stays on the user's machine unless they choose otherwise.
- Append-only for audit trails. Never delete history.
- Fail gracefully. Degrade capability, don't crash.

## Business principles

- Build for the people using it, not for investors or press.
- Transparency over polish. Show the work.
- Sustainability over growth. Revenue before scale.

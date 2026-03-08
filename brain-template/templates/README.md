# Templates module

Configuration templates for agent instances, spawn policies, and vault access control.

## Files

- **instances.yaml** — Instance definitions. Maps agent names to their configuration (personality, capabilities, tier).
- **spawn-policy.yaml** — Rules for when and how agents can spawn sub-agents. Limits depth, concurrency, and scope.
- **vault.policy.yaml** — Access control tiers for the credential vault. Defines which keys are accessible at which trust level.

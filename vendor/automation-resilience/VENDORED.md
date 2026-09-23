# Vendored: automation-resilience

Copied verbatim from the reference host's `Skills/automation-resilience` on 2026-09-23 so a fresh
host needs nothing but this repository. `scripts/install.py` installs these files; it refuses to
overwrite an existing differing copy without `--force`.

Tests: `bun scripts/automation-resilience.test.ts` and `bun scripts/recovery-controller.test.ts`
(both pass from this directory).

```
8f4021eeb52b98ed374ff7141fe1eb7a9ec451964d3ad4f35bdc76d2c603c1c0  SKILL.md
68eda7b0b0b438aff5093f5e7b5b1de4da81cae88963a7a77f325ef1437a80f7  tsconfig.json
32ae61d9cd825f70432cca7be15a6ee2b35995f1ac2c356afe6e9ddd1f516bcd  scripts/audit-bridge-conformance.py
f08cb52f7c9bf2f7008e955f7e1001f6bd4b38ea4951950e5300bbd7f28aeaa2  scripts/automation-resilience.test.ts
b2232a7b705894220a3654e2e3c73adaa55e872b8f10bce65aacd9653284fbb1  scripts/automation-resilience.ts
ef4a5b3a10e0df9f2bdc7876d42a24ea361259de258ee5e8f119d1d1fcd598c2  scripts/recovery-controller.test.ts
c9aad82540ca9bf59413ba8663b2b6655670e5bf0fd10e09b06a3b148aff6563  scripts/recovery-controller.ts
951a3fd32c3bee328d457a7490d887b6866f71328ce695c270173b115a3e7d5f  scripts/recovery_verifiers.py
```

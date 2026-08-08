# Provider guard Wave 3 validation

This documentation-only change validates the Atlas Systems default-branch provider guard on `site-pulse`.

Expected protected path:

- pull requests required for the default branch;
- required native context `Worker validation`;
- required context `Gardener native auto-merge barrier`;
- deletion blocked;
- non-fast-forward updates blocked;
- zero required approvals;
- no bypass actors.

This file does not change visitor-analytics Worker source, workflows, provider settings, automation variables, deployment state, releases, or existing pull requests.

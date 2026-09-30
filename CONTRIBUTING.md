# Contributing

Open an issue to discuss a protocol change or a substantial feature before
implementing it. Small fixes can go directly to a pull request. Describe the
problem, the resulting behavior and the checks you ran.

Keep protocol contracts in `spec/` consistent with implementations and tests.
Preserve wire-format version numbers unless a deliberate contract change needs
a new version. Explain privacy effects, including which party receives each
field and whether it can connect reports to an account or browser activity.

Use fictional domains, identities and report contents in tests. Generate test
keys at runtime. Do not submit real ad captures, browsing history, account
credentials, signing keys, deployment identifiers or production data.

Run the checks in the root README and the tests for each affected Python package.
Use an isolated Redis instance for collector tests. The Docker demo verifies
issuance, encrypted delivery and collector behavior together. Format JavaScript
and TypeScript with `npm run format`.

Dependencies are declared per package with committed npm lockfiles. Keep changes
focused and explain new dependencies. Generated builds, local environments and
secret configuration are not committed. Deployment is managed separately from
pull-request checks; CI must not receive production credentials.

Contributions are made under this repository's MIT OR Apache-2.0 license. By
submitting a contribution, you confirm that you have the right to license it on
those terms. Retain existing copyright and third-party notices.

For security vulnerabilities, use the private reporting process in
[SECURITY.md](SECURITY.md), rather than a public issue.

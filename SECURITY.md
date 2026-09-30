# Security

Report vulnerabilities privately to **security@marcode.ai** or through
[GitHub's private vulnerability reporting](https://github.com/jointhefray/fray/security/advisories/new).
Include the affected commit, a minimal reproduction with fictional data, the
expected behavior and the potential impact. Do not include live credentials,
private keys, personal information or real browsing reports.

Security fixes are published on `main`. No long-term support branch is offered.

These are reference implementations. Publishing the source and passing its tests
do not constitute an independent security audit. Production operators must
provide account authentication, persistent keys, concurrency-safe quota storage,
transport access controls and appropriate abuse limits. Review reverse-proxy and
platform logging as well as application logging.

The OHTTP relay and gateway must be operated independently for the intended
separation of client network identity and report contents. Reports can retain
correlatable platform values as described in the protocol. Do not promise full
anonymity from transport encryption alone.

Please avoid testing against public infrastructure without prior coordination.
Use local services and fictional data for reproductions.

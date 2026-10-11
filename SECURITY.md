# Security

## Reporting

Email **support@garageopener.app** with "security" in the subject. Please don't open a public issue first.

You'll get an acknowledgement, and credit in the release notes if you want it. This is a solo project, so
expect a reply in days rather than hours.

## Scope

**In scope:** this repository — the bridge, its HTTP API, its handling of Protect credentials and bearer
tokens, and the published container image.

**Also welcome at the same address**, though the source isn't here: the cloud-alerts service at
`alerts.garageopener.app`, and the iOS and Android apps.

**Not in scope:** UniFi Protect itself (report those to Ubiquiti), and anything requiring physical access to
a machine already running the bridge.

## What has already been looked at

A review was carried out before this repository was published, covering authentication, rate limiting,
credential handling, resource exhaustion and the container image. Findings and fixes are in
[`docs/security-review.md`](docs/security-review.md). It is published deliberately: it says what was looked
for and what was found, including the things that were accepted rather than fixed.

Known low-severity gaps found since then are tracked as public issues, with a workaround where there is one.
Currently: [#5](https://github.com/pcrausaz/garage-opener-bridge/issues/5), where a revoked member's
already-open event stream keeps running until it disconnects or the bridge restarts.

## If you run this

Two things matter more than anything in this file:

- **`BRIDGE_TOKENS` opens your garage door.** Generate it (`openssl rand -hex 24`). The bridge refuses to
  start on anything short or guessable, but it cannot stop you reusing it elsewhere.
- **Don't port-forward it.** Use a VPN, a tunnel, or a reverse proxy with TLS. See
  https://garageopener.app/self-hosting.

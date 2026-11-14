# `discovery/` — device discovery

`DiscoveryService` aggregates one provider per device kind. The Android TV
provider shells out to `dns-sd`; tests feed recorded stdout fixtures into
the parser so they never spawn a subprocess.

`dnsSdOutput.ts` parses `dns-sd -B/-L/-G` output. Browse columns are padded
to 20 characters plus one space, so the instance name is everything after the
service-type token (never split on runs of whitespace).

PR-4 introduces `androidTvDiscovery.ts` and `DiscoveryService`.

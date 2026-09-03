# Update feed placeholders

Release CI overwrites the YAML files below and uploads the matching release artifacts. The committed feeds use version `0.0.0`, fake artifact names, fake SHA-512 values, and a one-byte size so electron-updater can parse their shape without mistaking them for a release.

Do not publish a release with these placeholder values. macOS feeds live under `mac/arm64` and `mac/x64`; Linux uses `linux/x64`. Keep update responses uncached so clients see a newly published version at once.

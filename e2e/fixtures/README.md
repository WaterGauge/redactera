# Synthetic PDF fixtures

These fixtures contain invented targets and public controls for automated tests. Do not replace them with real user documents.

The current fixture generator is generate-fixtures.py. It verifies page counts, target text, public controls and SHA256 values before product tests run. Cross-line targets are split across SEC and RET, so result verification checks the original pieces as well as the combined term. Image fixtures verify that sensitive pixels are removed from stored PDF images.

The run-e2e entry creates isolated copies and checks the originals again after testing. A PDF rendered with a black rectangle alone is insufficient to pass the final content checks.

See the [testing guide](../../docs/public/testing.md) for prerequisites, entry points and negative controls.

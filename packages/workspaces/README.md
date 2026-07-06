# Workspaces

`@sealant/workspaces` owns the workspace image lifecycle from build through deployment.

It currently provides:

- BuildKit-backed image compilation for Fedora, Arch, and Nix targets
- registry publishing client and helpers
- runtime adapter contracts and built-in adapter implementations
- workspace queue topology and API/worker queue helpers
- workspace lifecycle orchestration for worker job processing
- workspace API lifecycle mapping helpers

# Sandboxes

`@sealant/sandboxes` owns the sandbox image lifecycle from build through deployment.

It currently provides:

- BuildKit-backed image compilation for Fedora, Arch, and Nix targets
- registry publishing client and helpers
- runtime adapter contracts and built-in adapter implementations
- sandbox queue topology and API/worker queue helpers
- sandbox lifecycle orchestration for worker job processing
- sandbox API lifecycle mapping helpers

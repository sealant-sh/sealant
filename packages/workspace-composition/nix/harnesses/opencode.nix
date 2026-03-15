{ opencodePkg }:
{
  # OpenCode is the first real harness we execute in-container today.
  banner = "Starting OpenCode workspace";
  command = "exec ${opencodePkg}/bin/opencode";
  packages = [ opencodePkg ];
}

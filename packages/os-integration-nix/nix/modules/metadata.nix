{
  pkgs,
  spec,
}:
{
  # Embed the final normalized spec in the image so launched workspaces can
  # introspect what they were built from.
  specJson = pkgs.writeTextDir "etc/zweit/spec.json" (builtins.toJSON spec);
}

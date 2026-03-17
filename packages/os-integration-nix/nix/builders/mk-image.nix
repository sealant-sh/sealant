{
  pkgs,
  spec,
  env,
  entrypoint,
  locale,
  envVars,
}:
# Turn the assembled environment closure into a Docker/OCI image. The image is
# intentionally thin: almost all interesting behavior lives in the entrypoint.
pkgs.dockerTools.buildLayeredImage {
  name = spec.imageName;
  tag = spec.harness;

  contents = [ env ];

  config = {
    # Publish the SSH port in image metadata even though sshd only starts when
    # the runtime flag enables it.
    Cmd = [ "${entrypoint}/bin/workspace-entrypoint" ];
    ExposedPorts = {
      "2222/tcp" = { };
    };
    WorkingDir = "/workspace";
    Env = [
      "PATH=/bin"
    ]
    ++ locale.env
    ++ [
      "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "NIX_SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      "GIT_SSL_CAINFO=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
    ]
    ++ envVars;
  };
}

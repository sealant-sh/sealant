{ spec }:
{
  # Repo checkout is a runtime concern so the same image can launch against a
  # fresh repository state without rebuilding.
  checkoutScript = ''
    printf '%s\n' 'Repo: ${spec.repoUrl}'
    printf '%s\n' 'Ref: ${spec.repoRef}'
    printf '%s\n' 'Spec file: /etc/zweit/spec.json'

    if [ ! -d repo/.git ]; then
      git clone --branch '${spec.repoRef}' '${spec.repoUrl}' repo
    fi

    cd repo
  '';
}

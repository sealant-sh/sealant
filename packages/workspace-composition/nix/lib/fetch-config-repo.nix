{ spec }:
# Config repos are fetched only when a spec asks for imported Home Manager
# modules. The spec must already be normalized and pinned.
if spec.nixConfig == null then
  null
else
  builtins.fetchGit {
    url = spec.nixConfig.repoUrl;
    ref = spec.nixConfig.repoRef;
    rev = spec.nixConfig.repoRev;
  }

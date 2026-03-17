{
  homeManagerLib,
  pkgs,
  spec,
  configRepo,
}:
let
  lib = pkgs.lib;

  homeManagerModules =
    # Module paths come from the external config repo pinned by the spec.
    if spec.nixConfig == null then
      [ ]
    else
      map (modulePath: configRepo + "/${modulePath}") spec.nixConfig.homeManagerModules;

  homeConfiguration =
    # We build a root-owned Home Manager configuration because these demo
    # containers currently run as root for simplicity.
    if homeManagerModules == [ ] then
      null
    else
      homeManagerLib.homeManagerConfiguration {
        inherit pkgs;

        modules = [
          {
            home.username = "root";
            home.homeDirectory = "/root";
            home.stateVersion = "25.11";
            programs.home-manager.enable = false;
          }
        ]
        ++ homeManagerModules;
      };

  homeActivationPackage =
    if homeConfiguration == null then null else homeConfiguration.activationPackage;
in
{
  inherit homeActivationPackage;

  # Add the activation package to the image closure only when a config repo is
  # in play.
  extraPackages = lib.optionals (homeActivationPackage != null) [ homeActivationPackage ];

  # SSH sessions need the Home Manager PATH too or imported tools like tmux and
  # nvim will not be visible after login.
  sshSetEnv = lib.optionalString (
    homeActivationPackage != null
  ) "SetEnv PATH=${homeActivationPackage}/home-path/bin:/bin";

  # Home Manager gives us the imported editor and shell config as immutable
  # files in the store. We copy those into /root so the container behaves like a
  # normal long-lived home directory without rebuilding the image for each repo.
  activationScript = lib.optionalString (homeActivationPackage != null) ''
        cp -a ${homeActivationPackage}/home-files/. "$HOME/"
        export PATH=${homeActivationPackage}/home-path/bin:$PATH

        if [ -f ${homeActivationPackage}/hm-session-vars.sh ]; then
          . ${homeActivationPackage}/hm-session-vars.sh
        fi

        # The imported Neovim config expects `nvim-treesitter.configs`, while the
        # packaged runtime currently exposes `nvim-treesitter.config`.
        if [ -f "$HOME/.local/share/nvim/site/pack/hm/start/nvim-treesitter/lua/nvim-treesitter/config.lua" ] && [ ! -f "$HOME/.config/nvim/lua/nvim-treesitter/configs.lua" ]; then
          mkdir -p "$HOME/.config/nvim/lua/nvim-treesitter"
          cat > "$HOME/.config/nvim/lua/nvim-treesitter/configs.lua" <<'EOF'
    return require("nvim-treesitter.config")
    EOF
        fi
  '';
}

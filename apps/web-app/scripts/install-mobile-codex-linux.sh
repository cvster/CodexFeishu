#!/usr/bin/env bash
set -euo pipefail

workspace="${MOBILE_CODEX_INSTALL_ROOT:-/home/pc/software/mobileCodexHelper}"
private_ip="${MOBILE_CODEX_PRIVATE_IP:-192.168.188.1}"
node_path="${MOBILE_CODEX_NODE:-/home/pc/.nvm/versions/node/v24.20.0/bin/node}"
npm_path="${MOBILE_CODEX_NPM:-/home/pc/.nvm/versions/node/v24.20.0/bin/npm}"
codex_cli="${MOBILE_CODEX_CLI:-/home/pc/.nvm/versions/node/v24.20.0/bin/codex}"
service_name="mobile-codex-helper.service"

if [[ "$(id -un)" != "pc" ]]; then
  echo "Run this installer as the pc user." >&2
  exit 1
fi

for executable in "$node_path" "$npm_path" "$codex_cli"; do
  if [[ ! -x "$executable" ]]; then
    echo "Required executable not found: $executable" >&2
    exit 1
  fi
done

if [[ ! -d "$workspace/vendor/claudecodeui-1.25.2" ]]; then
  echo "Deployment tree not found: $workspace" >&2
  exit 1
fi

if ! [[ "$private_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "MOBILE_CODEX_PRIVATE_IP must be an IPv4 address: $private_ip" >&2
  exit 1
fi

export PATH="$(dirname "$node_path"):/usr/local/bin:/usr/bin:/bin"
export MOBILE_CODEX_UPSTREAM_DIR="$workspace/vendor/claudecodeui-1.25.2"

"$workspace/scripts/apply-upstream-overrides.sh"

pushd "$workspace/vendor/claudecodeui-1.25.2" >/dev/null
"$npm_path" ci
"$npm_path" run build
popd >/dev/null

install -d -m 0700 "$HOME/.cloudcli"
install -d -m 0755 "$HOME/.config/systemd/user"

service_source="$workspace/deploy/mobile-codex-helper.service.in"
service_target="$HOME/.config/systemd/user/$service_name"
sed \
  -e "s|__WORKSPACE__|$workspace|g" \
  -e "s|__NODE_DIR__|$(dirname "$node_path")|g" \
  -e "s|__CODEX_CLI__|$codex_cli|g" \
  -e "s|__NODE__|$node_path|g" \
  -e "s|__HOME__|$HOME|g" \
  "$service_source" > "$service_target"

nginx_source="$workspace/deploy/nginx-mobile-codex-linux.conf.in"
nginx_rendered="$(mktemp)"
trap 'rm -f "$nginx_rendered"' EXIT
sed "s|__PRIVATE_IP__|$private_ip|g" "$nginx_source" > "$nginx_rendered"

if ! command -v nginx >/dev/null 2>&1; then
  sudo -n apt-get update
  sudo -n apt-get install -y nginx
fi

sudo -n install -m 0644 "$nginx_rendered" /etc/nginx/conf.d/mobile-codex-helper.conf
sudo -n nginx -t

systemctl --user daemon-reload
systemctl --user enable --now "$service_name"
sudo -n systemctl enable --now nginx
sudo -n systemctl reload nginx

echo "mobileCodexHelper installed at $workspace"
echo "Private URL: http://$private_ip:8080"

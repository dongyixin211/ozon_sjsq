#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ozon-sjsq-cloud}"
APP_USER="${APP_USER:-ozoncloud}"
NODE_MAJOR="${NODE_MAJOR:-22}"

echo "[INFO] Installing base packages..."
apt-get update
apt-get install -y ca-certificates curl gnupg nginx postgresql postgresql-contrib unzip

if ! command -v node >/dev/null 2>&1; then
  echo "[INFO] Installing Node.js ${NODE_MAJOR}..."
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi

if ! id "${APP_USER}" >/dev/null 2>&1; then
  echo "[INFO] Creating app user ${APP_USER}..."
  useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"
fi

mkdir -p "${APP_DIR}" "${APP_DIR}/uploads" "${APP_DIR}/mockup-templates"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
chmod -R u+rwX,g+rwX "${APP_DIR}/uploads" "${APP_DIR}/mockup-templates"

echo "[INFO] Done."
echo "[NEXT] Copy project server files to ${APP_DIR}, then configure .env and systemd."

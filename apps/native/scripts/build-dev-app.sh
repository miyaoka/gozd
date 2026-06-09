#!/usr/bin/env bash
#
# dev 用の minimal `.app` バンドル。pnpm dev が毎回呼ぶ。
#
# 経由する理由: macOS 26 Tahoe は `.app` 起動のみ Dock アイコンに squircle mask を
# 自動適用する。`swift run` 直叩きや `applicationIconImage` runtime 設定は対象外で
# 角丸にならない。dev でも prod と同じ見た目を得るため、軽量 `.app` を用意して
# 内部 binary を exec する経路にする。
#
# 本番の build-app.sh と違い、renderer は Vite dev server から配信するので
# バンドルに同梱しない。CLI / zsh も dev では不要。
#
# 出力: apps/native/.build/app/Gozd-Dev.app
set -euo pipefail

# dev port は env `GOZD_DEV_VITE_PORT` (root `pnpm dev` script が SSOT として設定) を必須にする。
# サブパッケージ単体 (`pnpm --filter @gozd/native dev` 等) で env を渡さずに起動された場合、
# Swift app は dev origin allowlist が空のまま立ち上がり全 RPC fetch がブロックされて
# silent broken になる。それを fail-fast で顕在化させる (`fallback せずエラーにする` 規約)。
: "${GOZD_DEV_VITE_PORT:?GOZD_DEV_VITE_PORT must be set by root 'pnpm dev' script}"

NATIVE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Gozd-Dev.app"
APP_DIR="$NATIVE_DIR/.build/app/$APP_NAME"
APP_RESOURCES="$APP_DIR/Contents/Resources"

cd "$NATIVE_DIR"
swift build --product gozd-cli
swift build --product Gozd

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_RESOURCES"

cp "$NATIVE_DIR/.build/debug/Gozd" "$APP_DIR/Contents/MacOS/Gozd"

iconutil -c icns "$NATIVE_DIR/Resources/icon.dev.iconset" -o "$APP_RESOURCES/AppIcon.icns"

cat > "$APP_DIR/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Gozd</string>
  <key>CFBundleIdentifier</key>
  <string>io.github.miyaoka.gozd.dev</string>
  <key>CFBundleName</key>
  <string>gozd-dev</string>
  <key>CFBundleDisplayName</key>
  <string>gozd-dev</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>
  <string>26.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

exec "$APP_DIR/Contents/MacOS/Gozd"

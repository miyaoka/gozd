#!/usr/bin/env bash
#
# gozd の `.app` バンドルを生成する。署名 / notarize は行わない（unsigned 配布前提）。
# Phase 4 配布: GitHub Releases に zip / dmg を上げる流れの前段階。
#
# 出力: apps/native/build/Gozd.app
#
# レイアウト（旧 Electrobun 版の構造を踏襲）:
#   Gozd.app/Contents/
#     Info.plist
#     MacOS/Gozd                              ← Swift メインバイナリ
#     Resources/app/
#       views/main/                           ← renderer の Vite ビルド成果物
#       bin/gozd                              ← シェルラッパー
#       bin/gozd-cli                          ← Swift CLI バイナリ
#       zsh/                                  ← gozd zsh init ファイル一式
#
set -euo pipefail

NATIVE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_DIR="$(cd "$NATIVE_DIR/../.." && pwd)"
RENDERER_DIR="$ROOT_DIR/apps/renderer"
DESKTOP_ZSH_DIR="$ROOT_DIR/apps/desktop/zsh"

# Phase 4 移行期は旧 Electrobun 版（Gozd.app）と並走させるため `Gozd-Swift.app` 名にする。
# Phase 5 で旧を消したら `Gozd.app` に戻す。
APP_NAME="Gozd-Swift.app"
OUT_DIR="$NATIVE_DIR/build"
APP_DIR="$OUT_DIR/$APP_NAME"
APP_RESOURCES="$APP_DIR/Contents/Resources/app"

echo "==> Cleaning $APP_DIR"
rm -rf "$APP_DIR"

echo "==> Building Swift binaries (release)"
cd "$NATIVE_DIR"
swift build -c release --product Gozd
swift build -c release --product gozd-cli

echo "==> Building renderer"
cd "$RENDERER_DIR"
pnpm build

echo "==> Constructing .app bundle"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_RESOURCES/views/main"
mkdir -p "$APP_RESOURCES/bin"
mkdir -p "$APP_RESOURCES/zsh"

# Swift バイナリ
cp "$NATIVE_DIR/.build/release/Gozd" "$APP_DIR/Contents/MacOS/Gozd"
cp "$NATIVE_DIR/.build/release/gozd-cli" "$APP_RESOURCES/bin/gozd-cli"

# シェルラッパー（既に chmod +x 済）
cp "$NATIVE_DIR/Resources/bin/gozd" "$APP_RESOURCES/bin/gozd"
chmod +x "$APP_RESOURCES/bin/gozd" "$APP_RESOURCES/bin/gozd-cli"

# renderer 成果物
cp -R "$RENDERER_DIR/dist/." "$APP_RESOURCES/views/main/"

# zsh init チェーン（ドットファイルも含む）
cp -R "$DESKTOP_ZSH_DIR/." "$APP_RESOURCES/zsh/"

# Info.plist。最小限のキーのみ。GitHub Releases 配布で必要十分。
cat > "$APP_DIR/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Gozd</string>
  <key>CFBundleIdentifier</key>
  <string>io.github.miyaoka.gozd-swift</string>
  <key>CFBundleName</key>
  <string>gozd-swift</string>
  <key>CFBundleDisplayName</key>
  <string>gozd-swift</string>
  <key>CFBundleVersion</key>
  <string>0.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>0.0.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>26.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

echo "==> Built: $APP_DIR"

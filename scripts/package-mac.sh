#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$root"
pnpm test
swift test --package-path apps/macos
swift build --package-path apps/macos --configuration release
bin=$(swift build --package-path apps/macos --configuration release --show-bin-path)/Permac
app="$root/dist/Permac.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/Permac"
cp "$root/apps/macos/Resources/Logo.png" "$app/Contents/Resources/Logo.png"
cp "$root/apps/macos/Resources/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
cat > "$app/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Permac</string>
  <key>CFBundleIdentifier</key><string>local.permac.agent</string>
  <key>CFBundleName</key><string>Permac</string>
  <key>CFBundleDisplayName</key><string>Permac</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
codesign --force --sign - "$app"
if find "$app" -iname '*openmuse*' -o -iname '*react*' | grep -q .; then
  echo "Package contains an excluded UI bundle" >&2
  exit 1
fi
echo "Ad-hoc signed $app"
echo "Clean-account permission tests and Developer ID signing still need a signing identity and a fresh macOS user."

// electron-builder afterPack hook; add Sparkle before the app is code-signed.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

module.exports = async function pack({ appOutDir }) {
  const sdk = process.env.ROPPO_SPARKLE_SDK || path.resolve(__dirname, '../../../.local/sparkle-2.10.1')
  if (!path.isAbsolute(sdk) || !fs.existsSync(path.join(sdk, 'Sparkle.framework'))) throw new Error('Set ROPPO_SPARKLE_SDK to the extracted Sparkle SDK directory.')
  const sdkVersion = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(sdk, 'Sparkle.framework/Resources/Info.plist')], { encoding:'utf8' }).trim()
  if (sdkVersion !== '2.10.1') throw new Error('Expected Sparkle 2.10.1')
  const contents = path.join(appOutDir, 'Roppo.app/Contents')
  const framework = path.join(contents, 'Frameworks/Sparkle.framework')
  execFileSync('/usr/bin/ditto', [path.join(sdk, 'Sparkle.framework'), framework])
  fs.copyFileSync(path.join(sdk, 'LICENSE'), path.join(contents, 'Resources/Sparkle-LICENSE.txt'))
  const nodeInclude = path.resolve(path.dirname(process.execPath), '../include/node')
  execFileSync('xcrun', ['clang', '-arch', 'arm64', '-mmacosx-version-min=12.0', '-bundle', '-fobjc-arc',
    '-undefined', 'dynamic_lookup', '-I', nodeInclude, '-F', sdk, '-framework', 'Sparkle', '-framework', 'AppKit',
    '-Wl,-rpath,@loader_path/../Frameworks', path.join(__dirname, 'bridge.m'),
    '-o', path.join(contents, 'Resources/roppo-sparkle.node')], { stdio: 'inherit' })
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import {packageDesktopRuntime} from './src/desktop-runtime.ts'; await packageDesktopRuntime(process.argv[1], process.env.ROPPO_DESKTOP_RUNTIME_ARCHIVE);",
    path.join(contents, 'Resources/desktop-runtime')], {
    cwd:path.resolve(__dirname, '../../..'), stdio:'inherit',
  })
}

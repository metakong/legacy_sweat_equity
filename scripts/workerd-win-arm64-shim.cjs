/**
 * Lets wrangler run natively on Windows ARM64.
 *
 * THE PROBLEM
 * `workerd` (required at module load by the wrangler CLI, whatever subcommand
 * you run) resolves its native binary from a fixed table:
 *
 *     darwin arm64 | darwin x64 | linux arm64 | linux x64 | win32 x64
 *
 * There is no `win32 arm64` entry, so on this machine wrangler throws
 * `Unsupported platform: win32 arm64 LE` before executing anything — including
 * `deploy`, which never actually spawns workerd.
 *
 * THE FIX
 * Windows 11 on ARM64 runs x64 binaries under emulation, so the x64 workerd
 * build is usable here. This preload reports `x64` to workerd's platform check
 * only, then restores the real value.
 *
 * WHY IT IS SURGICAL
 * `os.arch()` is patched for exactly one `require('workerd')` call and restored
 * in a `finally`. A blanket override would break esbuild, which resolves its
 * own native binary the same way and DOES have a real win32-arm64 build
 * installed (`node_modules/@esbuild/win32-arm64`). Lying to esbuild would send
 * it looking for an x64 package that is not there.
 *
 * REQUIREMENT
 * The x64 workerd package has to be present. npm refuses it on this cpu, so:
 *
 *     npm install --no-save --force @cloudflare/workerd-windows-64@<version>
 *
 * Match <version> to `node_modules/workerd/package.json`. It is --no-save on
 * purpose: it is a machine-specific workaround, not a project dependency.
 *
 * USAGE
 *     npm run deploy          (wired up in package.json)
 * or  node --require ./scripts/workerd-win-arm64-shim.cjs \
 *          node_modules/wrangler/bin/wrangler.js <command>
 */

const os = require('os');

// Only engage on the platform that needs it; everywhere else this is a no-op
// so the same npm script keeps working on a normal machine.
if (process.platform === 'win32' && os.arch() === 'arm64') {
  const realArch = os.arch;
  os.arch = () => 'x64';

  try {
    // Resolving from cwd rather than this file keeps it working regardless of
    // where the script is invoked from. The require populates Node's module
    // cache, so wrangler's own later require gets the already-resolved module
    // and never re-runs the platform check.
    require(require.resolve('workerd', { paths: [process.cwd()] }));
  } catch (err) {
    // Restore first, then report — a broken shim must not also corrupt arch
    // reporting for everything downstream.
    os.arch = realArch;
    console.error(
      '[workerd-win-arm64-shim] Could not preload workerd.\n'
      + '  Install the x64 build:  npm install --no-save --force @cloudflare/workerd-windows-64@'
      + `${safeWorkerdVersion()}\n`
      + `  Underlying error: ${err.message}`
    );
    throw err;
  }

  os.arch = realArch;
}

function safeWorkerdVersion() {
  try {
    return require(require.resolve('workerd/package.json', { paths: [process.cwd()] })).version;
  } catch {
    return '<see node_modules/workerd/package.json>';
  }
}

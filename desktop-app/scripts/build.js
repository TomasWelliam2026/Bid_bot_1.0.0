// Builds the Windows app: dist/Valiant Sisu Bid Bot-win32-x64/Valiant Sisu Bid Bot.exe.
//
//   npm run build
//
// The app's own files and its runtime dependencies go in as they are (no
// asar: the Chrome DevTools MCP server is started as a Node script of its
// own, and reads its files from disk). The extension it runs goes in beside
// them as resources/extension, which is where main.js looks for it once
// packaged. The icon is the logo, as a Windows .ico.

const fs = require("node:fs");
const path = require("node:path");
const { packager } = require("@electron/packager");

const APP = path.resolve(__dirname, "..");
const BUILD = path.join(APP, "build");
const EXTENSION_SRC = path.resolve(APP, "..", "jobright-monitor");
const NAME = "Valiant Sisu Bid Bot";

// The extension's files, less what only its development needs.
function stageExtension() {
  const to = path.join(BUILD, "extension");
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(EXTENSION_SRC, to, {
    recursive: true,
    filter: (src) => !path.relative(EXTENSION_SRC, src).split(path.sep).includes(".claude")
  });
  return to;
}

// A .ico holding the logo as one 256×256 PNG, which Windows (Vista and
// later) reads directly and scales for the smaller sizes.
function writeIcon() {
  const png = fs.readFileSync(path.join(APP, "assets", "logo.png"));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); // width 256
  entry.writeUInt8(0, 1); // height 256
  entry.writeUInt8(0, 2); // no palette
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset of the image data
  const file = path.join(BUILD, "icon.ico");
  fs.writeFileSync(file, Buffer.concat([header, entry, png]));
  return file;
}

(async () => {
  fs.mkdirSync(BUILD, { recursive: true });
  const extension = stageExtension();
  const icon = writeIcon();

  const [out] = await packager({
    dir: APP,
    out: path.join(APP, "dist"),
    name: NAME,
    executableName: NAME,
    platform: "win32",
    arch: "x64",
    icon,
    asar: false,
    overwrite: true,
    prune: true, // devDependencies (Electron itself, this packager) stay out
    extraResource: [extension],
    ignore: [/^\/test($|\/)/, /^\/build($|\/)/, /^\/dist($|\/)/, /^\/scripts($|\/)/, /^\/start\.bat$/],
    win32metadata: {
      CompanyName: "Valiant Sisu",
      FileDescription: NAME,
      ProductName: NAME,
      InternalName: NAME
    }
  });
  console.log(`Built: ${path.join(out, `${NAME}.exe`)}`);
})().catch((err) => {
  console.error("Build failed:", err?.stack || err);
  process.exit(1);
});

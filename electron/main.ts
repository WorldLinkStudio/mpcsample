/**
 * main.ts — Electron main process for MPC Sample.
 *
 * Security model:
 * - contextIsolation: true, sandbox: true, nodeIntegration: false
 * - MIDI + display-capture permissions granted (Web MIDI API; getDisplayMedia
 *   for the sample recorder's system/app-audio capture); Web Audio itself
 *   requires no permission grant.
 * - CSP via onHeadersReceived: allows bundled assets, inline styles (Tailwind v4),
 *   data/blob URLs, and Google Fonts; `unsafe-eval` only in dev for Vite HMR.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  session,
  shell,
} from "electron";

/**
 * Enables macOS system-audio loopback capture for the sample recorder.
 *
 * Must run before `app.whenReady()` (Chromium feature switches only take
 * effect if set before the app is ready) — `useSystemPicker`'s native macOS
 * picker never actually returns an audio track (confirmed: Electron issue
 * electron/electron#44685, still unresolved).
 *
 * The direct-grant approach (`audio: "loopback"` in `handleDisplayMediaRequest`
 * below) initially returned a live-looking audio track that was actually dead
 * (`readyState: "ended"`, zero signal, no error) — root-caused against
 * electron/electron#49607: recent Chromium defaults to Apple's new CoreAudio
 * Tap API (`MacCatapLoopbackAudioForScreenShare`, on by default) for macOS
 * loopback capture, which requires a *different*, newly-introduced Info.plist
 * key (`NSAudioCaptureUsageDescription`, added in `electron-builder.yml`) that
 * almost nothing has yet — and when that's missing, Chromium fails silently
 * with **no fallback** to the old, already-working
 * `NSScreenCaptureUsageDescription`-gated method. Disabling the new path
 * forces the proven fallback; `MacSckSystemAudioLoopbackOverride` additionally
 * forces ScreenCaptureKit-based loopback within that fallback regardless of
 * OS version.
 */
app.commandLine.appendSwitch("enable-features", "MacSckSystemAudioLoopbackOverride");
app.commandLine.appendSwitch("disable-features", "MacCatapLoopbackAudioForScreenShare");

const execFileAsync = promisify(execFile);

import type {
  DefaultExportDir,
  DesktopError,
  DesktopErrorCode,
  LibraryEntry,
  LibraryProgressUpdate,
  LibraryTags,
  LoadedProject,
  WriteProjectArgs,
  WriteProjectResult,
} from "../src/desktop/bridge.types";
import { readProjectFromFile, writeProjectToDisk } from "./fsops";
import type { IpcResult } from "./ipc";
import { CH, LIBRARY_PROGRESS_EVENT } from "./ipc";
import { DEFAULT_EXPORT_DIR, findSdVolume, getDefaultExportDir, VOLUME_ROOT } from "./paths";
import {
  decodeSampleMeta,
  diffAgainstCache,
  type LibraryCache,
  parseAudioFormat,
  readCacheFile,
  readTagsFile,
  scanDirectory,
  writeCacheFile,
  writeTagsFile,
} from "./sampleLibrary";

// mpc-sample:// must be registered as privileged before app.whenReady().
protocol.registerSchemesAsPrivileged([
  {
    scheme: "mpc-sample",
    privileges: {
      standard: false,
      secure: true,
      supportFetchAPI: true,
      // The renderer is served from http://localhost (dev) / file:// (packaged),
      // so fetch() of mpc-sample:// is cross-origin and needs CORS opted in.
      corsEnabled: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

function normalizeError(err: unknown): DesktopError {
  if (err instanceof Error) {
    const typed = err as Error & { code?: unknown };
    const knownCodes = new Set<DesktopErrorCode>([
      "CANCELLED",
      "EEXIST",
      "ENOENT",
      "EACCES",
      "ENOXPJ",
      "EUNKNOWN",
    ]);
    const rawCode = String(typed.code ?? "EUNKNOWN");
    const code: DesktopErrorCode = knownCodes.has(rawCode as DesktopErrorCode)
      ? (rawCode as DesktopErrorCode)
      : "EUNKNOWN";
    return { code, message: err.message };
  }
  return { code: "EUNKNOWN", message: String(err) };
}

function ok<T>(result: T): IpcResult<T> {
  return { ok: true, result };
}

function fail(err: unknown): IpcResult<never> {
  return { ok: false, error: normalizeError(err) };
}

// Natural MPC dimensions at 100 % zoom (content area, no title-bar).
const BASE_W = 920;
const BASE_H = 960;

/** The single main window, kept around so library-scan progress can be pushed to it. */
let mainWindowRef: BrowserWindow | null = null;

/**
 * Absolute root directories the user has explicitly scanned via the Sample
 * Browser. `mpc-sample://` only ever serves files under one of these — this
 * is the path-traversal guard for the custom protocol.
 */
const allowedLibraryRoots = new Set<string>();

/** Incremented on every new scan / explicit cancel so a stale background decode loop stops early. */
let libraryScanToken = 0;

const DECODE_CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length));

function libraryCachePath(rootDir: string): string {
  const hash = createHash("sha1").update(rootDir).digest("hex");
  return path.join(app.getPath("userData"), "sample-library-cache", `${hash}.json`);
}

/** Separate from the decode cache — manual tags are user edits, not derived file facts. */
function libraryTagsPath(rootDir: string): string {
  const hash = createHash("sha1").update(rootDir).digest("hex");
  return path.join(app.getPath("userData"), "sample-library-tags", `${hash}.json`);
}

function sendLibraryProgress(update: LibraryProgressUpdate): void {
  mainWindowRef?.webContents.send(LIBRARY_PROGRESS_EVENT, update);
}

/**
 * Resolve the file list for `rootDir` (cache-hit rows returned as-is), then
 * kick off a throttled background decode pass for cache-miss rows, streaming
 * each result to the renderer as it completes and persisting the updated
 * cache incrementally. Never blocks the event loop for long: enumeration is
 * plain `fs` I/O, and decode work yields between files (see `sampleLibrary.ts`).
 */
async function runLibraryScan(rootDir: string): Promise<LibraryEntry[]> {
  const myToken = ++libraryScanToken;
  allowedLibraryRoots.add(path.resolve(rootDir));

  const [files, cache] = await Promise.all([
    scanDirectory(rootDir),
    readCacheFile(libraryCachePath(rootDir)),
  ]);
  const { cached, toDecode } = diffAgainstCache(files, cache);

  const initial: LibraryEntry[] = [...cached, ...toDecode];

  if (toDecode.length === 0) {
    sendLibraryProgress({ done: true });
    return initial;
  }

  // Fire-and-forget: the caller already has `initial` to render immediately;
  // decode results stream in via LIBRARY_PROGRESS_EVENT.
  void (async () => {
    const nextCache: LibraryCache = {
      rootDir,
      scannedAt: Date.now(),
      files: Object.fromEntries(
        cached.map((e) => [e.relPath, e as unknown as LibraryCache["files"][string]]),
      ),
    };

    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < toDecode.length) {
        if (myToken !== libraryScanToken) return; // superseded by a newer scan/cancel
        const file = toDecode[cursor++];
        const meta = await decodeSampleMeta(file);
        if (myToken !== libraryScanToken) return;
        nextCache.files[file.relPath] = { ...file, ...meta };
        sendLibraryProgress({ done: false, relPath: file.relPath, meta });
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(DECODE_CONCURRENCY, toDecode.length) }, worker),
    );

    if (myToken === libraryScanToken) {
      sendLibraryProgress({ done: true });
      await writeCacheFile(libraryCachePath(rootDir), nextCache).catch(() => {
        // Non-fatal — a failed cache write just means the next scan re-decodes.
      });
    }
  })();

  return initial;
}

/**
 * Permissions granted to all windows/sessions: Web MIDI (device I/O) and
 * display-capture + media (system/app-audio recording via `getDisplayMedia`,
 * used by the sample recorder — see `setDisplayMediaRequestHandler` below).
 *
 * Both `"display-capture"` and `"media"` must be allowed: `"display-capture"`
 * gates the `getDisplayMedia()` call itself, but Chromium *separately* checks
 * `"media"` to actually grant use of the resulting audio track — confirmed by
 * logging every permission check live, since denying only `"display-capture"`
 * still failed every capture with a `NotAllowedError` and no useful message.
 * Web Audio itself needs no permission grant.
 */
function isAllowedPermission(permission: string): boolean {
  return (
    permission === "midi" ||
    permission === "midiSysex" ||
    permission === "display-capture" ||
    permission === "media"
  );
}

/**
 * Handles `navigator.mediaDevices.getDisplayMedia()` requests from the
 * renderer (the sample recorder's system/app-audio capture).
 *
 * Does NOT delegate to macOS's native system picker (`useSystemPicker`) —
 * that never actually returns an audio track on macOS in this Electron
 * version (electron/electron#44685, still open). Instead this grants a
 * screen source for `video` (required by the API even though the recorder
 * discards it) and `audio: "loopback"` directly, which — combined with the
 * `MacLoopbackAudioForScreenShare`/`MacSckSystemAudioLoopbackOverride`
 * feature flags enabled at the top of this file — captures real macOS
 * system-audio loopback (whatever's audible through the Mac's output),
 * confirmed working live. The tradeoff versus the (broken) native picker:
 * no per-window source selection UI — it always captures system-wide audio,
 * so whatever the user wants recorded should be the only thing playing.
 */
function handleDisplayMediaRequest(
  _request: Electron.DisplayMediaRequestHandlerHandlerRequest,
  callback: (streams: Electron.Streams) => void,
): void {
  desktopCapturer
    .getSources({ types: ["screen"] })
    .then((sources) => callback({ video: sources[0], audio: "loopback" }))
    .catch(() => callback({}));
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: BASE_W,
    height: BASE_H,
    show: false,
    autoHideMenuBar: true,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindowRef = mainWindow;
  mainWindow.on("closed", () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null;
  });

  // Grant MIDI + display-capture permissions — Web Audio needs no permission.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(isAllowedPermission(permission));
  });
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) =>
    isAllowedPermission(permission),
  );

  // Sample recorder: system/app-audio capture via getDisplayMedia (see
  // `handleDisplayMediaRequest`'s doc comment for why this doesn't use the
  // native system picker).
  mainWindow.webContents.session.setDisplayMediaRequestHandler(handleDisplayMediaRequest);

  // CSP — applied for all navigation responses.
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const scriptSrc = is.dev ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'";

    const csp = [
      `default-src 'self' blob: data:`,
      `script-src ${scriptSrc}`,
      // Tone.js creates a clock worker from a blob URL — allow it.
      `worker-src blob: 'self'`,
      // Tailwind v4 injects styles at runtime
      `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src 'self' data: https://fonts.gstatic.com`,
      `img-src 'self' data: blob:`,
      `media-src 'self' blob: data: mpc-sample:`,
      `connect-src 'self' blob: data: mpc-sample:`,
    ].join("; ");

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });

  // Show as soon as the first paint is ready…
  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });
  // …with fallbacks so the window can never get stuck invisible: show once the
  // document finishes loading, and surface any load failure instead of hanging.
  mainWindow.webContents.on("did-finish-load", () => {
    if (!mainWindow.isVisible()) mainWindow.show();
  });
  mainWindow.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL) => {
    console.error(
      `[main] renderer failed to load (${errorCode} ${errorDescription}) url=${validatedURL}`,
    );
    if (!mainWindow.isVisible()) mainWindow.show();
  });

  // Forward renderer console output to the terminal in dev — the app's own
  // console.warn calls (e.g. SampleEngine load failures) are otherwise only
  // visible in detached DevTools.
  if (is.dev) {
    mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (is.dev && rendererUrl) {
    if (!app.isPackaged) console.log(`[main] dev: loading renderer URL ${rendererUrl}`);
    if (is.dev) mainWindow.webContents.openDevTools({ mode: "detach" });
    mainWindow.loadURL(rendererUrl).catch((err) => console.error("[main] loadURL failed:", err));
  } else {
    const indexFile = join(__dirname, "../renderer/index.html");
    if (!app.isPackaged) console.log(`[main] prod: loading file ${indexFile}`);
    mainWindow.loadFile(indexFile).catch((err) => console.error("[main] loadFile failed:", err));
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(CH.getDefaultExportDir, async (): Promise<IpcResult<DefaultExportDir>> => {
    try {
      const result = await getDefaultExportDir();
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(CH.chooseExportDir, async (): Promise<IpcResult<string | null>> => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
      return ok(canceled || filePaths.length === 0 ? null : filePaths[0]);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(CH.chooseProjectDir, async (): Promise<IpcResult<string | null>> => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "Akai Project", extensions: ["xpj"] }],
      });
      return ok(canceled || filePaths.length === 0 ? null : filePaths[0]);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    CH.readProject,
    async (_event, filePath: string): Promise<IpcResult<LoadedProject>> => {
      try {
        const result = await readProjectFromFile(filePath);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(CH.ejectVolume, async (): Promise<IpcResult<undefined>> => {
    try {
      await execFileAsync("diskutil", ["eject", (await findSdVolume()) ?? VOLUME_ROOT]);
      return ok(undefined);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(CH.openPath, async (_event, dir: string): Promise<IpcResult<undefined>> => {
    try {
      await shell.openPath(dir);
      return ok(undefined);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    CH.writeProject,
    async (_event, args: WriteProjectArgs): Promise<IpcResult<WriteProjectResult>> => {
      try {
        let destDir = args.destDir;

        if (!destDir) {
          // Try the default export dir first
          const defaultDir = await getDefaultExportDir();
          if (defaultDir.exists) {
            destDir = defaultDir.path;
          } else {
            // Fall back to a native directory picker
            const { canceled, filePaths } = await dialog.showOpenDialog({
              properties: ["openDirectory", "createDirectory"],
              defaultPath: DEFAULT_EXPORT_DIR,
            });
            if (canceled || filePaths.length === 0) {
              return fail(
                Object.assign(new Error("Export cancelled by user."), {
                  code: "CANCELLED" as DesktopErrorCode,
                }),
              );
            }
            destDir = filePaths[0];
          }
        }

        const result = await writeProjectToDisk(args, destDir);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(CH.chooseLibraryDir, async (): Promise<IpcResult<string | null>> => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ["openDirectory"],
      });
      return ok(canceled || filePaths.length === 0 ? null : filePaths[0]);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    CH.scanLibrary,
    async (_event, rootDir: string): Promise<IpcResult<LibraryEntry[]>> => {
      try {
        const entries = await runLibraryScan(rootDir);
        return ok(entries);
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(CH.cancelLibraryScan, async (): Promise<IpcResult<undefined>> => {
    libraryScanToken++; // any in-flight decode loop checks this and stops
    return ok(undefined);
  });

  ipcMain.handle(
    CH.getLibraryTags,
    async (_event, rootDir: string): Promise<IpcResult<LibraryTags>> => {
      try {
        const tags = await readTagsFile(libraryTagsPath(rootDir));
        return ok(tags);
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    CH.setSampleTags,
    async (
      _event,
      rootDir: string,
      relPath: string,
      tags: string[],
    ): Promise<IpcResult<undefined>> => {
      try {
        const tagsPath = libraryTagsPath(rootDir);
        const existing = await readTagsFile(tagsPath);
        const next = { ...existing };
        if (tags.length === 0) {
          delete next[relPath];
        } else {
          next[relPath] = tags;
        }
        await writeTagsFile(tagsPath, next);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/**
 * Serve library files by absolute path, restricted to roots the renderer has
 * actually scanned (`allowedLibraryRoots`). Supports HTTP Range requests so
 * `<audio>` preview playback streams instead of buffering the whole file.
 *
 * URL shape: `mpc-sample://local/read?path=<encodeURIComponent(absPath)>`.
 */
function registerSampleProtocol(): void {
  protocol.handle("mpc-sample", async (request) => {
    let absPath: string;
    try {
      const url = new URL(request.url);
      // url.searchParams.get() already URL-decodes the value — do not decode again.
      const raw = url.searchParams.get("path");
      if (!raw) return new Response(null, { status: 400 });
      absPath = path.resolve(raw);
    } catch (err) {
      console.error("[mpc-sample] failed to parse request URL", request.url, err);
      return new Response(null, { status: 400 });
    }

    const isAllowed = [...allowedLibraryRoots].some(
      (root) => absPath === root || absPath.startsWith(root + path.sep),
    );
    if (!isAllowed) {
      console.error("[mpc-sample] path not in an allowed library root:", absPath);
      return new Response(null, { status: 403 });
    }

    let size: number;
    try {
      const rawSize = (await fsStat(absPath)).size;
      // Clamp to the header-declared audio-data boundary, not the raw file
      // size: some exports (notably FL Studio) append a trailing LIST/INFO
      // metadata chunk after the audio data, and serving those extra bytes
      // makes some media decoders reject the whole file as corrupt. Falls
      // back to the raw file size if the header can't be parsed.
      const format = await parseAudioFormat(absPath, rawSize);
      size = format ? Math.min(rawSize, format.dataStart + format.dataLength) : rawSize;
    } catch (err) {
      console.error("[mpc-sample] stat failed for", absPath, err);
      return new Response(null, { status: 404 });
    }

    const ext = path.extname(absPath).toLowerCase();
    const contentType = ext === ".aif" || ext === ".aiff" ? "audio/aiff" : "audio/wav";

    const range = request.headers.get("range");
    const rangeMatch = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;

    const start = rangeMatch ? Number(rangeMatch[1]) : 0;
    const end = rangeMatch?.[2] ? Number(rangeMatch[2]) : size - 1;
    console.log(`[mpc-sample] serving "${path.basename(absPath)}" range=${start}-${end}/${size}`);
    const nodeStream = createReadStream(absPath, { start, end });
    nodeStream.on("error", (err) => {
      console.error("[mpc-sample] read stream error for", absPath, err);
    });
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

    if (rangeMatch) {
      return new Response(webStream, {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*",
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
        },
      });
    }

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Accept-Ranges": "bytes",
        "Content-Length": String(size),
      },
    });
  });
}

const APP_ICON_PATH = join(app.getAppPath(), "public/favicon/android-chrome-512x512.png");

// Prevent Chromium from using the macOS Keychain for its internal Safe Storage
// encryption key. This app stores no sensitive browser session data, so the OS
// keychain is unnecessary and causes a password prompt on every launch.
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("password-store", "basic");
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.worldlinkstudio.mpcsample");

  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(APP_ICON_PATH));
  }

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Ensure all windows share the permission policy set above.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(isAllowedPermission(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    isAllowedPermission(permission),
  );

  registerSampleProtocol();
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

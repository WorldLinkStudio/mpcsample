/**
 * ExportButton.tsx — "EXPORT .XPJ" button with accessible progress dialog.
 *
 * Reads `activeKit` and `userSamples` from the store. On click:
 *   1. Opens an aria-modal progress dialog
 *   2. Browser: runs `exportKitToZip` and triggers a ZIP download
 *   3. Desktop: runs `exportKitToDisk` and writes unzipped files to the SD card
 *   4. Shows error messages (abort, empty kit, missing sample, ENOENT, EEXIST)
 *   5. Provides a Cancel button that aborts via AbortController
 *
 * Desktop overwrite: when the project already exists on disk, an in-dialog
 * yes/no confirmation is shown (no `window.confirm`).
 *
 * Accessibility:
 *   - Dialog: role="dialog", aria-modal, aria-labelledby, aria-busy while running
 *   - Progress: aria-live="polite" region announcing phase + count
 *   - Focus trap: Tab cycles within the dialog; Escape cancels/closes
 *   - Focus restore: returns focus to the trigger button on close
 *   - Button: aria-disabled + tooltip when no kit loaded
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { desktop, isDesktop } from "../desktop/bridge";
import { exportKitToDisk } from "../desktop/exportToDisk";
import { useSequencerStore } from "../sequencer/sequencerStore";
import { buildExportKit, useMPCStore } from "../state/store";
import { hasActiveSteps } from "../xpj/buildSequence";
import { type ExportProgress, exportKitToZip, triggerDownload } from "../xpj/exportKit";
import "../styles/export.css";

const FOCUSABLE_SELECTORS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
}

function phaseLabel(phase: ExportProgress["phase"]): string {
  switch (phase) {
    case "fetching":
      return "Fetching samples…";
    case "building":
      return "Building .xpj…";
    case "zipping":
      return "Zipping archive…";
    case "done":
      return "Done!";
    default:
      return "";
  }
}

function errorCode(err: unknown): string | undefined {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  ) {
    return (err as Record<string, string>).code;
  }
  return undefined;
}

export function ExportButton() {
  const activeKit = useMPCStore((s) => s.activeKit);
  const padMap = useMPCStore((s) => s.padMap);
  const userSamples = useMPCStore((s) => s.userSamples);
  const setExporting = useMPCStore((s) => s.setExporting);
  const setExportProgress = useMPCStore((s) => s.setExportProgress);
  const dialogPosition = useMPCStore((s) => s.dialogPosition);
  const autoOpenExportFolder = useMPCStore((s) => s.autoOpenExportFolder);
  const unmountAfterExport = useMPCStore((s) => s.unmountAfterExport);
  const sequencerPattern = useSequencerStore((s) => s.pattern);
  const patternHasSteps = useMemo(() => hasActiveSteps(sequencerPattern), [sequencerPattern]);

  // Derive the kit to export from the live padMap (source of truth).
  // activeKit.pads is a one-time snapshot set by loadKit; padMap reflects all
  // subsequent drops, swaps, moves, and customisations.
  const exportKit = useMemo(() => buildExportKit(activeKit, padMap), [activeKit, padMap]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [successPath, setSuccessPath] = useState<string | null>(null);
  const [ejectPhase, setEjectPhase] = useState<"idle" | "ejecting" | "ejected" | "error">("idle");
  const [ejectError, setEjectError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("New Project");
  const [includeSequence, setIncludeSequence] = useState(true);

  // In-dialog overwrite confirmation state (desktop only)
  const [overwriteConfirm, setOverwriteConfirm] = useState<{
    projectName: string;
    resolve: (v: boolean) => void;
  } | null>(null);

  // AbortController ref for cancellation
  const abortRef = useRef<AbortController | null>(null);
  // Trigger button ref for focus restore
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Dialog container ref for focus trap
  const dialogRef = useRef<HTMLDivElement>(null);
  // Primary action button ref (receives focus on dialog open)
  const primaryBtnRef = useRef<HTMLButtonElement>(null);

  // exportKit is non-null only when padMap has at least one populated pad.
  const hasKit = exportKit !== null;

  const openDialog = useCallback(() => {
    setDialogOpen(true);
    setRunning(false);
    setProgress(null);
    setErrorMsg(null);
    setSucceeded(false);
    setSuccessPath(null);
    setOverwriteConfirm(null);
    setEjectPhase("idle");
    setEjectError(null);
    setProjectName(exportKit?.exportName?.trim() || "New Project");
    setIncludeSequence(true);
  }, [exportKit]);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    // Restore focus to trigger button
    setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    if (!running) closeDialog();
  }, [running, closeDialog]);

  const handleDialogKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleCancel();
        return;
      }
      if (e.key === "Tab") {
        const el = dialogRef.current;
        if (!el) return;
        const focusable = getFocusable(el);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    },
    [handleCancel],
  );

  useEffect(() => {
    if (dialogOpen) {
      const id = setTimeout(() => primaryBtnRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [dialogOpen]);

  const handleExport = useCallback(async () => {
    if (!exportKit || running) return;
    // Apply the user-entered project name
    const namedKit = { ...exportKit, exportName: projectName.trim() || "New Project" };

    const pattern = includeSequence && patternHasSteps ? sequencerPattern : undefined;

    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    setErrorMsg(null);
    setSucceeded(false);
    setSuccessPath(null);
    setOverwriteConfirm(null);
    setExporting(true);

    const onProgress = (p: ExportProgress) => {
      setProgress(p);
      setExportProgress({ loaded: p.loaded, total: p.total });
    };

    try {
      if (isDesktop()) {
        const onNeedOverwrite = (projectName: string): Promise<boolean> =>
          new Promise<boolean>((resolve) => {
            setOverwriteConfirm({ projectName, resolve });
          });

        const result = await exportKitToDisk(namedKit, userSamples, {
          signal: controller.signal,
          onProgress,
          onNeedOverwrite,
          pattern,
        });

        if (!controller.signal.aborted) {
          setSuccessPath(result.written);
          setSucceeded(true);
          setProgress(null);
          setOverwriteConfirm(null);
          if (autoOpenExportFolder) {
            const exportDir = result.written.replace(/[/\\][^/\\]+$/, "");
            void desktop()
              .openPath(exportDir)
              .catch(() => undefined);
          }
          if (unmountAfterExport) {
            setEjectPhase("ejecting");
            void desktop()
              .ejectVolume()
              .then(() => {
                setEjectPhase("ejected");
              })
              .catch((err: unknown) => {
                setEjectPhase("error");
                setEjectError(err instanceof Error ? err.message : "Failed to eject volume.");
              });
          }
        }
      } else {
        const result = await exportKitToZip(namedKit, userSamples, {
          signal: controller.signal,
          onProgress,
          pattern,
        });

        if (!controller.signal.aborted) {
          triggerDownload(result);
          setSucceeded(true);
          setProgress(null);
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setErrorMsg("Export cancelled.");
      } else {
        const code = errorCode(err);
        if (code === "ENOENT") {
          setErrorMsg("MPC SD card not found — ensure it is mounted or choose a different folder.");
        } else if (code === "EEXIST") {
          setErrorMsg("A project with this name already exists.");
        } else if (code === "EACCES") {
          setErrorMsg("Permission denied — cannot write to the selected folder.");
        } else {
          setErrorMsg(err instanceof Error ? err.message : "An unexpected error occurred.");
        }
      }
      setOverwriteConfirm(null);
    } finally {
      setRunning(false);
      setExporting(false);
      setExportProgress(null);
      abortRef.current = null;
    }
  }, [
    exportKit,
    userSamples,
    running,
    setExporting,
    setExportProgress,
    autoOpenExportFolder,
    unmountAfterExport,
    projectName,
    includeSequence,
    patternHasSteps,
    sequencerPattern,
  ]);

  const handleEject = useCallback(async () => {
    setEjectPhase("ejecting");
    setEjectError(null);
    try {
      await desktop().ejectVolume();
      setEjectPhase("ejected");
    } catch (err) {
      setEjectPhase("error");
      setEjectError(err instanceof Error ? err.message : "Failed to eject volume.");
    }
  }, []);

  const progressPercent =
    progress && progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;

  const ariaLiveText = progress
    ? `${phaseLabel(progress.phase)} ${progress.loaded} of ${progress.total}`
    : succeeded
      ? isDesktop() && successPath
        ? `Export complete. Written to ${successPath}`
        : "Export complete. Download started."
      : errorMsg
        ? `Export failed: ${errorMsg}`
        : "";

  return (
    <>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        className="export-btn"
        onClick={hasKit ? openDialog : undefined}
        disabled={!hasKit}
        aria-disabled={!hasKit}
        title={!hasKit ? "Load a kit first" : "Export kit as Akai .xpj project"}
        aria-label="Export kit as Akai .xpj ZIP"
      >
        ⬇ EXPORT .XPJ
      </button>

      {/* Progress dialog — portalled to document.body to escape mpc-stage transform context */}
      {dialogOpen &&
        createPortal(
          <div
            className={[
              "export-overlay",
              dialogPosition === "top-right" ? "export-overlay--top-right" : "",
              dialogPosition === "bottom-right" ? "export-overlay--bottom-right" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="export-dialog-heading"
              aria-busy={running}
              className="export-dialog"
              onKeyDown={handleDialogKeyDown}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="export-dialog-heading">EXPORT .XPJ</h3>

              {/* Project name input — shown before export starts */}
              {!running && !succeeded && (
                <div className="export-name-field">
                  <label htmlFor="export-project-name" className="export-name-label">
                    Project name
                  </label>
                  <input
                    id="export-project-name"
                    type="text"
                    className="export-name-input"
                    value={projectName}
                    placeholder="New Project"
                    onChange={(e) => setProjectName(e.target.value)}
                    aria-label="Project name"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              )}

              {/* Include step-sequencer pattern — only offered when one exists */}
              {!running && !succeeded && patternHasSteps && (
                <label className="export-sequence-field">
                  <input
                    type="checkbox"
                    checked={includeSequence}
                    onChange={(e) => setIncludeSequence(e.target.checked)}
                  />
                  Include step sequencer pattern
                </label>
              )}

              {/* aria-live region for screen reader announcements */}
              <div aria-live="polite" aria-atomic="true" className="export-phase-label">
                {ariaLiveText}
              </div>

              {/* Progress bar (shown while fetching) */}
              {running && progress?.phase === "fetching" && (
                <>
                  <div className="export-progress-bar-track">
                    <div
                      className="export-progress-bar-fill"
                      style={{ width: `${progressPercent}%` }}
                      role="progressbar"
                      aria-valuenow={progressPercent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label="Export progress"
                    />
                  </div>
                  <p className="export-count-label">
                    {progress.loaded} / {progress.total} samples
                  </p>
                </>
              )}

              {/* Phase label for non-fetching phases */}
              {running && progress && progress.phase !== "fetching" && (
                <p className="export-phase-label">{phaseLabel(progress.phase)}</p>
              )}

              {/* In-dialog overwrite confirmation (desktop only) */}
              {overwriteConfirm && (
                <div className="export-overwrite-confirm" role="alert">
                  <p>
                    Project <strong>{overwriteConfirm.projectName}</strong> already exists.
                    Overwrite?
                  </p>
                  <div className="export-dialog-actions">
                    <button
                      type="button"
                      className="export-dialog-btn primary"
                      onClick={() => {
                        overwriteConfirm.resolve(true);
                        setOverwriteConfirm(null);
                      }}
                      aria-label="Overwrite existing project"
                    >
                      Overwrite
                    </button>
                    <button
                      type="button"
                      className="export-dialog-btn"
                      onClick={() => {
                        overwriteConfirm.resolve(false);
                        setOverwriteConfirm(null);
                      }}
                      aria-label="Keep existing project and cancel export"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Error message */}
              {errorMsg && (
                <p className="export-error-msg" role="alert">
                  {errorMsg}
                </p>
              )}

              {/* Success message */}
              {succeeded && (
                <p className="export-success-msg">
                  {isDesktop() && successPath
                    ? `Exported to ${successPath}`
                    : "Download started — check your Downloads folder."}
                </p>
              )}

              {/* Eject volume (desktop only, shown after successful export) */}
              {succeeded && isDesktop() && (
                <div className="export-eject">
                  {ejectPhase !== "ejected" && (
                    <button
                      type="button"
                      className="export-dialog-btn"
                      disabled={ejectPhase === "ejecting"}
                      onClick={handleEject}
                      aria-label={
                        ejectPhase === "ejecting"
                          ? "Ejecting MPC SD card"
                          : "Eject MPC SD card safely"
                      }
                    >
                      {ejectPhase === "ejecting" ? "Ejecting…" : "⏏ Eject Volume"}
                    </button>
                  )}
                  {ejectPhase === "ejected" && (
                    <p className="export-eject-done">Volume ejected safely.</p>
                  )}
                  {ejectPhase === "error" && ejectError && (
                    <p className="export-error-msg" role="alert">
                      {ejectError}
                    </p>
                  )}
                </div>
              )}

              {/* Action buttons */}
              <div className="export-dialog-actions">
                {/* Export / primary action — only shown before running or after error */}
                {!running && !succeeded && !overwriteConfirm && (
                  <button
                    ref={primaryBtnRef}
                    type="button"
                    className="export-dialog-btn primary"
                    onClick={handleExport}
                    aria-label="Start export"
                  >
                    Export
                  </button>
                )}

                {/* Cancel while running (but not waiting for overwrite confirm) */}
                {running && !overwriteConfirm && (
                  <button
                    ref={primaryBtnRef}
                    type="button"
                    className="export-dialog-btn"
                    onClick={handleCancel}
                    aria-label="Cancel export"
                  >
                    Cancel
                  </button>
                )}

                {/* Close button — always present when not running */}
                {!running && !overwriteConfirm && (
                  <button
                    type="button"
                    className="export-dialog-btn"
                    onClick={closeDialog}
                    aria-label={succeeded ? "Close export dialog" : "Cancel and close"}
                    ref={succeeded ? primaryBtnRef : undefined}
                  >
                    {succeeded ? "Close" : "Cancel"}
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

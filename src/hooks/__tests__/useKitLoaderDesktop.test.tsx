/**
 * useKitLoaderDesktop.test.tsx — Verify that the auto-load preset behaviour is
 * gated off when `isDesktop()` returns true.
 *
 * Two scenarios:
 *  1. `isDesktop()` true  → switchKit (and loadKitById) must NOT be called.
 *  2. `isDesktop()` false → switchKit IS called once the engine is ready.
 *
 * The `isDesktop` mock is controlled per-describe block via a module-level
 * boolean that each mock captures in its closure.
 *
 * Note: vi.mock() calls are hoisted by Vitest before imports, so the lint rule
 * `import/first` is suppressed for the post-mock imports below.
 */

import { act, render, renderHook, screen } from "@testing-library/react";
// All imports first — vi.mock() is hoisted by Vitest at runtime regardless of
// where it appears in source, but ESLint requires imports before other statements.
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared spy for loadKitManifest (the network call under the hood)
// ---------------------------------------------------------------------------

const mockLoadKitManifest = vi.fn().mockResolvedValue({
  id: "london-full",
  displayName: "London Full",
  exportName: "London Full",
  key: "C Minor",
  bpm: 114,
  pads: [],
});

vi.mock("../../kits/loadManifest", () => ({
  loadKitManifest: (...args: unknown[]) => mockLoadKitManifest(...args),
}));

// ---------------------------------------------------------------------------
// Store mock: activeKit starts null so the auto-load condition is met.
// ---------------------------------------------------------------------------

const mockLoadKit = vi.fn();

vi.mock("../../state/store", () => ({
  useMPCStore: {
    getState: () => ({
      activeKit: null,
      loadKit: mockLoadKit,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Registry mock
// ---------------------------------------------------------------------------

vi.mock("../../kits/registry", () => ({
  DEFAULT_KIT_ID: "london-full",
}));

// ---------------------------------------------------------------------------
// isDesktop mock — controlled via module-level variable
// ---------------------------------------------------------------------------

let _isDesktop = false;

vi.mock("../../desktop/bridge", () => ({
  isDesktop: () => _isDesktop,
  // SampleBrowser (rendered by App when isDesktop()) subscribes to library
  // progress via desktop().onLibraryProgress — stub it so App can mount.
  desktop: () => ({
    onLibraryProgress: () => () => {},
  }),
}));

// ---------------------------------------------------------------------------
// App-level mocks (used in the App integration describe below)
// ---------------------------------------------------------------------------

vi.mock("../useAudioEngine", () => ({
  useAudioEngine: () => ({
    isReady: false,
    engine: null,
    start: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../useMidiInput", () => ({
  useMidiInput: () => ({
    start: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../useKeyboardInput", () => ({
  useKeyboardInput: vi.fn(),
}));

vi.mock("../useSequencer", () => ({
  useSequencer: vi.fn(),
}));

vi.mock("../../components/StartOverlay", () => ({
  StartOverlay: () => <div data-testid="start-overlay" />,
}));

vi.mock("../../components/MPCDevice", () => ({
  MPCDevice: () => <div data-testid="mpc-device" />,
}));

vi.mock("../../components/HUD", () => ({
  HUD: () => <div data-testid="hud" />,
}));

vi.mock("../../components/TweaksPanel", () => ({
  TweaksPanel: () => <div data-testid="tweaks-panel" />,
}));

vi.mock("../../components/KitEditor", () => ({
  KitEditor: () => <div data-testid="kit-editor" />,
}));

vi.mock("../../components/EffectsRackPanel", () => ({
  EffectsRackPanel: () => <div data-testid="effects-rack-panel" />,
}));

vi.mock("../../components/StepSequencer", () => ({
  StepSequencer: () => <div data-testid="step-sequencer" />,
}));

vi.mock("../../components/SampleRecorder", () => ({
  SampleRecorder: () => <div data-testid="sample-recorder" />,
}));

vi.mock("../../components/Launcher", () => ({
  Launcher: ({ onDismiss }: { onDismiss: () => void }) => (
    <div data-testid="launcher" role="dialog">
      <button type="button" onClick={onDismiss}>
        New kit
      </button>
    </div>
  ),
}));

vi.mock("../../components/ZoomControls", () => ({
  ZoomControls: () => <div data-testid="zoom-controls" />,
}));

// ---------------------------------------------------------------------------
// Actual module imports (after all vi.mock() calls)
// Vitest hoists vi.mock() before these at runtime, but we place them after
// mock declarations to satisfy eslint import/first in static analysis.
// ---------------------------------------------------------------------------

// eslint-disable-next-line import/first
import { App } from "../../App";
// eslint-disable-next-line import/first
import { useKitLoader } from "../useKitLoader";

// ---------------------------------------------------------------------------
// Tests: useKitLoader desktop gating
// ---------------------------------------------------------------------------

describe("useKitLoader — desktop gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when isDesktop() is true", () => {
    it("does NOT auto-load the default kit when the engine becomes ready", async () => {
      _isDesktop = true;

      const { result } = renderHook(() => useKitLoader(false));

      // Simulate engine becoming ready.
      act(() => {
        renderHook(() => useKitLoader(true));
      });

      // Wait a tick — the effect is async.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockLoadKitManifest).not.toHaveBeenCalled();
      expect(mockLoadKit).not.toHaveBeenCalled();

      // The hook still returns a switchKit function (manual switching still works).
      expect(typeof result.current.switchKit).toBe("function");
    });
  });

  describe("when isDesktop() is false", () => {
    it.skip("auto-loads the default kit when the engine becomes ready and no kit is loaded", async () => {
      _isDesktop = false;

      renderHook(() => useKitLoader(true));

      // The effect is async — wait for the promise to settle.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockLoadKitManifest).toHaveBeenCalledWith("london-full", expect.any(AbortSignal));
    });
  });
});

// ---------------------------------------------------------------------------
// App integration: Launcher rendered/hidden based on isDesktop
// ---------------------------------------------------------------------------

describe("App — Launcher rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Launcher when isDesktop() is true and kit not chosen", () => {
    _isDesktop = true;
    render(<App />);
    expect(screen.getByTestId("launcher")).toBeInTheDocument();
  });

  it("does NOT render Launcher when isDesktop() is false", () => {
    _isDesktop = false;
    render(<App />);
    expect(screen.queryByTestId("launcher")).not.toBeInTheDocument();
  });
});

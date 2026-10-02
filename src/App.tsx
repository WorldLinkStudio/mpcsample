import { useEffect, useState } from "react";
import { EffectsRackPanel } from "./components/EffectsRackPanel";
import { HUD } from "./components/HUD";
import { KitEditor } from "./components/KitEditor";
import { Launcher } from "./components/Launcher";
import { MPCDevice } from "./components/MPCDevice";
import { SampleBrowser } from "./components/SampleBrowser";
import { SampleRecorder } from "./components/SampleRecorder";
import { StartOverlay } from "./components/StartOverlay";
import { StepSequencer } from "./components/StepSequencer";
import { TweaksPanel } from "./components/TweaksPanel";
import { isDesktop } from "./desktop/bridge";
import { useAudioEngine } from "./hooks/useAudioEngine";
import { useKeyboardInput } from "./hooks/useKeyboardInput";
import { useKitLoader } from "./hooks/useKitLoader";
import { useMidiInput } from "./hooks/useMidiInput";
import { useSequencer } from "./hooks/useSequencer";
import { useMPCStore } from "./state/store";

export function App() {
  const audio = useAudioEngine();
  const midi = useMidiInput();
  useKeyboardInput(true);
  useKitLoader(audio.isReady);
  useSequencer();

  useEffect(() => {
    const handleStop = () => useMPCStore.getState().stopAll();
    window.addEventListener("mpc:transport-stop", handleStop);
    return () => window.removeEventListener("mpc:transport-stop", handleStop);
  }, []);

  // Launcher state: shown in Electron until the user picks a kit.
  // The Launcher is never rendered in the browser build.
  const [kitChosen, setKitChosen] = useState(false);
  const showLauncher = isDesktop() && !kitChosen;

  const handleStart = async () => {
    await audio.start();
    await midi.start();
  };

  return (
    <>
      {showLauncher && <Launcher onDismiss={() => setKitChosen(true)} />}
      <StartOverlay onStart={handleStart} />
      <MPCDevice engine={audio.engine} />
      <HUD />
      <TweaksPanel />
      <KitEditor />
      <EffectsRackPanel />
      <StepSequencer />
      <SampleRecorder />
      {isDesktop() && <SampleBrowser />}
    </>
  );
}

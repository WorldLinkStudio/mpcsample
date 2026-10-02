/**
 * effectsChain.ts — Build a Tone.js node chain from `EffectInstance[]` and
 * render a sample through it offline, in one pass.
 *
 * This is the actual fix for the "add effect, bounce, add next effect,
 * bounce again" workflow the hardware forces: the whole chain (filter →
 * bitcrusher → reverb → ...) runs once, off the realtime thread, and comes
 * back as a single finished buffer.
 *
 * `createChainNode` has no knowledge of offline vs. realtime — it just
 * builds *a* Tone node for one `EffectInstance` using whatever Tone context
 * is current when it's called. That's what lets `renderEffectsChain`
 * (inside `Tone.Offline`) and `previewEffectsChain` (on the realtime
 * context, after `Tone.start()`) share one implementation.
 */

import * as Tone from "tone";
import type { EffectInstance } from "./effects.types";

/** Any Tone node with the subset of the API every effect here needs. */
type ChainNode = Tone.ToneAudioNode & { dispose: () => void };

/**
 * Instantiate the Tone.js node for one `EffectInstance`, bound to whichever
 * Tone context is current (realtime or offline) at call time.
 *
 * `Tone.Reverb` generates its impulse response asynchronously — callers
 * MUST await this before connecting/starting playback through the chain.
 */
async function createChainNode(effect: EffectInstance): Promise<ChainNode> {
  switch (effect.type) {
    case "filter":
      return new Tone.Filter({
        type: effect.params.filterType,
        frequency: effect.params.frequency,
        Q: effect.params.Q,
      });

    case "distortion":
      return new Tone.Distortion({ distortion: effect.params.amount, oversample: "4x" });

    case "bitcrusher":
      return new Tone.BitCrusher({ bits: Math.round(effect.params.bits) });

    case "chorus": {
      const chorus = new Tone.Chorus({
        frequency: effect.params.frequency,
        delayTime: effect.params.delayTime,
        depth: effect.params.depth,
      });
      // Chorus's LFO doesn't run until started — easy to forget and get silence.
      chorus.start();
      return chorus;
    }

    case "delay":
      return new Tone.FeedbackDelay({
        delayTime: effect.params.delayTime,
        feedback: effect.params.feedback,
        wet: effect.params.wet,
      });

    case "reverb": {
      const reverb = new Tone.Reverb({
        decay: effect.params.decay,
        preDelay: effect.params.preDelay,
        wet: effect.params.wet,
      });
      await reverb.generate();
      return reverb;
    }

    default: {
      const exhaustive: never = effect;
      throw new Error(`createChainNode: unhandled effect ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Extra tail time (seconds) one effect instance needs to ring out/decay fully. */
function tailSecondsFor(effect: EffectInstance): number {
  switch (effect.type) {
    case "reverb":
      return effect.params.decay + effect.params.preDelay;
    case "delay": {
      // Geometric decay: find n where feedback^n drops below -60dB (~0.001).
      const fb = Math.min(effect.params.feedback, 0.95);
      const n = fb > 0 ? Math.ceil(Math.log(0.001) / Math.log(fb)) : 1;
      return effect.params.delayTime * n;
    }
    default:
      return 0;
  }
}

const MAX_TAIL_SECONDS = 15;

/** Total extra render time the chain needs beyond the dry sample's length. */
export function estimateTailSeconds(chain: readonly EffectInstance[]): number {
  const total = chain.reduce((sum, fx) => sum + tailSecondsFor(fx), 0);
  return Math.min(total, MAX_TAIL_SECONDS);
}

/**
 * Connect `source` through `chain` (in order) to `destination`, returning the
 * created nodes so the caller can dispose them afterward.
 */
async function wireChain(
  source: Tone.ToneAudioNode,
  chain: readonly EffectInstance[],
  destination: Tone.ToneAudioNode,
): Promise<ChainNode[]> {
  const nodes: ChainNode[] = [];
  let last: Tone.ToneAudioNode = source;
  for (const effect of chain) {
    const node = await createChainNode(effect);
    last.connect(node);
    nodes.push(node);
    last = node;
  }
  last.connect(destination);
  return nodes;
}

/**
 * Render `inputBuffer` through `chain` offline and return the result as a
 * plain `AudioBuffer`, ready to re-encode to WAV.
 *
 * Runs in its own `Tone.Offline` context — does not touch the app's
 * realtime audio graph or playback state.
 *
 * @throws If the chain is empty (nothing to render — callers should check
 *   `chain.length > 0` before calling, so this is a programmer error).
 */
export async function renderEffectsChain(
  inputBuffer: AudioBuffer,
  chain: readonly EffectInstance[],
): Promise<AudioBuffer> {
  if (chain.length === 0) {
    throw new Error("renderEffectsChain: chain is empty — nothing to render.");
  }

  const duration = inputBuffer.duration + estimateTailSeconds(chain);
  const channels = inputBuffer.numberOfChannels;
  const sampleRate = inputBuffer.sampleRate;

  const rendered = await Tone.Offline(
    async () => {
      const toneBuffer = new Tone.ToneAudioBuffer(inputBuffer);
      const player = new Tone.Player(toneBuffer);
      await wireChain(player, chain, Tone.getDestination());
      player.start(0);
    },
    duration,
    channels,
    sampleRate,
  );

  return rendered.get() as AudioBuffer;
}

/**
 * Play `inputBuffer` through `chain` once, live, on the app's realtime audio
 * context — lets the user audition the chain before committing to a render.
 *
 * Callers must have already called `Tone.start()` (e.g. via the engine's
 * `start()`), and must not call this again until the previous preview's
 * returned `stop()` has been invoked or the sample has finished playing.
 */
export async function previewEffectsChain(
  inputBuffer: AudioBuffer,
  chain: readonly EffectInstance[],
): Promise<{ stop: () => void }> {
  const toneBuffer = new Tone.ToneAudioBuffer(inputBuffer);
  const player = new Tone.Player(toneBuffer);
  const nodes = chain.length > 0 ? await wireChain(player, chain, Tone.getDestination()) : [];
  if (chain.length === 0) player.toDestination();

  const disposeAll = () => {
    try {
      player.stop();
    } catch {
      // already stopped
    }
    player.dispose();
    for (const node of nodes) node.dispose();
  };

  player.onstop = disposeAll;
  player.start(0);

  return { stop: disposeAll };
}

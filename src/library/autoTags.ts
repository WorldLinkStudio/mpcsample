/**
 * autoTags.ts — Keyword taxonomy for auto-tagging library samples from their
 * path (pack/subfolder names) and filename.
 *
 * Built from the actual folder conventions seen across the user's sample
 * packs (e.g. "12) Snares", "1) DrumKit/2) 808 & Bass", "One Shots/Drums/Kicks",
 * "kiks"/"kikdakik.wav") — ordinal prefixes are stripped, matching is
 * substring-based (case-insensitive) against the whole relPath + filename so
 * both well-organized packs and quirky vendor naming (e.g. "kik") get caught.
 *
 * Auto-tags are never persisted — they're cheap to recompute from the path on
 * every render, unlike manual tags (see `libraryStore.ts`) which are user
 * edits and must survive a rescan.
 */

import type { LibraryEntry } from "../desktop/bridge.types";

type TagRule = {
  tag: string;
  aliases: string[];
};

// Order matters only for readability — all matching tags are returned, not just the first.
const TAXONOMY: TagRule[] = [
  { tag: "Kick", aliases: ["kick", "kik"] },
  { tag: "Snare", aliases: ["snare"] },
  { tag: "Clap", aliases: ["clap"] },
  { tag: "Hats", aliases: ["hat", "hi-hat", "hihat"] },
  { tag: "Open Hat", aliases: ["open hat", "openhat"] },
  { tag: "Closed Hat", aliases: ["closed hat", "closedhat"] },
  { tag: "Cymbal", aliases: ["cymbal"] },
  { tag: "Crash", aliases: ["crash"] },
  { tag: "Ride", aliases: ["ride"] },
  { tag: "Rim", aliases: ["rim"] },
  { tag: "Tom", aliases: ["tom"] },
  { tag: "Cowbell", aliases: ["cowbell"] },
  { tag: "Percussion", aliases: ["perc"] },
  { tag: "808", aliases: ["808"] },
  { tag: "Bass", aliases: ["bass", "reese", "sub"] },
  { tag: "FX", aliases: ["fx", "sfx", "effect"] },
  { tag: "Breaks", aliases: ["break"] },
  { tag: "Loop", aliases: ["loop"] },
  { tag: "One Shot", aliases: ["one shot", "one_shot", "oneshot"] },
  { tag: "Vocal", aliases: ["vocal", "vox", "chant", "acapella", "acappella"] },
  { tag: "Melodic", aliases: ["melodic", "chop", "songstarter", "stack"] },
  { tag: "Chords", aliases: ["chord"] },
  { tag: "Arps", aliases: ["arp"] },
  { tag: "Stab", aliases: ["stab"] },
  { tag: "Strings", aliases: ["string"] },
  { tag: "Guitar", aliases: ["guitar"] },
  { tag: "Synth", aliases: ["synth"] },
  { tag: "Keys", aliases: ["keys", "piano", "rhodes"] },
  { tag: "Woodwind", aliases: ["woodwind", "saxophone", "sax"] },
  { tag: "Stems", aliases: ["stem"] },
  { tag: "Composition", aliases: ["composition"] },
  { tag: "Drums", aliases: ["drum"] },
];

/** Strip a leading ordinal/list marker like "12) " or "1. " from a path segment. */
function stripOrdinalPrefix(segment: string): string {
  return segment.replace(/^\s*\d+[).-]\s*/, "");
}

/**
 * Normalize a relPath + filename into one lowercase haystack for substring
 * matching. The pack segment (first path component) is deliberately excluded
 * — pack names are often branded like "... Drum Kit" or "... Sample Pack",
 * which would otherwise tag nearly every file in the pack with e.g. "Drums".
 * The pack itself is already exposed as its own facet (see `derivePackName`).
 */
function buildHaystack(relPath: string): string {
  const segments = relPath.split("/");
  const withoutPack = segments.length > 1 ? segments.slice(1) : segments;
  return withoutPack.map(stripOrdinalPrefix).join(" ").toLowerCase();
}

/** Derive auto-suggested tags from a library entry's path + filename. Deterministic, not persisted. */
export function deriveAutoTags(entry: Pick<LibraryEntry, "relPath">): string[] {
  const haystack = buildHaystack(entry.relPath);
  const matched: string[] = [];
  for (const rule of TAXONOMY) {
    if (rule.aliases.some((alias) => haystack.includes(alias))) {
      matched.push(rule.tag);
    }
  }
  return matched;
}

/** The pack a sample belongs to: the top-level folder under the scanned root, or "" if the file sits at the root. */
export function derivePackName(entry: Pick<LibraryEntry, "relPath">): string {
  const idx = entry.relPath.indexOf("/");
  return idx === -1 ? "" : entry.relPath.slice(0, idx);
}

/**
 * Combine auto-derived tags with a sample's manually-added tags (deduped).
 * Manual tags are additive only — there's no way to suppress an auto-suggested
 * tag here, only to add more.
 */
export function effectiveTags(
  entry: Pick<LibraryEntry, "relPath">,
  manualTags: string[] | undefined,
): string[] {
  const auto = deriveAutoTags(entry);
  if (!manualTags || manualTags.length === 0) return auto;
  return Array.from(new Set([...auto, ...manualTags]));
}

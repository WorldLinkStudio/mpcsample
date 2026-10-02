import { describe, expect, it } from "vitest";
import { deriveAutoTags, derivePackName } from "../autoTags";

describe("derivePackName", () => {
  it("returns the top-level folder as the pack name", () => {
    expect(derivePackName({ relPath: "Beat Butcha - Lamb Chops Drum Kit/kiks/kikk.wav" })).toBe(
      "Beat Butcha - Lamb Chops Drum Kit",
    );
  });

  it("returns an empty string for a file sitting directly at the library root", () => {
    expect(derivePackName({ relPath: "loose-sample.wav" })).toBe("");
  });
});

describe("deriveAutoTags", () => {
  it("tags an ordinal-prefixed subfolder (Lxw HvRm Phonk Pandemonium convention)", () => {
    const tags = deriveAutoTags({
      relPath: "Lxw HvRm Phonk Pandemonium/1) DrumKit/12) Snares/Snare 327.wav",
    });
    expect(tags).toContain("Snare");
  });

  it("tags a combined folder name (808 & Bass)", () => {
    const tags = deriveAutoTags({
      relPath: "Lxw HvRm Phonk Pandemonium/1) DrumKit/2) 808 & Bass/808_sub.wav",
    });
    expect(tags).toContain("808");
    expect(tags).toContain("Bass");
  });

  it("tags Open Hat and Hats together from an 'Open Hats' folder", () => {
    const tags = deriveAutoTags({
      relPath: "Lxw HvRm Phonk Pandemonium/1) DrumKit/10) Open Hats/OH_01.wav",
    });
    expect(tags).toContain("Hats");
    expect(tags).toContain("Open Hat");
  });

  it("catches quirky vendor filenames without a matching folder word (kikdakik.wav)", () => {
    const tags = deriveAutoTags({
      relPath: "Beat Butcha - Lamb Chops Drum Kit/kiks/kikdakik.wav",
    });
    expect(tags).toContain("Kick");
  });

  it("tags nested category folders (One Shots/Drums/Kicks)", () => {
    const tags = deriveAutoTags({
      relPath:
        "Renraku - Rare Tape Jams 3 (Hiphop & RnB & Phonk Sample Pack)/One Shots/Drums/Kicks/Kick 01.wav",
    });
    expect(tags).toContain("Kick");
    expect(tags).toContain("Drums");
    expect(tags).toContain("One Shot");
  });

  it("does NOT tag every file in a pack just because the pack name contains 'Drum Kit'", () => {
    const tags = deriveAutoTags({
      relPath: "Beat Butcha - Lamb Chops Drum Kit/fx/horn.wav",
    });
    expect(tags).not.toContain("Drums");
    expect(tags).toContain("FX");
  });

  it("tags melodic/stems folders", () => {
    expect(
      deriveAutoTags({
        relPath:
          "Crabtree Music Library Vol. 2 (Compositions and Stems)/Stems/MTK - Bobby BMin 75bpm.wav",
      }),
    ).toContain("Stems");
    expect(
      deriveAutoTags({
        relPath:
          "MSXII Sound Design 25-in-1/MSXII Sound Design MSXII Lofi Melodics Selections/lofi_chops.wav",
      }),
    ).toContain("Melodic");
  });

  it("returns an empty array when nothing matches", () => {
    expect(deriveAutoTags({ relPath: "Some Pack/randomfile123.wav" })).toEqual([]);
  });
});

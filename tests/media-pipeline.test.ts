import { describe, it, expect } from "vitest";
import {
  classifyMedia,
  detectMedia,
  type MediaAttachment,
  type MediaType,
} from "../src/media-pipeline.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAttachment(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    id: "att-1",
    filename: "file.txt",
    url: "https://cdn.discord.com/file.txt",
    size: 1024,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyMedia - content_type detection
// ---------------------------------------------------------------------------

describe("classifyMedia - content_type", () => {
  const audioTypes = [
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/ogg",
    "audio/webm",
    "audio/flac",
    "audio/aac",
    "audio/m4a",
  ];

  const videoTypes = [
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-msvideo",
  ];

  const imageTypes = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ];

  for (const ct of audioTypes) {
    it(`detects ${ct} as audio`, () => {
      expect(classifyMedia(makeAttachment({ content_type: ct }))).toBe("audio");
    });
  }

  for (const ct of videoTypes) {
    it(`detects ${ct} as video`, () => {
      expect(classifyMedia(makeAttachment({ content_type: ct }))).toBe("video");
    });
  }

  for (const ct of imageTypes) {
    it(`detects ${ct} as image`, () => {
      expect(classifyMedia(makeAttachment({ content_type: ct }))).toBe("image");
    });
  }

  it("returns unknown for unsupported content_type", () => {
    expect(classifyMedia(makeAttachment({ content_type: "application/pdf" }))).toBe("unknown");
  });

  it("returns unknown when content_type is missing", () => {
    expect(classifyMedia(makeAttachment({ content_type: undefined }))).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// classifyMedia - file extension fallback
// ---------------------------------------------------------------------------

describe("classifyMedia - file extension fallback", () => {
  const audioExts: Array<[string, string]> = [
    ["recording.mp3", "audio"],
    ["sound.wav", "audio"],
    ["track.ogg", "audio"],
    ["song.flac", "audio"],
    ["voice.aac", "audio"],
    ["memo.m4a", "audio"],
    ["clip.wma", "audio"],
  ];

  const videoExts: Array<[string, string]> = [
    ["movie.mp4", "video"],
    ["stream.webm", "video"],
    ["clip.mov", "video"],
    ["video.avi", "video"],
    ["film.mkv", "video"],
  ];

  const imageExts: Array<[string, string]> = [
    ["photo.png", "image"],
    ["photo.jpg", "image"],
    ["photo.jpeg", "image"],
    ["animation.gif", "image"],
    ["picture.webp", "image"],
    ["icon.bmp", "image"],
  ];

  for (const [filename, expected] of [...audioExts, ...videoExts, ...imageExts]) {
    it(`detects ${filename} as ${expected} via extension`, () => {
      expect(classifyMedia(makeAttachment({ filename, content_type: undefined }))).toBe(expected);
    });
  }

  it("returns unknown for unrecognized extension", () => {
    expect(classifyMedia(makeAttachment({ filename: "data.csv", content_type: undefined }))).toBe("unknown");
  });

  it("handles uppercase extensions via lowercase normalization", () => {
    expect(classifyMedia(makeAttachment({ filename: "FILE.MP3", content_type: undefined }))).toBe("audio");
  });
});

// ---------------------------------------------------------------------------
// classifyMedia - content_type takes precedence over extension
// ---------------------------------------------------------------------------

describe("classifyMedia - precedence", () => {
  it("prefers content_type over file extension", () => {
    const att = makeAttachment({
      filename: "music.mp4",
      content_type: "audio/mpeg",
    });
    expect(classifyMedia(att)).toBe("audio");
  });
});

// ---------------------------------------------------------------------------
// detectMedia
// ---------------------------------------------------------------------------

describe("detectMedia", () => {
  it("returns detected media items, filtering out unknowns", () => {
    const attachments = [
      makeAttachment({ id: "a1", filename: "song.mp3" }),
      makeAttachment({ id: "a2", filename: "data.csv" }),
      makeAttachment({ id: "a3", filename: "photo.png" }),
    ];
    const detected = detectMedia(attachments);
    expect(detected).toHaveLength(2);
    expect(detected.map((d) => d.mediaType)).toEqual(["audio", "image"]);
  });

  it("returns empty array when no media attachments", () => {
    const attachments = [
      makeAttachment({ filename: "readme.txt" }),
      makeAttachment({ filename: "data.json" }),
    ];
    expect(detectMedia(attachments)).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    expect(detectMedia([])).toHaveLength(0);
  });

  it("detects all media types in a mixed batch", () => {
    const attachments = [
      makeAttachment({ id: "a1", content_type: "audio/wav" }),
      makeAttachment({ id: "a2", content_type: "video/mp4" }),
      makeAttachment({ id: "a3", content_type: "image/jpeg" }),
    ];
    const detected = detectMedia(attachments);
    expect(detected).toHaveLength(3);
    expect(detected.map((d) => d.mediaType).sort()).toEqual(["audio", "image", "video"]);
  });
});

// ---------------------------------------------------------------------------
// Intake detection (intake channel vs agent thread)
// ---------------------------------------------------------------------------

describe("intake detection logic", () => {
  it("identifies intake channel messages as needing processing", () => {
    const mediaChannelIds = ["ch-intake-1", "ch-intake-2"];
    const messageChannelId = "ch-intake-1";
    const isIntake = mediaChannelIds.includes(messageChannelId);
    expect(isIntake).toBe(true);
  });

  it("identifies non-intake channel messages as not requiring processing", () => {
    const mediaChannelIds = ["ch-intake-1", "ch-intake-2"];
    const messageChannelId = "ch-general";
    const isIntake = mediaChannelIds.includes(messageChannelId);
    expect(isIntake).toBe(false);
  });

  it("treats empty mediaChannelIds as no intake channels configured", () => {
    const mediaChannelIds: string[] = [];
    const isIntake = mediaChannelIds.includes("ch-general");
    expect(isIntake).toBe(false);
  });
});

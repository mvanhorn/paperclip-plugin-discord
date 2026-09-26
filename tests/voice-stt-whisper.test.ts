import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Unit tests for WhisperSTTAdapter. child_process.spawn is mocked so no real
// ffmpeg or whisper-cli process ever runs here — see
// voice-stt-whisper-integration.test.ts for the real-binary run, gated behind
// WHISPER_INTEGRATION=1.
//
// transcribeUtterance/transcribeFile do real (fast, but non-instant) fs work
// — mkdtemp, writeFile — before ever calling spawn(). Waiting on a fixed
// setTimeout(0) between "start the call" and "resolve the scripted child" is
// a race: fs I/O is not guaranteed to land inside one macrotask tick, so a
// test can fire a child's close event before spawn() ever attached a
// listener to it. waitForSpawnCalls polls until the mock has actually been
// invoked the expected number of times, which is deterministic instead.
// ---------------------------------------------------------------------------

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal?: string) => void;
  killedWith: string[];
};

const { spawnState } = vi.hoisted(() => ({
  spawnState: {
    /** One scripted child per expected spawn() call, consumed in order. */
    children: [] as FakeChild[],
    calls: [] as Array<{ command: string; args: string[] }>,
  },
}));

function makeChild(): FakeChild {
  const emitter = new EventEmitter() as FakeChild;
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.killedWith = [];
  emitter.kill = (signal?: string) => {
    emitter.killedWith.push(signal ?? "SIGTERM");
  };
  return emitter;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string, args: string[]) => {
    spawnState.calls.push({ command, args });
    const child = spawnState.children.shift();
    if (!child) throw new Error(`no scripted child process left for ${command}`);
    return child;
  }),
}));

import { WhisperSTTAdapter } from "../src/voice/stt-whisper.js";

/** Resolves once spawn() has actually been called `count` times. */
async function waitForSpawnCalls(count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (spawnState.calls.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`spawn() was not called ${count} time(s) within 2s (saw ${spawnState.calls.length})`);
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Finish a scripted child successfully: some stdout, then a clean close. */
function succeed(child: FakeChild, stdout: string): void {
  if (stdout) child.stdout.write(stdout);
  child.emit("close", 0);
}

function fail(child: FakeChild, code: number, stderr = "boom"): void {
  if (stderr) child.stderr.write(stderr);
  child.emit("close", code);
}

beforeEach(() => {
  spawnState.children.length = 0;
  spawnState.calls.length = 0;
});

describe("WhisperSTTAdapter — transcribeUtterance (live PCM)", () => {
  it("resamples via ffmpeg, then transcribes via whisper-cli, and returns trimmed stdout", async () => {
    const ffmpegChild = makeChild();
    const whisperChild = makeChild();
    spawnState.children.push(ffmpegChild, whisperChild);

    const adapter = new WhisperSTTAdapter({
      binaryPath: "/bin/whisper-cli",
      ffmpegPath: "/bin/ffmpeg",
      modelPath: "/models/ggml.bin",
    });

    const resultPromise = adapter.transcribeUtterance(Buffer.alloc(1920));
    await waitForSpawnCalls(1);
    succeed(ffmpegChild, "");
    await waitForSpawnCalls(2);
    succeed(whisperChild, "  hello from whisper  \n");

    await expect(resultPromise).resolves.toBe("hello from whisper");

    expect(spawnState.calls).toHaveLength(2);
    expect(spawnState.calls[0]!.command).toBe("/bin/ffmpeg");
    expect(spawnState.calls[0]!.args).toEqual(
      expect.arrayContaining(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"]),
    );
    expect(spawnState.calls[1]!.command).toBe("/bin/whisper-cli");
    expect(spawnState.calls[1]!.args).toEqual(
      expect.arrayContaining(["-m", "/models/ggml.bin", "-l", "en", "-nt", "-np"]),
    );
  });

  it("defaults the language to en and uses the documented default paths", async () => {
    const ffmpegChild = makeChild();
    const whisperChild = makeChild();
    spawnState.children.push(ffmpegChild, whisperChild);

    const adapter = new WhisperSTTAdapter();
    const resultPromise = adapter.transcribeUtterance(Buffer.alloc(960));
    await waitForSpawnCalls(1);
    succeed(ffmpegChild, "");
    await waitForSpawnCalls(2);
    succeed(whisperChild, "ok");
    await resultPromise;

    expect(spawnState.calls[0]!.command).toBe("/opt/homebrew/bin/ffmpeg");
    expect(spawnState.calls[1]!.command).toBe("/opt/homebrew/bin/whisper-cli");
    expect(spawnState.calls[1]!.args).toEqual(expect.arrayContaining(["-l", "en"]));
  });

  it("expands a model path under the home directory", async () => {
    const ffmpegChild = makeChild();
    const whisperChild = makeChild();
    spawnState.children.push(ffmpegChild, whisperChild);

    const adapter = new WhisperSTTAdapter({ modelPath: "~/.cache/whisper/ggml-large-v3-turbo-q8_0.bin" });
    const resultPromise = adapter.transcribeUtterance(Buffer.alloc(960));
    await waitForSpawnCalls(1);
    succeed(ffmpegChild, "");
    await waitForSpawnCalls(2);
    succeed(whisperChild, "ok");
    await resultPromise;

    const modelArgIndex = spawnState.calls[1]!.args.indexOf("-m");
    const modelArg = spawnState.calls[1]!.args[modelArgIndex + 1]!;
    expect(modelArg.startsWith("~")).toBe(false);
    expect(modelArg.endsWith("/.cache/whisper/ggml-large-v3-turbo-q8_0.bin")).toBe(true);
  });

  it("rejects on a non-zero ffmpeg exit and never calls whisper-cli", async () => {
    const ffmpegChild = makeChild();
    spawnState.children.push(ffmpegChild);

    const adapter = new WhisperSTTAdapter({ binaryPath: "/bin/whisper-cli", ffmpegPath: "/bin/ffmpeg" });
    const resultPromise = adapter.transcribeUtterance(Buffer.alloc(960));
    await waitForSpawnCalls(1);
    fail(ffmpegChild, 1, "invalid data found");

    await expect(resultPromise).rejects.toThrow(/exited with code 1/);
    expect(spawnState.calls).toHaveLength(1);
  });

  it("rejects on a non-zero whisper-cli exit, never a silent empty transcript", async () => {
    const ffmpegChild = makeChild();
    const whisperChild = makeChild();
    spawnState.children.push(ffmpegChild, whisperChild);

    const adapter = new WhisperSTTAdapter({ binaryPath: "/bin/whisper-cli", ffmpegPath: "/bin/ffmpeg" });
    const resultPromise = adapter.transcribeUtterance(Buffer.alloc(960));
    await waitForSpawnCalls(1);
    succeed(ffmpegChild, "");
    await waitForSpawnCalls(2);
    fail(whisperChild, 2, "model load failed");

    await expect(resultPromise).rejects.toThrow(/exited with code 2/);
  });

  it("rejects when whisper-cli exits 0 with empty stdout, never a silent empty transcript", async () => {
    const ffmpegChild = makeChild();
    const whisperChild = makeChild();
    spawnState.children.push(ffmpegChild, whisperChild);

    const adapter = new WhisperSTTAdapter({ binaryPath: "/bin/whisper-cli", ffmpegPath: "/bin/ffmpeg" });
    const resultPromise = adapter.transcribeUtterance(Buffer.alloc(960));
    await waitForSpawnCalls(1);
    succeed(ffmpegChild, "");
    await waitForSpawnCalls(2);
    succeed(whisperChild, "   \n");

    await expect(resultPromise).rejects.toThrow(/no transcript/i);
  });

  it("kills the child and rejects when ffmpeg runs past the timeout", async () => {
    const ffmpegChild = makeChild();
    spawnState.children.push(ffmpegChild);

    const adapter = new WhisperSTTAdapter({
      binaryPath: "/bin/whisper-cli",
      ffmpegPath: "/bin/ffmpeg",
      timeoutMs: 20,
    });

    await expect(adapter.transcribeUtterance(Buffer.alloc(960))).rejects.toThrow(/timed out/i);
    expect(ffmpegChild.killedWith).toContain("SIGKILL");
  });

  it("cleans up its temp directory on success", async () => {
    const ffmpegChild = makeChild();
    const whisperChild = makeChild();
    spawnState.children.push(ffmpegChild, whisperChild);

    const adapter = new WhisperSTTAdapter({ binaryPath: "/bin/whisper-cli", ffmpegPath: "/bin/ffmpeg" });
    const resultPromise = adapter.transcribeUtterance(Buffer.alloc(960));
    await waitForSpawnCalls(1);
    succeed(ffmpegChild, "");
    await waitForSpawnCalls(2);
    succeed(whisperChild, "ok");
    await resultPromise;

    // The resampled WAV path is the last ffmpeg arg.
    const resampledPath = spawnState.calls[0]!.args.at(-1)!;
    expect(existsSync(resampledPath)).toBe(false);
  });

  it("cleans up its temp directory on failure", async () => {
    const ffmpegChild = makeChild();
    spawnState.children.push(ffmpegChild);

    const adapter = new WhisperSTTAdapter({ binaryPath: "/bin/whisper-cli", ffmpegPath: "/bin/ffmpeg" });
    const resultPromise = adapter.transcribeUtterance(Buffer.alloc(960));
    await waitForSpawnCalls(1);
    fail(ffmpegChild, 1);

    await expect(resultPromise).rejects.toThrow();
    const resampledPath = spawnState.calls[0]!.args.at(-1)!;
    expect(existsSync(resampledPath)).toBe(false);
  });

  it("never spawns with a shell string — every call is command plus argv array", async () => {
    const ffmpegChild = makeChild();
    const whisperChild = makeChild();
    spawnState.children.push(ffmpegChild, whisperChild);

    const adapter = new WhisperSTTAdapter({ binaryPath: "/bin/whisper-cli", ffmpegPath: "/bin/ffmpeg" });
    const resultPromise = adapter.transcribeUtterance(Buffer.alloc(960));
    await waitForSpawnCalls(1);
    succeed(ffmpegChild, "");
    await waitForSpawnCalls(2);
    succeed(whisperChild, "ok");
    await resultPromise;

    for (const call of spawnState.calls) {
      expect(Array.isArray(call.args)).toBe(true);
      for (const arg of call.args) expect(typeof arg).toBe("string");
    }
  });
});

describe("WhisperSTTAdapter — transcribeBuffer (downloaded voice-message attachments)", () => {
  it("writes the buffer to a temp file named after the attachment's extension, then transcribes it", async () => {
    const ffmpegChild = makeChild();
    const whisperChild = makeChild();
    spawnState.children.push(ffmpegChild, whisperChild);

    const adapter = new WhisperSTTAdapter({ binaryPath: "/bin/whisper-cli", ffmpegPath: "/bin/ffmpeg" });
    const resultPromise = adapter.transcribeBuffer(Buffer.from("fake audio bytes"), "voice-message.ogg");
    await waitForSpawnCalls(1);
    succeed(ffmpegChild, "");
    await waitForSpawnCalls(2);
    succeed(whisperChild, "buffer transcript");

    await expect(resultPromise).resolves.toBe("buffer transcript");
    const inputIndex = spawnState.calls[0]!.args.indexOf("-i");
    expect(spawnState.calls[0]!.args[inputIndex + 1]).toMatch(/source\.ogg$/);
  });

  it("falls back to .ogg when the filename has no extension", async () => {
    const ffmpegChild = makeChild();
    const whisperChild = makeChild();
    spawnState.children.push(ffmpegChild, whisperChild);

    const adapter = new WhisperSTTAdapter({ binaryPath: "/bin/whisper-cli", ffmpegPath: "/bin/ffmpeg" });
    const resultPromise = adapter.transcribeBuffer(Buffer.from("fake audio bytes"), "no-extension");
    await waitForSpawnCalls(1);
    succeed(ffmpegChild, "");
    await waitForSpawnCalls(2);
    succeed(whisperChild, "ok");
    await resultPromise;

    const inputIndex = spawnState.calls[0]!.args.indexOf("-i");
    expect(spawnState.calls[0]!.args[inputIndex + 1]).toMatch(/source\.ogg$/);
  });

  it("cleans up its temp directory after transcribing a buffer", async () => {
    const ffmpegChild = makeChild();
    const whisperChild = makeChild();
    spawnState.children.push(ffmpegChild, whisperChild);

    const adapter = new WhisperSTTAdapter({ binaryPath: "/bin/whisper-cli", ffmpegPath: "/bin/ffmpeg" });
    const resultPromise = adapter.transcribeBuffer(Buffer.from("x"), "voice-message.ogg");
    await waitForSpawnCalls(1);
    succeed(ffmpegChild, "");
    await waitForSpawnCalls(2);
    succeed(whisperChild, "ok");
    await resultPromise;

    const sourcePath = spawnState.calls[0]!.args[spawnState.calls[0]!.args.indexOf("-i") + 1]!;
    expect(existsSync(sourcePath)).toBe(false);
  });
});

describe("WhisperSTTAdapter — transcribeFile (voice-message attachments)", () => {
  it("feeds the given file straight into ffmpeg, with no intermediate copy", async () => {
    const ffmpegChild = makeChild();
    const whisperChild = makeChild();
    spawnState.children.push(ffmpegChild, whisperChild);

    const adapter = new WhisperSTTAdapter({ binaryPath: "/bin/whisper-cli", ffmpegPath: "/bin/ffmpeg" });
    const resultPromise = adapter.transcribeFile("/tmp/downloaded-attachment.ogg");
    await waitForSpawnCalls(1);
    succeed(ffmpegChild, "");
    await waitForSpawnCalls(2);
    succeed(whisperChild, "attachment transcript");

    await expect(resultPromise).resolves.toBe("attachment transcript");
    const inputIndex = spawnState.calls[0]!.args.indexOf("-i");
    expect(spawnState.calls[0]!.args[inputIndex + 1]).toBe("/tmp/downloaded-attachment.ogg");
  });
});

describe("WhisperSTTAdapter — ffmpeg is hardened against a hostile input file (security review A6)", () => {
  async function runFfmpeg(call: (adapter: import("../src/voice/stt-whisper.js").WhisperSTTAdapter) => Promise<string>) {
    const ffmpegChild = makeChild();
    const whisperChild = makeChild();
    spawnState.children.push(ffmpegChild, whisperChild);
    const adapter = new WhisperSTTAdapter({ binaryPath: "/bin/whisper-cli", ffmpegPath: "/bin/ffmpeg" });
    const resultPromise = call(adapter);
    await waitForSpawnCalls(1);
    succeed(ffmpegChild, "");
    await waitForSpawnCalls(2);
    succeed(whisperChild, "ok");
    await resultPromise;
    return spawnState.calls[0]!.args;
  }

  it("always restricts ffmpeg to the file protocol, on every input path", async () => {
    const utteranceArgs = await runFfmpeg((a) => a.transcribeUtterance(Buffer.alloc(960)));
    expect(utteranceArgs).toEqual(expect.arrayContaining(["-protocol_whitelist", "file"]));

    spawnState.calls.length = 0;
    const fileArgs = await runFfmpeg((a) => a.transcribeFile("/tmp/attachment.ogg"));
    expect(fileArgs).toEqual(expect.arrayContaining(["-protocol_whitelist", "file"]));

    spawnState.calls.length = 0;
    const bufferArgs = await runFfmpeg((a) => a.transcribeBuffer(Buffer.from("x"), "attachment.ogg"));
    expect(bufferArgs).toEqual(expect.arrayContaining(["-protocol_whitelist", "file"]));
  });

  it("forces the wav demuxer for a live utterance — the format we always actually wrote", async () => {
    const args = await runFfmpeg((a) => a.transcribeUtterance(Buffer.alloc(960)));
    const fIndex = args.indexOf("-f");
    expect(args[fIndex + 1]).toBe("wav");
  });

  it("forces the ogg demuxer for an .ogg attachment, rather than auto-probing its content", async () => {
    const args = await runFfmpeg((a) => a.transcribeFile("/tmp/downloaded-attachment.ogg"));
    const fIndex = args.indexOf("-f");
    expect(args[fIndex + 1]).toBe("ogg");
  });

  it("forces the matching demuxer for a non-ogg attachment extension (e.g. wav)", async () => {
    const args = await runFfmpeg((a) => a.transcribeFile("/tmp/downloaded-attachment.wav"));
    const fIndex = args.indexOf("-f");
    expect(args[fIndex + 1]).toBe("wav");
  });

  it("falls back to auto-probe (no forced -f) for an attachment extension it does not recognize", async () => {
    const args = await runFfmpeg((a) => a.transcribeFile("/tmp/downloaded-attachment.bin"));
    expect(args).not.toContain("-f");
  });

  it("forces the demuxer matching transcribeBuffer's own extension argument", async () => {
    const args = await runFfmpeg((a) => a.transcribeBuffer(Buffer.from("x"), "voice-message.ogg"));
    const fIndex = args.indexOf("-f");
    expect(args[fIndex + 1]).toBe("ogg");
  });
});

/**
 * Local Whisper STT adapter (whisper.cpp), the only speech-to-text engine the
 * fork uses. No audio ever leaves the machine, and no code path here reads an
 * environment variable or secret for a remote transcription service.
 *
 * Runtime chosen by measuring it on the target laptop (see the pull request):
 * whisper.cpp via Homebrew (`whisper-cpp`), binary `whisper-cli`, model
 * ggml-large-v3-turbo-q8_0 (quantized large-v3 turbo). ffmpeg resamples
 * whatever audio arrives to the 16 kHz mono 16-bit WAV whisper-cli expects;
 * that resample step also turns raw PCM (from a live utterance) into a file
 * whisper-cli can read, so one pipeline serves both callers below.
 *
 * Both entry points spawn with an argument array, never a shell string, run
 * every temp file under a unique directory in os.tmpdir(), remove that
 * directory in a `finally`, and enforce a hard timeout that kills the child.
 * A non-zero exit or empty stdout is thrown as an error — never returned as a
 * silent empty transcript.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";

import type { STTAdapter } from "./types.js";

/** Matches the working command line verified on the target laptop. */
export const DEFAULT_WHISPER_BINARY_PATH = "/opt/homebrew/bin/whisper-cli";
export const DEFAULT_FFMPEG_PATH = "/opt/homebrew/bin/ffmpeg";
export const DEFAULT_WHISPER_MODEL_PATH = "~/.cache/whisper/ggml-large-v3-turbo-q8_0.bin";
export const DEFAULT_WHISPER_LANGUAGE = "en";

/** Ceiling on one child process (ffmpeg, then whisper-cli). Model load included. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * A live utterance arrives as raw 16-bit PCM at this rate (see
 * VoiceClientConfig / UtteranceFinalized in ./types.ts) — it is what
 * @discordjs/voice decodes Opus into, not a choice this adapter makes.
 */
const LIVE_UTTERANCE_SAMPLE_RATE = 48_000;

export interface WhisperSTTConfig {
  /** Path to the whisper-cli binary. Default: /opt/homebrew/bin/whisper-cli */
  binaryPath?: string;
  /** Path to ffmpeg, used to resample to the 16 kHz mono WAV whisper-cli expects. */
  ffmpegPath?: string;
  /** Path to the ggml model file. Default: ~/.cache/whisper/ggml-large-v3-turbo-q8_0.bin */
  modelPath?: string;
  /** Language code passed to whisper-cli. Default: en */
  language?: string;
  /** Ceiling on one child process call. Default: 60000 ms. */
  timeoutMs?: number;
}

/** `~` and `~/...` expand against the current user's home; anything else passes through untouched. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Run one child process to completion, spawned with an argument array. Kills
 * it on timeout. Rejects on a non-zero exit, carrying stderr so the failure is
 * legible without ever including a path or key the caller did not already
 * know.
 */
function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms and was killed`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
        return;
      }
      resolve({ stdout });
    });
  });
}

/**
 * Restricts ffmpeg to the local file protocol for every resource it might
 * open while handling one input — never http(s), never the concat demuxer's
 * own nested-file references, nothing that could turn a downloaded audio file
 * into an outbound request. Applied to every ffmpeg invocation, unconditionally.
 */
const FFMPEG_PROTOCOL_ARGS = ["-protocol_whitelist", "file"];

/**
 * Extensions this adapter recognizes well enough to force ffmpeg's demuxer
 * for, rather than letting it auto-probe the content. Auto-probe is itself an
 * attack surface for a file whose bytes were not chosen by us — the ogg,
 * wav, and mp4 demuxers alone have carried multiple format-confusion CVEs.
 * An unrecognized extension falls back to auto-probe rather than guessing.
 */
const KNOWN_AUDIO_FORMATS: Record<string, string> = {
  ".ogg": "ogg",
  ".oga": "ogg",
  ".opus": "ogg",
  ".wav": "wav",
  ".mp3": "mp3",
  ".m4a": "mp4",
  ".mp4": "mp4",
  ".flac": "flac",
  ".webm": "webm",
};

/** ffmpeg `-f <format>` args for a known extension, or none for an unknown one. */
function ffmpegFormatArgs(extension: string): string[] {
  const format = KNOWN_AUDIO_FORMATS[extension.toLowerCase()];
  return format ? ["-f", format] : [];
}

/** A minimal 44-byte PCM WAV header for 16-bit mono audio. */
function wavHeader(dataLength: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono, 16-bit)
  header.writeUInt16LE(2, 32); // block align (mono, 16-bit)
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);
  return header;
}

export class WhisperSTTAdapter implements STTAdapter {
  private readonly binaryPath: string;
  private readonly ffmpegPath: string;
  private readonly modelPath: string;
  private readonly language: string;
  private readonly timeoutMs: number;

  constructor(cfg: WhisperSTTConfig = {}) {
    this.binaryPath = expandHome(cfg.binaryPath ?? DEFAULT_WHISPER_BINARY_PATH);
    this.ffmpegPath = expandHome(cfg.ffmpegPath ?? DEFAULT_FFMPEG_PATH);
    this.modelPath = expandHome(cfg.modelPath ?? DEFAULT_WHISPER_MODEL_PATH);
    this.language = cfg.language ?? DEFAULT_WHISPER_LANGUAGE;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * One live utterance, as raw 16-bit PCM at 48 kHz mono (see STTAdapter).
   * The voice client already hands over one utterance at a time — a batch
   * engine fits this interface with no change to it.
   */
  async transcribeUtterance(pcm: Buffer): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-whisper-"));
    try {
      const sourcePath = join(dir, "utterance.wav");
      await writeFile(sourcePath, Buffer.concat([wavHeader(pcm.length, LIVE_UTTERANCE_SAMPLE_RATE), pcm]));
      // Always WAV: we just wrote that header ourselves. Forcing it, rather
      // than letting ffmpeg auto-probe, is not optional here — it is the
      // one path where the true format is never in doubt.
      return await this.convertAndTranscribe(sourcePath, dir, ["-f", "wav"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * An audio FILE already on disk, in whatever format ffmpeg can read (a
   * downloaded Discord voice-message attachment, typically Opus-in-OGG). Not
   * part of the STTAdapter interface: item 8's voice-message path calls this
   * directly on the fork's one transcriber, sharing the same pipeline.
   */
  async transcribeFile(filePath: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-whisper-"));
    try {
      return await this.convertAndTranscribe(filePath, dir, ffmpegFormatArgs(extname(filePath)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * An audio BUFFER already in memory (a downloaded Discord message
   * attachment — item 8's voice-message path). `filename` supplies the
   * extension ffmpeg's format probe is given as a hint; the container is
   * still detected from content, so an unknown or missing extension falls
   * back to `.ogg`, the shape a Discord voice message actually uses.
   */
  async transcribeBuffer(buffer: Buffer, filename = "attachment.ogg"): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-whisper-"));
    try {
      const ext = extname(filename) || ".ogg";
      const sourcePath = join(dir, `source${ext}`);
      await writeFile(sourcePath, buffer);
      return await this.convertAndTranscribe(sourcePath, dir, ffmpegFormatArgs(ext));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * ffmpeg resamples `sourcePath` to a 16 kHz mono WAV inside `dir`, then
   * whisper-cli transcribes that file. `dir` is caller-owned and removed by
   * the caller; this only ever writes the one intermediate file inside it.
   */
  private async convertAndTranscribe(sourcePath: string, dir: string, formatArgs: string[] = []): Promise<string> {
    const resampledPath = join(dir, "resampled.wav");
    await runProcess(
      this.ffmpegPath,
      [
        "-loglevel", "error", "-y",
        // Restricts ffmpeg to the local file protocol for ANY resource it
        // opens while handling this input — not just sourcePath itself — on
        // every path, hostile audio file or not. This is what stops a file
        // ffmpeg mis-probes as a playlist (or one crafted to look like one)
        // from making it reach out over the network. Always applied.
        ...FFMPEG_PROTOCOL_ARGS,
        // Forces the demuxer for a known extension rather than letting
        // ffmpeg auto-probe the content — auto-probe is itself a
        // format-confusion attack surface for bytes we did not choose.
        ...formatArgs,
        "-i", sourcePath,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", resampledPath,
      ],
      this.timeoutMs,
    );

    const { stdout } = await runProcess(
      this.binaryPath,
      ["-m", this.modelPath, "-f", resampledPath, "-l", this.language, "-nt", "-np"],
      this.timeoutMs,
    );

    const transcript = stdout.trim();
    if (!transcript) {
      throw new Error("whisper-cli produced no transcript");
    }
    return transcript;
  }
}

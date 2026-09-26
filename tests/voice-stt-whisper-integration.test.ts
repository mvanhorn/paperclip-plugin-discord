import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { WhisperSTTAdapter } from "../src/voice/stt-whisper.js";

// ---------------------------------------------------------------------------
// Real whisper-cli / ffmpeg on the host. Skipped unless WHISPER_INTEGRATION=1
// — no CI machine here has the model or the binaries installed, and this must
// never run as part of an ordinary `npm test`.
//
// Runs the fork's own transcriber (transcribeFile, the same pipeline the
// voice-message path in item 8 calls) three times against the same fixture
// and logs each wall time, so a cold run and two warm runs can be reported —
// mirroring the runtime measurement taken for the pull request.
// ---------------------------------------------------------------------------

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "voice.ogg");

describe.skipIf(process.env.WHISPER_INTEGRATION !== "1")("WhisperSTTAdapter — real binary", () => {
  it(
    "transcribes the fixture voice message three times through the fork's own transcriber",
    async () => {
      const adapter = new WhisperSTTAdapter();

      for (let run = 1; run <= 3; run++) {
        const started = Date.now();
        const transcript = await adapter.transcribeFile(FIXTURE);
        const elapsedMs = Date.now() - started;

        expect(transcript.length).toBeGreaterThan(0);
        // eslint-disable-next-line no-console
        console.log(`WHISPER_INTEGRATION run ${run}: ${elapsedMs}ms — "${transcript}"`);
      }
    },
    // Three real whisper-cli runs (one cold, model load included each time,
    // since each transcribeFile call is independent) comfortably exceed
    // vitest's default 5s test timeout.
    60_000,
  );
});

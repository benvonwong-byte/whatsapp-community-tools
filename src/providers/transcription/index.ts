import type { TranscriptionProvider } from "./types";
import { config } from "../../config";

export type { TranscriptionProvider, SpeakerTranscript, Utterance } from "./types";

let cachedProvider: TranscriptionProvider | null = null;
let cachedSpeakerProvider: TranscriptionProvider | null = null;

/** Get the transcription provider for simple voice-to-text */
export function getTranscriber(): TranscriptionProvider {
  if (cachedProvider) return cachedProvider;

  // Auto-detect: explicit setting, then check which API key is available
  const provider = config.transcriptionProvider || (config.groqApiKey ? "groq" : config.assemblyAiApiKey ? "assemblyai" : "");

  switch (provider) {
    case "groq": {
      const { GroqWhisperProvider } = require("./groq-whisper") as typeof import("./groq-whisper");
      cachedProvider = new GroqWhisperProvider(config.groqApiKey);
      break;
    }
    case "assemblyai": {
      const { AssemblyAIProvider } = require("./assemblyai") as typeof import("./assemblyai");
      cachedProvider = new AssemblyAIProvider(config.assemblyAiApiKey);
      break;
    }
    default:
      throw new Error(
        "No transcription provider configured. Set TRANSCRIPTION_PROVIDER and the corresponding API key.\n" +
        "Options: groq (GROQ_API_KEY), assemblyai (ASSEMBLYAI_API_KEY)"
      );
  }

  console.log(`[transcription] Using provider: ${provider}`);
  return cachedProvider;
}

/** Get a provider that supports speaker diarization (for recordings/calls) */
export function getSpeakerTranscriber(): TranscriptionProvider {
  if (cachedSpeakerProvider) return cachedSpeakerProvider;

  // Prefer AssemblyAI for speaker diarization
  if (config.assemblyAiApiKey) {
    const { AssemblyAIProvider } = require("./assemblyai") as typeof import("./assemblyai");
    cachedSpeakerProvider = new AssemblyAIProvider(config.assemblyAiApiKey);
    console.log("[transcription] Using AssemblyAI for speaker diarization");
    return cachedSpeakerProvider;
  }

  // Fall back to the configured provider (may not support speakers)
  cachedSpeakerProvider = getTranscriber();
  return cachedSpeakerProvider;
}

/** Reset cached providers (useful for tests) */
export function resetTranscriber(): void {
  cachedProvider = null;
  cachedSpeakerProvider = null;
}

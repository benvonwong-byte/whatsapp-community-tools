import { getTranscriber } from "../providers/transcription";

/**
 * Transcribe a voice note using the configured transcription provider.
 * Returns empty string if no provider is configured (graceful degradation).
 */
export async function transcribeVoiceNote(base64Data: string, mimetype: string): Promise<string> {
  try {
    return await getTranscriber().transcribe(base64Data, mimetype);
  } catch (err: any) {
    if (err?.message?.includes("No transcription provider")) {
      console.log("[transcription] No provider configured, skipping voice transcription");
      return "";
    }
    throw err;
  }
}

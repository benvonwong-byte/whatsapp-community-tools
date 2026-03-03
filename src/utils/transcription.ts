import { config } from "../config";

/**
 * Transcribe a voice note using Groq Whisper API.
 * WhatsApp voice notes are OGG/Opus — Groq accepts them directly.
 */
export async function transcribeVoiceNote(base64Data: string, mimetype: string): Promise<string> {
  if (!config.groqApiKey) {
    console.log("[transcription] No GROQ_API_KEY set, skipping voice transcription");
    return "";
  }

  const buffer = Buffer.from(base64Data, "base64");
  const blob = new Blob([buffer], { type: mimetype || "audio/ogg" });

  const form = new FormData();
  form.append("file", blob, "voice.ogg");
  form.append("model", "whisper-large-v3");
  form.append("response_format", "text");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.groqApiKey}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq transcription failed (${res.status}): ${errText}`);
  }

  return (await res.text()).trim();
}

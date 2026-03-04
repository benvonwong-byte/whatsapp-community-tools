import { TranscriptionProvider, SpeakerTranscript } from "./types";

export class GroqWhisperProvider implements TranscriptionProvider {
  private apiKey: string;
  supportsSpeakerDiarization = false;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(audioBase64: string, mimetype: string): Promise<string> {
    const buffer = Buffer.from(audioBase64, "base64");
    const blob = new Blob([buffer], { type: mimetype || "audio/ogg" });

    const form = new FormData();
    form.append("file", blob, "voice.ogg");
    form.append("model", "whisper-large-v3");
    form.append("response_format", "text");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Groq transcription failed (${res.status}): ${errText}`);
    }

    return (await res.text()).trim();
  }

  async transcribeWithSpeakers(_buffer: Buffer, _mimetype: string): Promise<SpeakerTranscript> {
    throw new Error("Groq Whisper does not support speaker diarization. Use AssemblyAI for speaker-labeled transcription.");
  }
}

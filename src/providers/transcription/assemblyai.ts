import { AssemblyAI } from "assemblyai";
import { TranscriptionProvider, SpeakerTranscript } from "./types";

export class AssemblyAIProvider implements TranscriptionProvider {
  private client: AssemblyAI;
  supportsSpeakerDiarization = true;

  constructor(apiKey: string) {
    this.client = new AssemblyAI({ apiKey });
  }

  async transcribe(audioBase64: string, _mimetype: string): Promise<string> {
    const buffer = Buffer.from(audioBase64, "base64");
    const uploadUrl = await this.client.files.upload(buffer);
    const transcript = await this.client.transcripts.transcribe({
      audio_url: uploadUrl,
    });
    if (transcript.status === "error") throw new Error(transcript.error || "Transcription failed");
    return transcript.text || "";
  }

  async transcribeWithSpeakers(audioBuffer: Buffer, _mimetype: string): Promise<SpeakerTranscript> {
    const uploadUrl = await this.client.files.upload(audioBuffer);
    const transcript = await this.client.transcripts.transcribe({
      audio_url: uploadUrl,
      speaker_labels: true,
    });
    if (transcript.status === "error") throw new Error(transcript.error || "Transcription failed");
    return {
      text: transcript.text || "",
      utterances: (transcript.utterances || []).map(u => ({
        speaker: u.speaker,
        text: u.text,
        start: u.start,
        end: u.end,
      })),
      duration: transcript.audio_duration || 0,
    };
  }
}

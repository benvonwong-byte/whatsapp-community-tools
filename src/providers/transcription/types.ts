export interface Utterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

export interface SpeakerTranscript {
  text: string;
  utterances: Utterance[];
  duration?: number;
}

export interface TranscriptionProvider {
  /** Transcribe audio to plain text (no speaker labels) */
  transcribe(audioBase64: string, mimetype: string): Promise<string>;

  /** Whether this provider supports speaker diarization */
  supportsSpeakerDiarization: boolean;

  /** Transcribe audio with speaker labels. Throws if not supported. */
  transcribeWithSpeakers(audioBuffer: Buffer, mimetype: string): Promise<SpeakerTranscript>;
}

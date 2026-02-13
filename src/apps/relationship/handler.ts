import { Message } from "../../whatsapp";
import { RelationshipStore } from "./store";
import { config } from "../../config";

/**
 * Transcribe a voice note using Groq Whisper API (free tier).
 * WhatsApp voice notes are OGG/Opus — Groq accepts them directly.
 */
async function transcribeVoiceNote(base64Data: string, mimetype: string): Promise<string> {
  if (!config.groqApiKey) {
    console.log("[relationship] No GROQ_API_KEY set, skipping voice transcription");
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

/**
 * Create a raw message listener for the Relationship app.
 * Captures text messages and voice notes from the private chat with Hope.
 */
export function createRelationshipHandler(store: RelationshipStore) {
  const chatNameLower = config.relationshipChatName.toLowerCase();

  return async (msg: Message, chat: any) => {
    // Only process the specific private chat
    if (chat.isGroup) return;
    if (!chat.name.toLowerCase().includes(chatNameLower)) return;

    // Skip duplicates
    if (store.isDuplicate(msg.id._serialized)) return;

    // Determine speaker
    const speaker = msg.fromMe ? "self" : "hope";

    // Handle text messages
    if (msg.body && msg.body.trim() !== "") {
      store.saveMessage({
        id: msg.id._serialized,
        speaker,
        body: msg.body,
        transcript: "",
        timestamp: msg.timestamp,
        type: "text",
      });
      console.log(`[relationship] Text from ${speaker}: ${msg.body.slice(0, 60)}...`);
    }

    // Handle voice notes (ptt = push-to-talk)
    if (msg.hasMedia && (msg.type as string) === "ptt") {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          const transcript = await transcribeVoiceNote(media.data, media.mimetype);
          store.saveMessage({
            id: msg.id._serialized,
            speaker,
            body: "",
            transcript,
            timestamp: msg.timestamp,
            type: "voice",
          });
          console.log(`[relationship] Voice from ${speaker}: "${transcript.slice(0, 60)}..."`);
        }
      } catch (err: any) {
        console.error(`[relationship] Voice note failed:`, err?.message || err);
        // Save a placeholder so we know the voice note existed
        store.saveMessage({
          id: msg.id._serialized,
          speaker,
          body: "[voice note - transcription failed]",
          transcript: "",
          timestamp: msg.timestamp,
          type: "voice",
        });
      }
    }
  };
}

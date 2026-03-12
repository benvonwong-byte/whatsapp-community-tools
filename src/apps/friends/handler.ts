import { Message } from "../../whatsapp";
import { FriendsStore } from "./store";
import { config } from "../../config";
import { transcribeVoiceNote } from "../../utils/transcription";

export function createFriendsHandler(store: FriendsStore) {
  const relationshipNameLower = config.relationshipChatName.toLowerCase();

  return async (msg: Message, chat: any) => {
    // 1. Filter: private (1:1) chats ONLY — no groups, no announcements, no broadcasts
    const isPrivate = !chat.isGroup;
    if (!isPrivate) return;
    const chatId = chat.id._serialized;
    if (chatId === "status@broadcast" || chatId.endsWith("@broadcast")) return;
    const participantCount = 1;

    // 2. Skip the relationship chat
    if (isPrivate && chat.name && chat.name.toLowerCase().includes(relationshipNameLower)) return;

    // 3. Skip system messages
    if (!msg.body && !msg.hasMedia) return;

    // 4. Auto-register and check monitoring
    store.upsertChat(chatId, chat.name || "", chat.isGroup, participantCount);
    if (!store.getChatMonitored(chatId)) return;

    // 5. Skip duplicates
    if (store.isDuplicate(msg.id._serialized)) return;

    // 6. Determine sender
    let senderId: string;
    let senderName: string = "";

    if (msg.fromMe) {
      senderId = "self";
      senderName = "Me";
    } else {
      // Private chat: use the chat ID as the contact identifier
      senderId = chatId;
      senderName = chat.name || "";
      try {
        const contact = await msg.getContact();
        // Prefer full name (address book) > pushname > chat name
        senderName = contact?.name || contact?.pushname || chat.name || "";
      } catch {}
    }

    // 7. Upsert contact (skip "self")
    if (senderId !== "self") {
      store.upsertContact(senderId, senderName, msg.timestamp);
    }

    // 8. Save message metadata + body
    const messageType = (msg as any).type || "text";
    const charCount = msg.body ? msg.body.length : 0;

    store.saveMessage({
      id: msg.id._serialized,
      chat_id: chatId,
      sender_id: senderId,
      sender_name: senderName,
      timestamp: msg.timestamp,
      is_from_me: msg.fromMe,
      message_type: messageType,
      char_count: charCount,
      body: msg.body || "",
    });

    // 9. Voice note detection + transcription
    if (msg.hasMedia && messageType === "ptt") {
      const contactForVoice = senderId === "self"
        ? (isPrivate ? chatId : senderId)
        : senderId;

      if (!store.isVoiceNoteDuplicate(msg.id._serialized)) {
        try {
          const media = await msg.downloadMedia();
          let transcript = "";
          if (media) {
            transcript = await transcribeVoiceNote(media.data, media.mimetype);
          }
          store.saveVoiceNote({
            id: msg.id._serialized,
            contact_id: contactForVoice,
            chat_id: chatId,
            transcript: transcript || "[transcription failed]",
            duration_estimate: 30,
            timestamp: msg.timestamp,
            is_from_me: msg.fromMe,
          });
          if (transcript) {
            console.log(`[friends] Voice from ${senderName}: "${transcript.slice(0, 60)}..."`);
          }
        } catch (err: any) {
          console.log(`[friends] Voice transcription failed: ${err?.message || err}`);
          store.saveVoiceNote({
            id: msg.id._serialized,
            contact_id: contactForVoice,
            chat_id: chatId,
            transcript: "[transcription failed]",
            duration_estimate: 30,
            timestamp: msg.timestamp,
            is_from_me: msg.fromMe,
          });
        }
      }
    }

  };
}

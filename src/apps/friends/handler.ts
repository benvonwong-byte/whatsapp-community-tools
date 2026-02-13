import { Message } from "../../whatsapp";
import { FriendsStore } from "./store";
import { config } from "../../config";

export function createFriendsHandler(store: FriendsStore) {
  const relationshipNameLower = config.relationshipChatName.toLowerCase();

  return async (msg: Message, chat: any) => {
    // 1. Filter: private chat OR small group (2-6 participants)
    const isPrivate = !chat.isGroup;
    const participants = (chat as any).participants;
    const participantCount = participants ? participants.length : 1;
    const isSmallGroup = chat.isGroup && participantCount >= 2 && participantCount <= 6;

    if (!isPrivate && !isSmallGroup) return;

    // 2. Skip the relationship chat
    if (isPrivate && chat.name && chat.name.toLowerCase().includes(relationshipNameLower)) return;

    // 3. Skip system messages
    if (!msg.body && !msg.hasMedia) return;

    // 4. Auto-register and check monitoring
    const chatId = chat.id._serialized;
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
    } else if (chat.isGroup) {
      senderId = (msg as any).author || msg.from;
      try {
        const contact = await msg.getContact();
        senderName = contact?.pushname || contact?.name || senderId;
      } catch {
        senderName = senderId;
      }
    } else {
      // Private chat: use the chat ID as the contact identifier
      senderId = chatId;
      senderName = chat.name || "";
      try {
        const contact = await msg.getContact();
        senderName = contact?.pushname || contact?.name || chat.name || "";
      } catch {}
    }

    // 7. Upsert contact (skip "self")
    if (senderId !== "self") {
      store.upsertContact(senderId, senderName, msg.timestamp);
    }

    // 8. Save lightweight metadata (NOT the message body)
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
    });
  };
}

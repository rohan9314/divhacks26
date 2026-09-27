/** One inbound message, normalized by whichever adapter received it. */
export interface InboundMessage {
  spaceId: string;
  messageId: string;
  /** Message text; empty when the message was only a shared location. */
  text: string;
  location?: { latitude: number; longitude: number };
  isGroup: boolean;
  /**
   * The sender's address on the channel (E.164 phone or Apple ID email). Used only to verify
   * website sign-in codes; never logged or stored.
   */
  senderAddress?: string;
}

/**
 * The only thing that talks to users. Swapping Photon for another provider means writing
 * one of these; the router and skills don't change.
 */
export interface ChannelAdapter {
  name: string;
  start(onMessage: (message: InboundMessage) => void): Promise<void>;
  send(spaceId: string, text: string): Promise<void>;
  /** Open a 1:1 chat with a phone number and send the first message (website "say hi"). */
  sendTo?(phone: string, text: string): Promise<void>;
}

/** In group chats the agent answers only when mentioned: "@agent where should we eat?". */
export function mentionOf(agentName: string) {
  const escaped = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\s)@${escaped}\\b[,:!]?`, "gi");
  return (text: string): { mentioned: boolean; request: string } => {
    const mentioned = new RegExp(pattern.source, "i").test(text);
    return { mentioned, request: text.replace(pattern, " ").replace(/\s+/g, " ").trim() };
  };
}

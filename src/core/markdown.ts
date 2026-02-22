/** Escape text for Telegram MarkdownV2 */
export function escapeMarkdownV2(text: string): string {
  // Characters that must be escaped outside code blocks
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Convert standard markdown to Telegram MarkdownV2.
 * Handles code blocks (preserve as-is), inline code, bold, italic, links.
 */
export function toTelegramMarkdown(text: string): string {
  const parts: string[] = [];
  // Split by code blocks first (``` ... ```)
  const segments = text.split(/(```[\s\S]*?```)/g);

  for (const seg of segments) {
    if (seg.startsWith("```")) {
      // Code block: extract lang and content, only escape backslash and backtick inside
      const match = seg.match(/^```(\w*)\n?([\s\S]*?)```$/);
      if (match) {
        const lang = match[1];
        const code = match[2].replace(/([\\`])/g, "\\$1");
        parts.push(`\`\`\`${lang}\n${code}\`\`\``);
      } else {
        parts.push(seg);
      }
    } else {
      // Process inline elements
      let s = seg;
      // Protect inline code first
      const inlineCodes: string[] = [];
      s = s.replace(/`([^`]+)`/g, (_, code) => {
        const escaped = code.replace(/([\\`])/g, "\\$1");
        inlineCodes.push(`\`${escaped}\``);
        return `\x00IC${inlineCodes.length - 1}\x00`;
      });

      // Escape special chars in normal text
      s = escapeMarkdownV2(s);

      // Restore bold **text** → *text*
      s = s.replace(/\\\*\\\*(.+?)\\\*\\\*/g, "*$1*");
      // Restore italic _text_ (single underscore)
      s = s.replace(/\\_(.+?)\\_/g, "_$1_");
      // Restore links [text](url)
      s = s.replace(/\\\[(.+?)\\\]\\\((.+?)\\\)/g, "[$1]($2)");

      // Restore inline codes
      s = s.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[Number(i)]);

      parts.push(s);
    }
  }
  return parts.join("");
}

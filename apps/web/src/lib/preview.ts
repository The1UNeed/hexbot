/**
 * A chat's latest message as one plain line for a chat list: the daemon's
 * preview is the message's raw start, markdown marks and line breaks included.
 */
export const previewLine = (text: string) =>
  text
    .split('\n')
    .map(line => line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, ''))
    .join(' ')
    // The daemon's cut can end a link before its closing parenthesis.
    .replace(/!?\[([^\]]*)\]\([^)]*(?:\)|$)/g, '$1')
    .replace(/\\[[\]()]/g, '')
    // Emphasis marks only: a lone * between spaces or digits is the message's own.
    .replace(/\*{2,}|_{2,}|`+|~~/g, '')
    .replace(/(^|[\s(])\*(?=[\p{L}\p{N}])|(?<=\S)\*(?=$|[\s\p{P}])/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim()

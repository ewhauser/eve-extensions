const sentenceInitialSlackUserMention =
  /(?:^|[.!?;]\s+|\n)[ \t]*(?:(?:hey|hi|hello|yo)\b[ \t]*(?:[,.:;!?~\u2014\u2013-][ \t]*)?)?<@[UW][A-Z0-9]+(?:\|[^>]+)?>/iu;

/**
 * Detects a canonical Slack user mention used as a sentence-initial addressee.
 * The handler separately gives direct messages and explicit Eve mentions
 * precedence, so a match there is known to address a non-Eve Slack user.
 */
export function hasSentenceInitialSlackUserMention(text: string): boolean {
  return sentenceInitialSlackUserMention.test(text);
}

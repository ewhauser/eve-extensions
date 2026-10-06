/** Current-turn human input captured before framework task-result messages arrive. */
const inputByTurn = new Map<string, string>();

function key(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

export function rememberUserInput(sessionId: string, turnId: string, message: string): void {
  if (message.startsWith("<task_result ") || message.startsWith("[Tasks]")) return;
  inputByTurn.set(key(sessionId, turnId), message);
}

export function currentUserInput(sessionId: string, turnId: string): string | undefined {
  return inputByTurn.get(key(sessionId, turnId));
}

export function forgetUserInput(sessionId: string, turnId: string): void {
  inputByTurn.delete(key(sessionId, turnId));
}

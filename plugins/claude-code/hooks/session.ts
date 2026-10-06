/** User prompt text is data; only its single-line title and bounded body are stored. */
export function sessionDescription(prompt: string, sessionId: string, sessionName = sessionId) {
  return {
    title: "Claude session: " + (prompt.replace(/\s+/g, " ").trim() || sessionName).slice(0, 70),
    body: prompt.slice(0, 1500) + "\n\nClaude session id: " + sessionId,
  };
}

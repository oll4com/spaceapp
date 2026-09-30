const PERSONAL_REQUEST = /\b(?:address|home address|phone(?: number)?|email(?: address)?|password|credential|cookie|private (?:file|message|chat|memory|data)|personal (?:data|information|details)|real name|full name|where (?:does|do) (?:the streamer|you|he|she) live|where (?:is|are) (?:the streamer|you) from|how old (?:is|are) (?:the streamer|you)|family|income|bank account)\b/i;
const OPERATOR_REFERENCE = /\b(?:streamer|owner|operator|pirniramon|your|you|his|her|their)\b/i;
const GREEK_PERSONAL_REQUEST = /(?:διεύθυνσ|τηλέφων|ηλικί|οικογένει|εισόδημ|τραπεζικ|κωδικ|προσωπικ|πού μέν|που μέν|πραγματικ.{0,8}όνομ)/iu;
const GREEK_OPERATOR_REFERENCE = /(?:streamer|owner|operator|pirniramon|σου|σας|του|της|ιδιοκτήτ|δημιουργ|παρουσιαστ)/iu;
const PRIVATE_OPERATOR_CLAIM = /\b(?:streamer|owner|operator|pirniramon)(?:'s)?\b[^.!?\n]{0,40}\b(?:lives in|is from|real name|full name|age is|address|phone|family|income|bank account)\b/i;

export const PRIVATE_DATA_REFUSAL = "I can't share the streamer's personal information. Happy to talk about SpaceApp or the stream instead.";

export function asksForOperatorPrivateData(message: string): boolean {
  return (PERSONAL_REQUEST.test(message) && OPERATOR_REFERENCE.test(message)) ||
    (GREEK_PERSONAL_REQUEST.test(message) && GREEK_OPERATOR_REFERENCE.test(message));
}

/** Conservative public-output gate for obvious contact details and secrets. */
export function containsSensitiveDisclosure(text: string): boolean {
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text) ||
    /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?){2}\d{4}\b/.test(text) ||
    /\b(?:password|secret|api[_ -]?key|access[_ -]?token|cookie)\s*[:=]\s*\S+/i.test(text) ||
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(text) ||
    PRIVATE_OPERATOR_CLAIM.test(text) ||
    /(?:ο streamer|ο ιδιοκτήτης|η ιδιοκτήτρια|ο παρουσιαστής).{0,35}(?:μένει|διεύθυνσ|τηλέφων|ηλικί|οικογένει|εισόδημ|πραγματικ.{0,8}όνομ)/iu.test(text);
}

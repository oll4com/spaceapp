/**
 * Business rule shared by the Security and Monitoring Copilots' action finish: VERIFIED, FAILED and ROLLED_BACK carry
 * the verification, SUPERSEDED its evidence (the verification counts too) (ARCH-002). Pass to `.refine(...)`.
 */
export function finishedChangeHasProof(): [(input: { status: string; verification?: string; evidence?: string }) => boolean, { message: string }] {
  return [(input) => input.status === "SUPERSEDED" ? Boolean(input.evidence ?? input.verification) : Boolean(input.verification),
    { message: "SUPERSEDED needs evidence; VERIFIED, FAILED and ROLLED_BACK need the verification." }];
}

/** Business rule shared by the Marketing and Freelance review decisions: a review sent back carries a note (ARCH-002). */
export function revisionHasNote(): [(input: { decision: string; note?: string }) => boolean, string] {
  return [(input) => input.decision !== "revise" || Boolean(input.note), "Tell the copilot what to change."];
}

/**
 * Where a STEP_UP_REQUIRED answer sends the person (operator 17/11, nous_msg:db5f61cafe3847b1ad5f59f6: "if I don't know the password I can't
 * type it"): a fresh Google sign-in or a link mailed to the account, either alone; the password stays an option for whoever knows it.
 */
export const STEP_UP_ROUTES = {
  stepUpUrl: "/api/auth/google/start?stepUp=mobile",
  mailUrl: "/api/auth/step-up/mail/request",
  passwordUrl: "/api/auth/step-up/password"
} as const;

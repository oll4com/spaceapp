# iCIMS (external ATS for many enterprises)

- Script-set values do not survive a validation reload: after any failed "Submit Profile",
  only values typed through real input persist. Fill with `browser_fill_form`/`browser_type`
  (real typing), blur each field, and submit in the same pass; re-read values immediately
  before submit.
- Custom ListEditor dropdowns (country, source, several `rcf…` fields) revert to blank after
  every failed submit and must be redone; expect two or three submit/fix cycles.
- Step 2 EEO has required selects (gender, race, nationality) even though the page says the
  answers are voluntary; an unset nationality yields "Invalid Data Error". Use "prefer not
  to say" style options where offered; otherwise fill only what the profile states.
- Completion signal: URL `.../job?mode=submit_apply` and the frame text "Your application was
  submitted successfully. Thank you for applying." Screenshot it as evidence.
- Candidate sessions do not survive a browser restart: a login wall means `LOGIN` handoff;
  the operator signs in, you continue. Never store the account password.
- hCaptcha on account creation is an operator step: `CAPTCHA` handoff.

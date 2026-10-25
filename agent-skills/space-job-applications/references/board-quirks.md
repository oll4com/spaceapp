# Board and company-site quirks

## Stripe and other custom career sites with Greenhouse iframes
- `boards.greenhouse.io/<board>/jobs/<id>` redirects to a listing page; the form is an
  iframe at `job-boards.greenhouse.io/embed/job_app?for=<board>&token=<jobId>`. Open the
  embed URL directly in the pane browser.
- Multi-select "country of residence" widgets render checkbox-styled `div.select__option`
  elements whose labels appear only in the a11y snapshot: click the option through its
  snapshot ref; if the click does not commit, `browser_evaluate` a mousedown/mouseup/click
  on the inner checkbox, then press Escape.
- Options can be full sentences ("Yes, I intend to work remotely."): match the whole label.

## Databricks-style page-2 questions
- Residency/citizenship comboboxes appear only after the first submit; their flyout opens
  through the adjacent "Toggle flyout" button. Sanctions checkbox groups want "None of the
  above"; follow-ups want "Not applicable".
- "Do you have minimum N years of experience in X?" is an operator-owned fact: answer from
  the profile or route to `NEEDS_USER`.

## Lever
- Plain inputs, textareas and native selects fill normally. Checkboxes and radios sit in
  groups; answer by group. Lever forms carry a CAPTCHA before submit: request a handoff.
- Ashby and Lever usually have no mailbox code step; the confirmation page is the evidence.

## Workable
- A SPA that re-renders often: re-snapshot before each fill and never cache refs across
  steps. If fills keep failing, hand the remaining fields to the operator with a numbered list
  in the terminal.

## Batch lessons
- Repeated identical validation failures across one board are not random: stop, inspect one
  posting, fix the approach, verify one full application, then continue.
- Keep one key per posting (the URL) so the tracker never counts a job twice.
- Ask before continuing when the pool's geography contradicts the candidate's residence.

# Greenhouse (boards.greenhouse.io, job-boards.greenhouse.io/embed)

## Widget taxonomy: combobox vs textbox
- The a11y snapshot (`browser_snapshot`) shows react-select dropdowns as `combobox` and
  plain inputs as `textbox`. Form fields that look like dropdowns in validation errors are
  often plain `textbox` inputs; fill them with `browser_fill_form`/`browser_type`, do not
  search for an option.
- Education sections (School, Degree, Discipline, start/end month) are comboboxes; the
  year fields are plain number inputs. react-select options need a hover or a typed prefix
  before the option appears; type a few characters, wait, then click the option.
- Multi-page forms surface new required fields only after a submit. Each validation error
  lists the missing labels (`X is required`); map every label to its widget type before
  filling. `invalid=N` equals the number of missing fields.
- "How many years of experience do you have in <X>?" is a required textbox on the next page;
  answer only from the profile (years are an operator-owned fact).

## Embed forms (companies that iframe Greenhouse)
- The embed URL carries a per-load `validityToken`; the plain board URL redirects back to the
  careers page without it. Read `document.getElementById('grnhse_iframe').src` with
  `browser_evaluate` and navigate the pane browser to that exact URL.
- Inputs inside the embed can stay non-interactive until a value was set once: if
  `browser_fill_form` times out, set the value with `browser_evaluate` (native value setter +
  `input` and `change` events, `bubbles: true`) and then fill the field again by ref.
- Resume input is `visually-hidden`: click "Attach" and use `browser_file_upload`, which
  handles the file chooser. Confirm the file name appears in the page text.
- Some embed React forms never commit values set by script (final validation says
  "last name is required" although the inputs show values). After two failed rounds mark
  `NEEDS_USER` and ask the operator to type the remaining fields in the live view.
- Custom question names are opaque ids (`question_12345`); match by their visible label.

## Security-code page (Greenhouse mails an 8-character code)
- Two layouts: eight single-character boxes (first box labelled "Security code", seven bare
  boxes) or one textbox for the whole code.
- Split boxes: click the first box, then `browser_type` the whole code; real key events
  advance the focus and enable the Submit button. If the button stays disabled, press `Tab`
  and re-snapshot before clicking. Do not resubmit the form to get another code: every
  submit mails a new one and the page state goes stale.
- Get the code with `space_job_mail_wait_for_code {fromContains: "greenhouse-mail.io", subjectContains:
  "security code", pattern: "security code[\\s\\S]{0,160}?:\\s*([A-Za-z0-9]{8})\\b", timeoutMs: 180000}`.
  The mail reads "...the security code field on your application: XXXXXXXX"; the pattern anchors on
  that colon, because an unanchored `([A-Za-z0-9]{8})` captures "applicat" from "application".
- A wrong code shows "Incorrect security code" and mails no new one: clear the eight boxes and
  type the right code again; do not resubmit the form.
- Thank-you page texts that count as the confirmation: "Thank you for applying", "thanks for
  applying", "application has been submitted", "we are pleased to receive your application".
  Reject sidebar text such as "create a job alert" as evidence.

## Known board quirks
- Consent/acknowledge checkboxes re-appear after the first submit on some boards; tick only
  consent checkboxes, never newsletter/marketing opt-ins.
- Affirm-style EU questions: answer citizenship, residence and sponsorship exactly from the
  profile ("n/a" when the form asks non-EU citizens only and the candidate is EU).
- US-state/Canadian-province-only residence lists exclude everyone else: `not eligible`.

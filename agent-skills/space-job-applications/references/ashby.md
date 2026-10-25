# Ashby (jobs.ashbyhq.com)

## Field ids and React-controlled inputs
- Standard fields: `#_systemfield_name`, `#_systemfield_email`, `#_systemfield_resume`;
  phone is `input[type=tel]` or a plain `id=phone`.
- Custom question ids are UUIDs that often start with a digit (`1253646e-...`). A CSS id
  selector is invalid for them; use the snapshot ref, or `document.getElementById` inside
  `browser_evaluate`.
- Inputs are React-controlled: when a plain fill is ignored, set the value with the
  prototype value setter and dispatch `input` and `change` (`bubbles: true`), then re-read.
  After answering custom questions Ashby may re-render and drop name/email: rewrite name and
  email once more right before submit and verify.
- Resume: `browser_file_upload` on `#_systemfield_resume` (confirm the file name in the page).
- Location uses Ashby's own dropdown: type into `input[placeholder*="Start typing"]`, wait,
  click the `[role=option]`.

## Custom-question engine, the seven bugs
1. Digit-leading ids break CSS selectors → use refs / `getElementById`.
2. Yes/No radios: click the option **label** of that question's own group; a JS `click()`
   on the input does not fire React's synthetic events.
3. Scope radio picks to the group under the question's `[class*=fieldEntry]`; a global
   "first No on the page" answers the wrong question.
4. Consent checkboxes may have an empty `name` and no ancestor label; find them by the
   nearby "By submitting, I acknowledge…" text inside the same entry.
5. "Select all that apply" checkbox groups (office locations, tools) are required too.
6. Required fields are revealed in chains: after each submit read the
   "Missing entry for required field: X" message, fill X, submit again (bounded).
7. Verify every value by id before submit; never trust a bare loop.

## reCAPTCHA
- Ashby appends a hidden `g-recaptcha-response` input and a reCAPTCHA v2 iframe. If
  `document.getElementsByName('g-recaptcha-response')[0].value` is empty the check is not
  done: `space_browser_request_handoff {kind: "CAPTCHA"}` and `space_job_handoff_wait`; the operator ticks
  "I'm not a robot" in the live view, then you click Submit Application.

## Per-candidate application limits (not a bug)
- Boards enforce limits such as "candidates may not apply more than 5 times in any 180 day
  span". Symptoms: a submit error containing "limit", "maximum number", "fewer", "can't apply
  more than", or the submit button missing entirely. Defer the posting to the date the limit
  expires (SKILL.md, "Employer-side application limits": `QUEUED` + `notBefore`, note
  `limit: <text>`, `COMPANY` memory tagged `limit`); the run serves it again from that date.

## After a browser restart
- Form state is not persisted: a note saying "already filled, one click left" is not trusted.
  Re-read the actual values; if blank, fill again from the profile.

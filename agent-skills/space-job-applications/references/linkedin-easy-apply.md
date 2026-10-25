# LinkedIn Easy Apply

## Form structure
- After clicking Easy Apply the `role="dialog"` element exists but is `inert` and empty; the
  form renders in the main frame. `document.body.innerText.slice(0, 500)` starts with
  `Apply to <Company>`, `1/N pages`, `Contact info`.
- 3–12 pages. Next buttons: "Continue to next step", "Next", "Continue"; then "Review your
  application"; then "Submit application". Confirmation: "Application sent" / "Application
  submitted". The CTA changing to "I'm interested" is not proof.
- Input ids contain guillemets (`«r1j»`); copy ids from the snapshot, do not retype them.
- Postings with `applicantTrackingSystemName=<ATS>` in the URL redirect to an external ATS:
  note `external: <ats>` and apply with that playbook instead.

## Guarded flow (per job)
1. Open `jobs/view/<id>` and wait ≥ 8 s; use the first **visible**
   `button.jobs-apply-button` or `button[aria-label*="Easy Apply"]` (sidebar clones are hidden).
2. Contact step: values are pre-filled from the LinkedIn profile. Verify email, country code
   and phone against the profile; stale country codes happen — fix the select and dispatch
   `change`/`input` with bubbles.
3. Resume step: pick the radio whose label contains the profile CV file name; otherwise
   upload `cv.path` with `browser_file_upload`.
4. Question steps: snapshot all controls; answer each question by its own ref and the
   control type it implies (years → text input, proficiency → select, yes/no → the radio
   in that fieldset). Empty question steps exist; Next passes through them. "Mark job as a
   top choice" is optional: leave it.
5. Review step is the guard: the page text must contain the candidate's name, email and the
   CV name, and no numeric answer may appear in a select or in several inputs. Only then
   click "Submit application" and screenshot the confirmation.

## The mass-fill bug class
- A label-match fill once wrote a LinkedIn URL into every visible text input (first/last/
  preferred names, address, zip). Never batch-fill by label; one field, one ref. After any
  question fill, dump visible inputs and assert that no value sits in an unrelated field.

## Throttle and session
- Rapid job-page views (30+ in minutes) make every job page render the same recommended
  posting. Pace views ≥ 8–10 s apart, check in batches of 5–10, pause 15–60 min on symptoms.
- The session lives in the pane browser profile. Never export cookies or session files; if
  LinkedIn asks for a login or a checkpoint, request a `LOGIN` handoff.
- The applied list at `linkedin.com/jobs-tracker/?stage=applied` is paginated by page buttons
  (scroll does not load more); use it to avoid duplicates when the tracker lacks a URL.

# Workday (myworkdayjobs.com)

- Every employer has its own candidate account; account creation and sign-in are operator
  steps (`LOGIN` handoff), and most tenants verify the email with a link:
  `space_job_mail_find_link {fromContains: "myworkday", urlContains: "myworkdayjobs", timeoutMs: 180000}`.
- "Autofill with Resume" parses the CV into Experience/Education sections: upload with
  `browser_file_upload`, wait for the parse, then verify every created entry against the
  profile and remove hallucinated ones; add missing employers only from the CV text.
- Sections are separate pages (My Information, My Experience, Application Questions,
  Voluntary Disclosures, Self Identify, Review). Snapshot each page; required fields show a
  red "Error" banner with the field names after Next.
- Prompt-style selects (country, phone type, "how did you hear") open a search list: type a
  prefix, wait, click the option.
- Voluntary disclosures: choose "I do not wish to answer" where offered.
- Confirmation: the "Review" page's Submit leads to a "Thank you" / "Application submitted"
  screen and the tenant mails a confirmation; screenshot the screen as evidence.

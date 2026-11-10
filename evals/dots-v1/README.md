# Space Dots evaluation dataset (dots-v1)

Frozen cases that check what a Dot actually did, not only what it wrote. It extends `chat-v1` (offline text checks) with four families run on the real runtime:

| Family | What it checks |
|---|---|
| `mcp` | Space tools through the Dot gateway: the right tool ran, forbidden operations (tests, deploys, CLI access) never ran, writes waited for approval. |
| `multimodal` | Attached CSV, Markdown, PDF (with and without a text layer), XLSX, DOCX and PNG: the answer, and the coverage Space recorded for each file. |
| `background` | Goals that finish with evidence, update milestones or stop to ask the user; delegation, schedules and deliverables that wait for approval. |
| `channels` | Mail, calendar, Slack and Teams. These need the user's connections; without them the cases count as not run, never as passed. |

Each scenario group has an English and a Greek variant. Both variants stay in the same split, and the gates count a group once. The last two groups of every family (three for `multimodal`) are holdout.

- `dataset.json` holds the cases. Each case carries result checks (`acceptance`), receipt checks (`receiptChecks`), required connections (`requires`) and a `mode`. `BACKGROUND` cases start a Goal whose objective is the prompt.
- `fixtures/` holds the attached files.
- `manifest.json` holds the SHA-256 of the dataset and of every fixture, and the gates.

Rebuild with `node scripts/build-dots-eval-dataset.mjs`. The output is deterministic. Never edit the dataset after a policy has been tuned on it; a new version gets a new directory.

## Running and comparing

1. An ADMIN opens a Dot's settings in a Chat pane and runs the evaluation. Space opens one pane and starts a new conversation per case. While a case runs, every change through Space tools waits for approval, and whatever is still waiting is declined once the case is recorded. A case that does not finish in time counts as failed.
2. `GET /api/dots/:dotId/evals/:evalRunId/receipts` returns what Space recorded for each case.
3. To compare a candidate (another model, reasoning level or Auto policy) with the baseline:

   ```sh
   node scripts/dots-eval-gates.mjs --dataset dots-v1 --baseline baseline.json --candidate candidate.json [--available connector:mail-read,channel:slack]
   ```

A candidate is release-eligible only when all of these hold on the holdout split:

- every family reaches 95%;
- it is no worse than the baseline by more than 2 points at 95% one-sided confidence, paired by group;
- every family has enough independent groups to show that margin;
- costs are comparable and not higher;
- the evidence comes from runtime receipts;
- people have calibrated the checks (`independentCalibrationComplete`).

Six groups per family size the method; they are not enough for a release.

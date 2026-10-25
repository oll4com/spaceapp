# PLAN v2 — Διορθωμένο πλάνο τεχνικής ωρίμανσης (AI reviews, στόχος 5/5)

PLAN: `clipboard:wxc6q7AaaMt6` · Αναθεώρηση: 2026-10-10 · Εκτελεστής: Claude Code
Αντικαθιστά τη σειρά εκτέλεσης του αρχικού σώματος (2026-10-02). Οι στόχοι,
τα όρια και τα κριτήρια μη παλινδρόμησης του αρχικού πλάνου ισχύουν, εκτός
όπου διορθώνονται ρητά παρακάτω.

## 1. Γιατί χρειάστηκε διόρθωση

| # | Το αρχικό πλάνο έλεγε | Η πραγματικότητα στις 2026-10-10 | Διόρθωση |
|---|---|---|---|
| 1 | «PLANNED — 0%» | Υπήρχε υλοποίηση 38% (101 commits) σε απομονωμένο clone `agent-workspace/active/20261003-spaceapp-ai-reviews`, σε παύση από 03/10, **ποτέ merged ούτε deployed**. Το main είχε στο μεταξύ 461 νεότερα commits. | Πρώτο βήμα η ενσωμάτωση της δουλειάς στο τρέχον main, με επίλυση των 17 συγκρούσεων υπέρ του νεότερου κώδικα του main σε κάθε προστατευμένη περιοχή. |
| 2 | Τα ευρήματα προέρχονται από τα 4 reviews | Νέος έλεγχος στο σημερινό main βρήκε **κρίσιμο P0 που δεν ανέφερε κανένα review**: `DELETE /api/worktrees` διέγραφε αναδρομικά οποιονδήποτε φάκελο (ακόμη και το `/opt/spaceapp`) για κάθε συνδεδεμένο χρήστη. | Νέο εύρημα SEC-W1 με άμεσο hotfix στο live πριν από οτιδήποτε άλλο. |
| 3 | Execution core σε Temporal με outbox | Η εκτέλεση των managed plans δεν τρέχει σε Temporal: τη διαχειρίζεται controller μέσα στο API με leases. Το «outbox» είναι πεδίο jsonb, όχι πίνακας. Ακριβές native resume έχουν μόνο 4 από τα 16 runtimes (Codex, Claude, OpenCode, DeepSeek). | Το failure matrix και οι δηλώσεις capability βασίζονται στην πραγματική αρχιτεκτονική. Για τα 12 runtimes το resume «πιο πρόσφατης συνεδρίας» δηλώνεται ως περιορισμός, όχι ως ισοδυναμία. |
| 4 | Κάθε αρχείο review παραδίδεται μέσω Agent Files | Ο κανόνας του repo της 2026-10-10 απαγορεύει την αυτόματη δημοσίευση αποδεικτικών ή αναφορών. | Τα αποδεικτικά μένουν στο `docs/quality/` και στο `agent-workspace/reports/`. Agent Files μόνο με ρητό αίτημα. |
| 5 | «Commits μόνο στο main» | Ο κανόνας του repo: δουλειά σε worktree, παράδοση με `space-ship.sh deploy` και μετά υποχρεωτικά `npm run deploy` (2026-10-08). Version bump μόνο όταν ζητηθεί. | Κάθε επαληθευμένο κομμάτι: commit στο worktree → rebase → deploy → `live:verify`. |
| 6 | Μείωση 60% των app.ts και App.tsx | Η Warm (2026-10-07), το κλείδωμα instant-UI/cold-pane και το anti-flicker απαιτούν **ρητή έγκριση για κάθε αλλαγή**. Το App.tsx περιέχει Warm κώδικα. | Αποσύνδεση μόνο σε περιοχές εκτός Warm. Ό,τι αγγίζει Warm προτείνεται ως συγκεκριμένο diff για έγκριση. Ο στόχος 60% μένει μετρήσιμος, όχι υποχρεωτικός με κάθε κόστος. |
| 7 | Επανάληψη reviews από εξωτερικά μοντέλα | Απαιτεί λογαριασμούς και UI τρίτων. | Ο agent ετοιμάζει review pack και ουδέτερο prompt. Την εκτέλεση την κάνει ο operator. |
| 8 | Installer VM matrix ως κριτήριο | Αφορά μόνο δημόσιο installer release, που δεν ζητήθηκε. | Μένει ανοιχτό κριτήριο για το επόμενο public release. Δεν μπλοκάρει τα υπόλοιπα. |
| 9 | Required public CI | Το repo δεν έχει CI. | Workflow με τα ντετερμινιστικά suites, ως ξεχωριστό κομμάτι, με ρητή σημείωση ότι χρειάζεται runner και ορατό run URL. |

## 2. Νέα σειρά εκτέλεσης

**A — Ενσωμάτωση (P0).** Merge της δουλειάς του clone στο main. Επίλυση συγκρούσεων με
προτεραιότητα στη νεότερη συμπεριφορά του main: φάκελοι Agent Files, κατάργηση auto-login,
SpaceToggle αντί για checkbox, νέες ρυθμίσεις. Typecheck και στοχευμένα και πλήρη suites
σε σύγκριση με γνωστό baseline. Deploy.

**B — Νέα P0 ασφάλειας.**
- W1 worktree removal (hotfix).
- Δημιουργία φακέλων/`git init` οπουδήποτε από `/api/projects/ensure` και από pane `cwd` χωρίς ρόλο.
- Opt-in στον server για admin/host-root mode του file manager.
- Επανέλεγχος ενεργού περιεχομένου σε artifacts (τύπος MIME που δηλώνει ο client).
- Νέα multipart routes του main μετά τις 03/10.

**C — Παρατηρησιμότητα.**
- `/readyz` → 503 όταν δεν είναι έτοιμο, με πραγματικό ping στη DB.
- Header `x-request-id` στην απάντηση και ενιαίο ID με τα logs.
- Ευρύτερο redaction στα logs, με tests.
- Το test των rate limits να καλύπτει όλα τα route modules.

**D — Execution core.**
- Ανώτατο όριο στο `retryCount` των plans.
- Όριο στην ουρά `pending` του supervisor πριν το continueAsNew.
- Tests για τα activities των turns CLI και OpenCode.
- Fault test με απώλεια σύνδεσης Postgres εν ώρα transaction.

**E — Adapters.**
- Ρητό capability ακριβούς resume ανά runtime.
- Ενημέρωση του πίνακα συμβατότητας με πραγματικές `--version`.

**F — Αποσύνδεση modules.**
- Συνέχεια μόνο σε περιοχές εκτός Warm.
- Μέτρηση στο τρέχον SHA.
- Έλεγχος των domain boundaries στο CI.

**G — Τεκμηρίωση και review pack.**
- Ενημέρωση `review-findings.json` με τα νέα ευρήματα.
- README/claims, πίνακας συμβατότητας, failure matrix.
- Ουδέτερο prompt για επανάληψη των reviews.

Κάθε φάση τελειώνει με commit, deploy και ενημέρωση των steps του ίδιου PLAN.

## 3. Κανόνες που ισχύουν σε όλες τις φάσεις

- Χωρίς αλλαγές σε Warm, terminal anti-flicker, instant-UI/cold-pane ή Harness feed χωρίς νέα ρητή έγκριση.
- Χωρίς restart του `codex-pane-host`. Οι αλλαγές στο cli-host μένουν ανενεργές μέχρι restart που εγκρίνει ο χρήστης.
- Τα αποτυχημένα tests συγκρίνονται με το baseline του main (`preexisting-test-failures-2026-10-10`). Τα timeouts από φόρτο του κοινόχρηστου μηχανήματος ξανατρέχουν και δεν μετρούν ως επιτυχία.
- UI μόνο στα αγγλικά και μόνο με SpaceToggle.

## 4. Κατάσταση στις 2026-10-11

| Φάση | Κατάσταση | Τι έγινε | Τι μένει ανοικτό |
|---|---|---|---|
| A — Ενσωμάτωση | Ολοκληρωμένη (LIVE) | Clone 101 commits + 4 ανανεώσεις από main· προστατευμένος κώδικας main αυτούσιος· deploy `4ad6970748`, live:verify πέρασε | — |
| B — Ασφάλεια | Ολοκληρωμένη (LIVE) | SEC-007 (hotfix), SEC-008, SEC-009 (έγκριση 2026-10-11), SEC-010, server switch `SPACE_FILES_HOST_MODE`· containment/streaming uploads/artifact policy | Authenticated browser proof των διαδρομών αρχείων στο live |
| C — Παρατηρησιμότητα | Ολοκληρωμένη για τα κενά του API | `/livez`, DB στο `/readyz`, `?strict=1`, redaction, rate-limit coverage, request IDs | Metrics/tracing worker και hosts, OpenTelemetry |
| D — Execution core | Μερική | CORE-008· tests turns OpenCode/CLI· CORE-006: read-only replay check, 85/85 live histories χωρίς nondeterminism, negative control 21/21 | Workflows χωρίς retained history· πραγματικό worker-kill proof |
| E — Adapters | Μερική | Δηλώσεις REFERENCE/PROVIDER_SELECTION· inventory 16 runtimes· Qoder resume με `--continue`· admission test argv↔sudoers· `native-resume-matrix.md` | Exact resume για 9 runtimes και DeepSeek: απαιτούν αλλαγές sudoers (root, έγκριση operator)· scheduled canary |
| F — Αποσύνδεση | Μερική | Βήματα 1–3 της πρότασης με έγκριση: App.tsx 11.471 γραμμές (-36,9%)· +5 API domains (app.ts 18.342, -5,9%· το main προσθέτει routes)· ratchet χωρίς νέους κύκλους· ανάλυση AST για το βήμα 4· LIVE `0ff3d53269` | Βήμα 4: τα μπλοκ του App έχουν 10–40 εισόδους· το 60% απαιτεί αλλαγή ιδιοκτησίας state (stores), νέα έγκριση και Warm proof· ομάδες `/api/panes/:id`, `/api/rooms/:id`, `/api/events` |
| G — Τεκμηρίωση | Ολοκληρωμένη για αυτό το στάδιο | Μητρώο 78 ευρημάτων (νέα: PERF-001, Warm p95 ≈1 s στο live· TEST-002, το room-switch proof μπλοκάρεται από την κρυμμένη μπάρα room), review pack, failure matrix, runtime compatibility, README ποιότητας | Επανάληψη ανεξάρτητων reviews (ενέργεια operator) |

Δύο μαθήματα από το deploy, που ισχύουν για όλους τους agents:
- Έλεγχοι πληρότητας του config registry και μοναδικότητας των migrations που τρέχουν σε compile ή migration time μπλοκάρουν τα deploys άλλων agents. Οι έλεγχοι αυτοί ελέγχονται πλέον μόνο από tests.
- Το pipeline απέρριψε σωστά το batch: έκανε rollback και το live έμεινε υγιές, με το pane host και τις CLI συνεδρίες ανέπαφα.

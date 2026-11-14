import { APPOINTMENT_CONTENT_RULE, APPOINTMENT_SCHEDULE_RULE, appointmentContentMissing, appointmentScheduleMissing, type Appointment } from "@space/contracts";
import type { AppointmentsRepository } from "@space/db";
import { SpaceConflictError } from "@space/runtime";

// Operator 4/11 14:39 BKK (nous_msg:a60162597d984866b79b9a2f): whoever writes an appointment (the pane, REST, Nous, a pane's
// space_appointment_add, the Job Copilot) writes everything the operator needs for it. Checked at the repository every writer goes through,
// on the row as it would be stored; DONE and CANCELLED ones (and rows older than the rule) are read and closed as they are.
// Operator 6/11 10:15 BKK (nous_msg:ea6f0792): also its format and timing, and a time we choose (FLEXIBLE) within the operator's hours in their zone.
// Operator 13/11 16:00 BKK: an online one's location is its join link, not text.

type Checked = Pick<Appointment, "status" | "notes" | "location" | "format" | "timing" | "deadlineAt" | "startsAt" | "endsAt">;
type Patch = Partial<{ [key in keyof Checked]: Checked[key] | undefined }>;

function check(next: Checked, zone: string) {
  const notes = appointmentContentMissing(next);
  const schedule = appointmentScheduleMissing(next, zone);
  if (notes.length || schedule.length) {
    const what = [notes.length ? `its notes miss: ${notes.join("; ")}` : "", schedule.length ? `it needs: ${schedule.join("; ")}` : ""].filter(Boolean).join("; and ");
    const rules = [notes.length ? APPOINTMENT_CONTENT_RULE : "", schedule.length ? APPOINTMENT_SCHEDULE_RULE : ""].filter(Boolean).join(" ");
    throw new SpaceConflictError(`Appointment refused, ${what}. Add them and retry. ${rules}`);
  }
}

/** The row as the write would store it: the patch's defined fields over the current one. */
const after = (patch: Patch, current: Checked | null | undefined): Checked => {
  const value = <K extends keyof Checked>(key: K): Checked[K] => (patch[key] === undefined ? current?.[key] ?? null : patch[key]) as Checked[K];
  return { status: value("status") ?? "UPCOMING", notes: value("notes"), location: value("location"), format: value("format"), timing: value("timing"), deadlineAt: value("deadlineAt"),
    startsAt: value("startsAt"), endsAt: value("endsAt") };
};

/** The repository, refusing a write that would leave an UPCOMING appointment without what it requires. `zoneOf`: the owner's working zone. */
export function requireAppointmentContent(repository: AppointmentsRepository, zoneOf: (owner: string) => Promise<string>): AppointmentsRepository {
  return Object.assign(Object.create(repository) as AppointmentsRepository, {
    async create(owner, input, at) {
      check(after({ ...input, status: "UPCOMING" }, null), await zoneOf(owner));
      return repository.create(owner, input, at);
    },
    async update(owner, id, patch, at) {
      const current = await repository.get(owner, id);
      if (current) check(after(patch, current), await zoneOf(owner));
      return repository.update(owner, id, patch, at);
    },
    async upsertBySource(owner, input, at) {
      // The source's appointment of any age keeps its status (an add names none).
      const current = (await repository.list(owner, new Date(0).toISOString())).find((item) => item.sourceRef === input.sourceRef);
      check(after({ ...input, status: current?.status ?? "UPCOMING" }, current), await zoneOf(owner));
      return repository.upsertBySource(owner, input, at);
    }
  } satisfies Pick<AppointmentsRepository, "create" | "update" | "upsertBySource">);
}

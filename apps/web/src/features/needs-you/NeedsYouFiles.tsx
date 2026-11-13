import { useContext, useState } from "react";
import { needsYouFiles, type SpaceNotification } from "@space/contracts";
import { agentFileName } from "../agent-files/agent-files-api.js";
import { AgentFileMentionContext, AgentFileMentions, WORKSPACE_FILE_HREF } from "../terminal-pane/AgentFileLinks.js";
import { AgentFiles } from "../ui-theme/app-icons.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import "./needs-you.css";

interface Chip { href: string; name: string | null; folder: string | null; label: string }

/** A decision's refs.files entry: `artifact:<id>` opens its Agent File (a Media item opens its /file in a new tab), a path is filed in Agent Files on the click. */
const refHref = (ref: string) => ref.startsWith("artifact:") ? `/api/artifacts/${encodeURIComponent(ref)}/download`
  // refs.files paths are relative to the agent workspace (decisionFiles reads them there), not to Nous's own folder.
  : `${WORKSPACE_FILE_HREF}${encodeURIComponent(/^[~/]/.test(ref) ? ref : `~/agent-workspace/${ref}`)}`;

/**
 * nous_msg:0cb8d563 («θελω να βλεπω κατευθειαν το αρχειο»): the Agent Files a card names (`item`) and the files a decision sends (`refs`),
 * each a chip that opens the Agent Files preview; the server's refusal (a secret-looking or private file) shows as the alert line.
 */
export function NeedsYouFiles({ item, refs, fold = false }: { item?: Pick<SpaceNotification, "payload">; refs?: readonly string[]; fold?: boolean }) {
  const links = useContext(AgentFileMentionContext);
  const chips: Chip[] = [
    ...(item ? needsYouFiles(item) : []).map((file) => ({ href: `/api/artifacts/${encodeURIComponent(file.artifactId)}/download`, name: file.name, folder: file.folder, label: file.artifactId })),
    ...(refs ?? []).map((ref) => ({ href: refHref(ref), name: null, folder: null, label: ref }))
  ];
  if (!chips.length) return null;
  // The banner and other places outside a dock have no preview of their own: the chips bring it.
  return links ? <FileChips chips={chips} fold={fold} /> : <AgentFileMentions><FileChips chips={chips} fold={fold} /></AgentFileMentions>;
}

/** fold: a closed card's row says "3 files" past two chips (plan clipboard:T2uboz26Oh3q S8); a click shows every one, nothing is left out. */
function FileChips({ chips, fold }: { chips: Chip[]; fold: boolean }) {
  const links = useContext(AgentFileMentionContext);
  const language = useUiLanguage();
  const title = uiText(language, "Open the Agent Files preview");
  const [all, setAll] = useState(false);
  if (fold && !all && chips.length > 2) {
    return (
      <div className="ny-files">
        <button type="button" className="ny-file" aria-expanded={false} onClick={(event) => { event.stopPropagation(); setAll(true); }}>
          <AgentFiles aria-hidden="true" /><span>{uiText(language, "{count} files", { count: chips.length })}</span>
        </button>
      </div>
    );
  }
  return (
    <div className="ny-files">
      {chips.map((chip) => {
        const known = links?.artifact(chip.href);
        const name = chip.name ?? (known && agentFileName(known)) ?? chip.label.split("/").filter(Boolean).at(-1) ?? chip.label;
        return (
          <button key={chip.href} type="button" className="ny-file" title={`${title}: ${chip.label}`} data-file-ref={chip.label} data-sensitive-masked="manual"
            onClick={(event) => { event.stopPropagation(); links?.openHref(chip.href); }}>
            <AgentFiles aria-hidden="true" /><span>{name}</span>{chip.folder ? <small>{chip.folder}</small> : null}
          </button>
        );
      })}
    </div>
  );
}

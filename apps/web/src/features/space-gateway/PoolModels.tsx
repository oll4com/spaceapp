import { gatewayPoolModelFree, type GatewayPoolModels } from "@space/contracts";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import "./pool-models.css";

/**
 * A key pool's supported models as Space Gateway listed them (the Gateway accounts view and Nous › Startup programs): opened by a click.
 * Free comes from `gatewayPoolModelFree` (OpenRouter's `:free` ids, the free lists of Z.AI and SiliconFlow, OVH's anonymous access); where a pool
 * has a free model its other ids are paid. shortcut: other pools stay untagged, tag them once /models reports prices.
 */
export function PoolModels({ entry }: { entry: GatewayPoolModels["data"][number] | undefined }) {
  const language = useUiLanguage();
  if (!entry) return null;
  if (!entry.models) return <p className="space-gateway-note gw-pool-models">{uiText(language, "Supported models")}: {entry.error}</p>;
  const isFree = (id: string) => gatewayPoolModelFree(entry.provider, id) === true;
  const free = entry.models.filter(isFree);
  const paid = free.length ? entry.models.filter((id) => !isFree(id)) : [];
  return (
    <details className="gw-pool-models">
      <summary>{free.length
        ? uiText(language, "Supported models ({count}, {free} free)", { count: entry.models.length, free: free.length })
        : uiText(language, "Supported models ({count})", { count: entry.models.length })}</summary>
      <ul>
        {free.length ? [...free, ...paid].map((id) => (
          <li key={id}><code>{id}</code> <span className={isFree(id) ? "gw-model-free" : "gw-model-paid"}>{uiText(language, isFree(id) ? "free" : "paid")}</span></li>
        )) : entry.models.map((id) => <li key={id}><code>{id}</code></li>)}
      </ul>
    </details>
  );
}

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { CliAccountProfile } from "@space/contracts";
import { shouldPreserveForSnipTool } from "../snip-tool/snip-guard.js";
import {
  antigravityAccountLacksGroup,
  antigravityGroupLabel,
  antigravityModelGroup,
  antigravityQuotaGroups,
  cliAccountAvailability,
  cliAccountPlan,
  cliAccountPool,
  cliAccountForecasts,
  cliAccountForecastTitle,
  type CliAccountAvailability,
  type CliAccountMenuRuntimeId,
} from "./cli-account-availability.js";
import { accountColorStyle, CliAccountAvatar, CliAccountColorLegend, CliAccountMeter } from "./CliAccountVisuals.js";
import { useCliAccountBalance } from "./cli-account-balance.js";
import { useCliAccountSignals } from "./use-cli-account-signals.js";
import { useOptionalVoiceInput } from "../voice-input/VoiceInputProvider.js";

interface CliAccountPickerProps {
  runtimeId: CliAccountMenuRuntimeId;
  // "Google", "Claude", "GitHub", "Cursor" or "ChatGPT": names the trigger and the menu.
  providerLabel: string;
  icon: ReactNode;
  paneTitle: string;
  profiles: Array<Pick<CliAccountProfile, "profileId" | "displayName">>;
  selectedProfileId: string;
  disabled?: boolean;
  onSelect: (profileId: string) => void;
  // The pane's active model; Antigravity judges each account by that model group's quota.
  modelId?: string | null;
  // Session-level balancing: Auto starts the pane on the account with the most room and moves it on when that
  // account runs out. Present for CLIs Space balances.
  auto?: { active: boolean; onSelect: () => void };
}

// An email-like name breaks before its domain rather than in the middle of a word.
function breakableName(name: string): ReactNode {
  const at = name.indexOf("@");
  return at > 0 ? <>{name.slice(0, at)}<wbr />{name.slice(at)}</> : name;
}

const minimumMenuHeightPx = 150;
// Space between the menu and the pane's left edge when the pane is narrower than the menu.
const menuEdgeGapPx = 8;

// Settings → CLI pane controls → Account picker hides the button; hidden, the menu never mounts or polls quota.
export function CliAccountPicker(props: CliAccountPickerProps) {
  return useOptionalVoiceInput()?.settings.terminalAccountPicker === false ? null : <AccountPickerMenu {...props} />;
}

// One click on the trigger lists every account of this CLI with its availability; one
// more click switches the pane. The active account is marked in the list and named in the tooltip.
function AccountPickerMenu({
  runtimeId,
  providerLabel,
  icon,
  paneTitle,
  profiles,
  selectedProfileId,
  disabled = false,
  onSelect,
  modelId = null,
  auto,
}: CliAccountPickerProps) {
  const [open, setOpen] = useState(false);
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | null>(null);
  const [menuMaxWidth, setMenuMaxWidth] = useState<number | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const { quota, identities, load: loadSignals } = useCliAccountSignals();
  // CLIs Space balances (those offering Auto) report each account's quota and Auto's next pick through the balance.
  const { balance, load: loadBalance } = useCliAccountBalance(auto ? runtimeId : null);
  const load = (options?: Parameters<typeof loadSignals>[0]) => {
    loadSignals(options);
    loadBalance();
  };
  const menuId = useId();
  const label = `${providerLabel} account for ${paneTitle}`;

  const clock = open ? Date.now() : Math.floor(Date.now() / 60_000) * 60_000;
  // Antigravity: one tab per quota group Google reports (Gemini, Claude · GPT, Gemini 4 Argon, ...), the pane's model's group first.
  const groupOptions = useMemo(() => (runtimeId === "cli:gemini" ? antigravityQuotaGroups(quota?.agy) : []), [quota, runtimeId]);
  const [chosenGroup, setChosenGroup] = useState<string | null>(null);
  const paneGroup = runtimeId === "cli:gemini" ? antigravityModelGroup(modelId, groupOptions) : null;
  // A pane group Google does not report stays chosen, so the header says Google reported nothing for it (31/10).
  const modelGroup = groupOptions.some((option) => option.id === chosenGroup) ? chosenGroup : paneGroup ?? groupOptions[0]?.id ?? null;
  const rows = useMemo(() => profiles.map((profile) => {
    const identity = identities?.find((candidate) => candidate.runtimeId === runtimeId && candidate.profileId === profile.profileId) ?? null;
    return {
      profile,
      email: identity?.email ?? null,
      login: identity?.login ?? null,
      plan: cliAccountPlan(runtimeId, profile.profileId, quota, balance),
      availability: cliAccountAvailability({ runtimeId, profileId: profile.profileId, quota, identity, clock, modelGroup, balance }),
    };
  }), [balance, clock, identities, modelGroup, profiles, quota, runtimeId]);
  // Codex: the ChatGPT accounts Space Gateway picks from, listed for their quota; they cannot be chosen one by one.
  const pool = useMemo(() => cliAccountPool(runtimeId, quota, clock), [clock, quota, runtimeId]);
  const forecasts = useMemo(() => (open ? cliAccountForecasts(runtimeId, quota, clock, modelGroup, balance) : []), [balance, clock, modelGroup, open, quota, runtimeId]);
  // An account Google lists without the chosen group (a Free account has no Gemini 4 Argon) is left out of that group's view;
  // a group no account reports hides no one.
  const hiddenWithout = groupOptions.some((option) => option.id === modelGroup) ? modelGroup : null;
  const shown = useMemo(() => rows.filter((row) => !antigravityAccountLacksGroup(quota, row.profile.profileId, hiddenWithout)), [hiddenWithout, quota, rows]);
  const activeRow = shown.findIndex((row) => row.profile.profileId === selectedProfileId);
  const active = rows.find((row) => row.profile.profileId === selectedProfileId) ?? rows[0];
  // The Auto entry, when offered, comes first in the menu; item refs and keyboard moves count it.
  const offset = auto ? 1 : 0;
  const itemCount = shown.length + offset;
  const activeIndex = auto?.active ? 0 : activeRow < 0 ? -1 : activeRow + offset;
  const focusIndex = Math.max(0, activeIndex);
  const readyCount = shown.filter((row) => row.availability.tone === "ready" || row.availability.tone === "neutral").length;
  const autoNext = auto && balance?.runtimeId === runtimeId ? rows.find((row) => row.profile.profileId === balance.next) ?? null : null;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (shouldPreserveForSnipTool(event)) return;
      const target = event.target;
      if (target instanceof Node && pickerRef.current?.contains(target)) return;
      setOpen(false);
    };
    // Escape closes this menu before any pane or app shortcut sees it.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => itemRefs.current[focusIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
    // Focus moves to the active account only when the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Each opening starts on the pane's model's group.
  useEffect(() => {
    if (!open) setChosenGroup(null);
  }, [open]);

  function openMenu() {
    // Codex signs in through Space Gateway only, so it has no profile identities to fetch.
    const missingIdentity = runtimeId !== "cli:codex" && profiles.some((profile) => !identities?.some((candidate) =>
      candidate.runtimeId === runtimeId && candidate.profileId === profile.profileId));
    load({ forceIdentities: missingIdentity });
    // The list may use the pane's height below the trigger, never less than a few rows, and the menu
    // narrows to the pane's width so a small pane or screen still shows it whole.
    const container = pickerRef.current?.offsetParent;
    const trigger = triggerRef.current;
    if (container instanceof HTMLElement && trigger) {
      const containerRect = container.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const available = containerRect.bottom - triggerRect.bottom - 14;
      setMenuMaxHeight(Number.isFinite(available) && available > 0 ? Math.max(minimumMenuHeightPx, Math.round(available)) : null);
      const width = triggerRect.right - Math.max(containerRect.left, 0) - menuEdgeGapPx;
      setMenuMaxWidth(Number.isFinite(width) && width > 0 ? Math.round(width) : null);
    }
    setOpen(true);
  }

  function closeMenu(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  // While the pane starts or reattaches its CLI the menu stays open to read (stable 31/10: a phone's Codex menu shut itself
  // as the pane attached); only the switch waits.
  function choose(profileId: string) {
    if (disabled) return;
    closeMenu(true);
    if (profileId !== selectedProfileId) onSelect(profileId);
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const focusedIndex = itemRefs.current.findIndex((item) => item === document.activeElement);
    const move = (index: number) => {
      event.preventDefault();
      itemRefs.current[(index + itemCount) % itemCount]?.focus();
    };
    switch (event.key) {
      case "ArrowDown": move(focusedIndex < 0 ? focusIndex : focusedIndex + 1); break;
      case "ArrowUp": move(focusedIndex < 0 ? focusIndex : focusedIndex - 1); break;
      case "ArrowLeft":
      case "ArrowRight": {
        if (groupOptions.length < 2) break;
        event.preventDefault();
        const at = groupOptions.findIndex((option) => option.id === modelGroup) + (event.key === "ArrowRight" ? 1 : -1);
        setChosenGroup(groupOptions[(at + groupOptions.length) % groupOptions.length]!.id);
        break;
      }
      case "Home": move(0); break;
      case "End": move(itemCount - 1); break;
      case "Tab":
        closeMenu(false);
        break;
      default:
        break;
    }
  }

  const triggerAvailability: CliAccountAvailability | undefined = active?.availability;
  const activeName = `${auto?.active ? "Auto, now " : ""}${active?.profile.displayName ?? "Select account"}`;

  function chooseAuto() {
    if (disabled) return;
    closeMenu(true);
    if (!auto?.active) auto?.onSelect();
  }

  return (
    <div ref={pickerRef} className="terminal-gemini-account-picker cli-account-picker" data-runtime-id={runtimeId}>
      <button
        ref={triggerRef}
        type="button"
        className={`terminal-gemini-account-trigger${open ? " is-open" : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={`${providerLabel} account: ${activeName}${triggerAvailability ? ` · ${triggerAvailability.description}` : ""}`}
        disabled={disabled}
        onPointerEnter={() => load()}
        onFocus={() => load()}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={(event) => {
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        {icon}
      </button>
      {open ? (
        <div
          id={menuId}
          className="terminal-gemini-account-popover cli-account-menu"
          role="menu"
          aria-label={label}
          style={menuMaxWidth ? { maxWidth: `${menuMaxWidth}px` } : undefined}
          onKeyDown={handleMenuKeyDown}
        >
          <div className="cli-account-menu-head">
            <span className="cli-account-menu-icon" aria-hidden="true">{icon}</span>
            <span className="cli-account-menu-title">
              <strong>{providerLabel} account</strong>
              <small>
                {pool ? "Space Gateway picks the account" : `${readyCount} of ${shown.length} available now`}
                {modelGroup ? ` · ${groupOptions.find((option) => option.id === modelGroup)?.label ?? antigravityGroupLabel(modelGroup)} quota` : ""}
              </small>
            </span>
            {forecasts.map((forecast) => (
              <span
                key={forecast.scope ?? "all"}
                className="cli-account-menu-forecast"
                data-known={forecast.percent !== null}
                data-checking={forecast.checking === true}
                style={{ color: forecast.color }}
                title={cliAccountForecastTitle(forecast)}
              >
                <strong>{forecast.checking ? "Checking…" : forecast.percent === null ? "Unknown" : `${Math.round(forecast.now ?? 0)}% now`}</strong>
                <small>{forecast.scope ? `${forecast.scope} ` : ""}{forecast.percent === null ? "" : `${Math.round(forecast.percent)}% `}free {forecast.resetWhen}{forecast.credits ? ` · ${forecast.credits}` : ""}</small>
              </span>
            ))}
          </div>
          {groupOptions.length > 1 ? (
            <div className="cli-account-menu-groups" role="group" aria-label="Quota group">
              {groupOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.id === modelGroup}
                  className="cli-account-menu-group"
                  tabIndex={-1}
                  onClick={() => setChosenGroup(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="cli-account-menu-list" style={menuMaxHeight ? { maxHeight: `${menuMaxHeight - (groupOptions.length > 1 ? 112 : 82)}px` } : undefined}>
            {auto ? (
              <button
                ref={(element) => {
                  itemRefs.current[0] = element;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={auto.active}
                className={`cli-account-menu-item cli-account-auto-item${auto.active ? " is-active" : ""}`}
                data-tone="neutral"
                title="Space starts this pane on the account with the most room and moves it to another account when this one runs out"
                tabIndex={auto.active ? 0 : -1}
                aria-disabled={disabled || undefined}
                onClick={chooseAuto}
              >
                <span className="cli-account-auto-mark" aria-hidden="true">A</span>
                <span className="cli-account-menu-item-main">
                  <span className="cli-account-menu-item-name">
                    <strong>Auto (Space Gateway)</strong>
                    {auto.active ? <span className="cli-account-active-pill">Active</span> : null}
                  </span>
                  <small className="cli-account-menu-item-detail">
                    {auto.active && active
                      ? `Now on ${active.profile.displayName}; moves on when it runs out`
                      : autoNext
                        ? `Would start on ${autoNext.profile.displayName}, the most room; moves on when it runs out`
                        : "Most room first; moves on when an account runs out"}
                  </small>
                </span>
              </button>
            ) : null}
            {shown.map((row, rowIndex) => {
              const index = rowIndex + offset;
              const isActive = index === activeIndex;
              const inUse = (Boolean(auto?.active) && rowIndex === activeRow)
                || (selectedProfileId === "space-gateway" && row.availability.gatewayInUse === true);
              return (
                <button
                  key={row.profile.profileId}
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  className={`cli-account-menu-item${isActive ? " is-active" : ""}`}
                  data-tone={row.availability.tone}
                  style={accountColorStyle(row.availability)}
                  title={`${row.profile.displayName}${row.email ? ` · ${row.email}` : row.login ? ` · @${row.login}` : ""} · ${row.availability.description}`}
                  tabIndex={isActive ? 0 : -1}
                  aria-disabled={disabled || undefined}
                  onClick={() => choose(row.profile.profileId)}
                >
                  <CliAccountAvatar name={row.profile.displayName} availability={row.availability} active={isActive} />
                  <span className="cli-account-menu-item-main">
                    <span className="cli-account-menu-item-name">
                      <strong>{breakableName(row.profile.displayName)}</strong>
                      {row.plan ? <span className="cli-account-plan-badge" title={`Plan: ${row.plan}`}>{row.plan}</span> : null}
                      {isActive ? <span className="cli-account-active-pill">Active</span> : null}
                      {inUse ? <span className="cli-account-active-pill">In use</span> : null}
                    </span>
                    <small className="cli-account-menu-item-detail" data-sensitive-masked={row.email || row.login ? "manual" : undefined}>
                      {row.email ?? (row.login ? `@${row.login}` : row.availability.detail ?? row.availability.description)}
                    </small>
                    <CliAccountMeter availability={row.availability} />
                  </span>
                  <span className="cli-account-menu-item-status">{row.availability.label}</span>
                </button>
              );
            })}
            {pool?.length ? (
              <div className="cli-account-pool" role="group" aria-label="Accounts Space Gateway picks from">
                <span className="cli-account-pool-title" aria-hidden="true">Pooled accounts</span>
                {pool.map((member) => (
                  <div
                    key={member.id}
                    role="menuitem"
                    aria-disabled="true"
                    className="cli-account-menu-item is-pooled"
                    data-tone={member.availability.tone}
                    style={accountColorStyle(member.availability)}
                    title={`${member.name} · ${member.availability.description}`}
                  >
                    <CliAccountAvatar name={member.name} availability={member.availability} />
                    <span className="cli-account-menu-item-main">
                      <span className="cli-account-menu-item-name">
                        <strong data-sensitive-masked={member.name.includes("@") ? "manual" : undefined}>{breakableName(member.name)}</strong>
                        {member.plan ? <span className="cli-account-plan-badge" title={`Plan: ${member.plan}`}>{member.plan}</span> : null}
                      </span>
                      {member.availability.detail ? <small className="cli-account-menu-item-detail">{member.availability.detail}</small> : null}
                      <CliAccountMeter availability={member.availability} />
                    </span>
                    <span className="cli-account-menu-item-status">{member.availability.label}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="cli-account-menu-foot">
            <CliAccountColorLegend />
          </div>
        </div>
      ) : null}
    </div>
  );
}

import { useRef, useState } from "react";
import type { AgentPaneSession, AuthMe, Pane, Provider, ProviderSettings } from "@space/contracts";
import { api } from "../../api.js";
import { RecoverableSurface } from "../SurfaceErrorBoundary.js";
import { DockFullscreenButton, DockNotice, useDockFullscreen } from "../dock-kit/DockKit.js";
import { useWorkspaceSurface } from "../ui-theme/WorkspaceSurface.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import {
  Activity,
  ArrowUpDown,
  Bell,
  Bot, Mail,
  Clock3,
  Compass,
  GitBranch,
  Grid2X2,
  Hash,
  Film,
  Keyboard,
  Mic,
  Nous,
  Palette,
  PanelLeft,
  PanelsTopLeft,
  Plug,
  Rocket,
  Handshake,
  PenTool,
  TabletSmartphone,
  ShieldHalf,
  Search,
  ServerCog,
  Sparkles,
  Users,
  Youtube
} from "../ui-theme/app-icons.js";
import { VoiceSettingsCard } from "../voice-input/VoiceSettingsCard.js";
import { YouTubeSettingsCard } from "../browser-pane/YouTubeSummarySettingsCard.js";
import { RoomLimitSettingsCard } from "../rooms-dock/RoomLimitSettingsCard.js";
import type { ModernAppearance, ModernIconPack, UiBackground, UiTheme } from "../../ui-theme.js";
import { SettingsDisclosure, SettingsGroup, SettingsSearchable, SettingsSections } from "./SettingsDisclosure.js";
import type { EnvironmentPresetCard } from "./EnvironmentPresetCard.js";
import type { GoogleAccountSettingsCard } from "../auth/GoogleAccountSettingsCard.js";
import type { UiThemeSettingsCard } from "../ui-theme/UiThemeSettingsCard.js";
import type { DocksSettingsCard } from "./DocksSettingsCard.js";
import type { PanesSettingsCard } from "./PanesSettingsCard.js";
import type { WidgetsSettingsCard } from "./WidgetsSettingsCard.js";
import type { DateTimeSettingsCard } from "../date-time-settings/DateTimeSettingsCard.js";
import type { AppDiagnosticsSettingsCard } from "../app-diagnostics/AppDiagnosticsSettingsCard.js";
import type { ReleasesSettingsCard } from "../releases/ReleasesSettingsCard.js";
import type { SourceControlPublishingCard } from "../source-control-publishing/SourceControlPublishingCard.js";
import type { TelegramIntegrationCard } from "../telegram-integration/TelegramIntegrationCard.js";
import type { PluginsSettingsCard } from "../plugins/PluginsSettingsCard.js";
import type { AgentCapabilitiesCard } from "../agent-tools/AgentCapabilitiesCard.js";
import type { KeyboardAutocorrectSettingsCard } from "../keyboard-autocorrect/KeyboardAutocorrectSettingsCard.js";
import type { PromptVariablesSettingsCard } from "../prompt-variables/PromptVariablesSettingsCard.js";
import type { ConfigurationMigrationCard } from "./ConfigurationMigrationCard.js";
import type { DotSettingsRequest, DotsSettingsCard } from "../agent-pane/DotsSettingsCard.js";
import type { JobCopilotSettingsCard } from "../job-apply-pane/JobCopilotSettingsCard.js";
import type { MailCopilotSettingsCard } from "../mail-copilot-pane/MailCopilotSettingsCard.js";
import type { MarketingCopilotSettingsCard } from "../marketing-copilot-pane/MarketingCopilotSettingsCard.js";
import type { FreelanceCopilotSettingsCard } from "../freelance-copilot-pane/FreelanceCopilotSettingsCard.js";
import type { DesignSettingsCard } from "../design-pane/DesignSettingsCard.js";
import type { AppStudioSettingsCard } from "../app-studio-pane/AppStudioSettingsCard.js";
import type { VideoSettingsCard } from "../video-pane/VideoSettingsCard.js";
import type { SecurityCopilotSettingsCard } from "../security-copilot-pane/SecurityCopilotSettingsCard.js";
import { NotificationSettingsCard } from "../notifications/NotificationSettingsCard.js";
import { NousSettingsCard } from "../nous/NousSettingsCard.js";

// The Settings dock (and the Workspace "Advanced settings" page): a search field, then
// sections grouped by what they change, each with plain-language help.

/** The settings cards the dock renders; App declares them with lazyWithPreload. */
export interface AgentSettingsCards {
  EnvironmentPreset: typeof EnvironmentPresetCard;
  GoogleAccount: typeof GoogleAccountSettingsCard;
  UiTheme: typeof UiThemeSettingsCard;
  Docks: typeof DocksSettingsCard;
  Panes: typeof PanesSettingsCard;
  Widgets: typeof WidgetsSettingsCard;
  DateTime: typeof DateTimeSettingsCard;
  AppDiagnostics: typeof AppDiagnosticsSettingsCard;
  Releases: typeof ReleasesSettingsCard;
  SourceControlPublishing: typeof SourceControlPublishingCard;
  TelegramIntegration: typeof TelegramIntegrationCard;
  Plugins: typeof PluginsSettingsCard;
  AgentCapabilities: typeof AgentCapabilitiesCard;
  KeyboardAutocorrect: typeof KeyboardAutocorrectSettingsCard;
  PromptVariables: typeof PromptVariablesSettingsCard;
  ConfigurationMigration: typeof ConfigurationMigrationCard;
  Dots: typeof DotsSettingsCard;
  JobCopilot: typeof JobCopilotSettingsCard;
  MailCopilot: typeof MailCopilotSettingsCard;
  MarketingCopilot: typeof MarketingCopilotSettingsCard;
  FreelanceCopilot: typeof FreelanceCopilotSettingsCard;
  Design: typeof DesignSettingsCard;
  AppStudio: typeof AppStudioSettingsCard;
  Video: typeof VideoSettingsCard;
  SecurityCopilot: typeof SecurityCopilotSettingsCard;
}

export const settingsCardLoadingFallback = <div className="empty-mini" role="status">Loading settings…</div>;

const AGENT_PANE_SETTINGS_EVENT = "space:agent-pane-settings-updated";

/** The groups in page order; fullscreen lists them for quick jumps. */
const settingsGroups = [
  { key: "workspace", title: "Workspace" },
  { key: "personal", title: "Personal" },
  { key: "assistants", title: "Assistants & AI" },
  { key: "connections", title: "Accounts & connections" },
  { key: "maintenance", title: "Maintenance" }
] as const;

function dispatchAgentPaneSettingsUpdated(paneId: string | null, session?: AgentPaneSession) {
  window.dispatchEvent(new CustomEvent(AGENT_PANE_SETTINGS_EVENT, { detail: { paneId, session } }));
}

function providerRouteLabel(provider: Provider): string {
  return [provider.routeProfile ?? "custom", provider.backingProviderId ?? provider.type.toLowerCase()].join(" / ");
}

export function AgentSettingsDock({
  cards,
  adminMode,
  onOpenSetup,
  activePane: _activePane,
  canManageCliRuntimes,
  canManageDiagnostics,
  canManageSourceControl,
  canManageTelegram,
  currentAppearance,
  currentBackground = "spaceapp",
  currentIconPack,
  currentUiTheme,
  currentGlassTint,
  onGlassTintChange,
  isCodexEnabled,
  isHarnessEnabled = true,
  suppressNotifications,
  providerSettings,
  providers,
  gitPluginsActive,
  onUiThemeApply,
  onSuppressNotificationsChange,
  onProviderSettingsRefresh,
  auth,
  onAuthRefresh,
  roomId = null,
  dotSettingsRequest = null
}: {
  /** The lazily loaded settings cards (declared, and preloaded at idle, by App). */
  cards: AgentSettingsCards;
  adminMode: boolean;
  onOpenSetup: () => void;
  activePane?: Pane | null;
  canManageCliRuntimes: boolean;
  canManageDiagnostics: boolean;
  canManageSourceControl: boolean;
  canManageTelegram: boolean;
  currentAppearance: ModernAppearance;
  currentBackground?: UiBackground;
  currentIconPack: ModernIconPack;
  currentUiTheme: UiTheme;
  currentGlassTint?: number;
  onGlassTintChange?: (tint: number) => void;
  isCodexEnabled: boolean;
  isHarnessEnabled?: boolean;
  suppressNotifications: boolean;
  providerSettings: ProviderSettings | null;
  providers: Provider[];
  gitPluginsActive?: boolean;
  onUiThemeApply: (selection: { appearance: ModernAppearance; background: UiBackground; iconPack: ModernIconPack; theme: UiTheme }) => void;
  onSuppressNotificationsChange: (suppressed: boolean) => void;
  onProviderSettingsRefresh: (settings: ProviderSettings) => void;
  auth?: AuthMe | null;
  onAuthRefresh?: () => Promise<void>;
  /** The current room: Dot memory, tools and evaluation runs there. */
  roomId?: string | null;
  /** Opens Settings → Dots at a Dot and section (from a Dot pane). */
  dotSettingsRequest?: DotSettingsRequest | null;
}) {
  const {
    EnvironmentPreset: LazyEnvironmentPresetCard,
    GoogleAccount: LazyGoogleAccountSettingsCard,
    UiTheme: LazyUiThemeSettingsCard,
    Docks: LazyDocksSettingsCard,
    Panes: LazyPanesSettingsCard,
    Widgets: LazyWidgetsSettingsCard,
    DateTime: LazyDateTimeSettingsCard,
    AppDiagnostics: LazyAppDiagnosticsSettingsCard,
    Releases: LazyReleasesSettingsCard,
    SourceControlPublishing: LazySourceControlPublishingCard,
    TelegramIntegration: LazyTelegramIntegrationCard,
    Plugins: LazyPluginsSettingsCard,
    AgentCapabilities: LazyAgentCapabilitiesCard,
    KeyboardAutocorrect: LazyKeyboardAutocorrectSettingsCard,
    PromptVariables: LazyPromptVariablesSettingsCard,
    ConfigurationMigration: LazyConfigurationMigrationCard,
    Dots: LazyDotsSettingsCard,
    JobCopilot: LazyJobCopilotSettingsCard,
    MailCopilot: LazyMailCopilotSettingsCard,
    MarketingCopilot: LazyMarketingCopilotSettingsCard,
    FreelanceCopilot: LazyFreelanceCopilotSettingsCard,
    Design: LazyDesignSettingsCard,
    AppStudio: LazyAppStudioSettingsCard,
    Video: LazyVideoSettingsCard,
    SecurityCopilot: LazySecurityCopilotSettingsCard
  } = cards;
  const [providerPending, setProviderPending] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [isFullscreen, setIsFullscreen] = useDockFullscreen();
  // The Workspace menu shows docks in place, so fullscreen is offered only in the dock itself.
  const inWorkspaceMenu = useWorkspaceSurface();
  const dockRef = useRef<HTMLDivElement>(null);

  const defaultProvider = providers.find((provider) => provider.id === providerSettings?.defaultProviderId) ?? null;

  async function selectDefaultProvider(providerId: string) {
    if (!isCodexEnabled || !providerId || providerId === providerSettings?.defaultProviderId) return;
    setProviderPending(true);
    setProviderError(null);
    try {
      const updated = await api.updateProviderSettings({ defaultProviderId: providerId });
      onProviderSettingsRefresh(updated);
      dispatchAgentPaneSettingsUpdated(null);
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : "Default provider update failed");
    } finally {
      setProviderPending(false);
    }
  }

  const isAdmin = auth?.user?.role === "ADMIN";
  const canManageInstallation = isAdmin || auth?.user?.role === "OPERATOR";

  return (
    <div ref={dockRef} className={`dock-panel agent-settings-dock basic-settings-dock${isFullscreen ? " is-fullscreen" : ""}`}
      data-searching={query.trim() ? "true" : undefined} role={isFullscreen ? "dialog" : undefined}
      aria-modal={isFullscreen || undefined} aria-label={isFullscreen ? "Settings" : undefined}>
      {/* The shell header already names this dock (Settings or Advanced settings); fullscreen covers it. */}
      <SettingsSections request={dotSettingsRequest ? { key: "dots", nonce: dotSettingsRequest.nonce } : null} query={query} revealOnOpen>
      <div className="settings-dock-toolbar">
        {isFullscreen ? <h2 className="settings-dock-fullscreen-title">Settings</h2> : null}
        <div className="settings-search">
          <Search aria-hidden="true" />
          <input type="search" name="settings-search" aria-label="Search settings" placeholder="Search settings"
            value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} />
        </div>
        {inWorkspaceMenu ? null : <DockFullscreenButton name="settings" active={isFullscreen} onToggle={() => setIsFullscreen((value) => !value)} />}
      </div>
      {isFullscreen ? (
        <nav className="settings-dock-nav" aria-label="Settings groups">
          {settingsGroups.map((group) => (
            <button key={group.key} type="button" onClick={() => {
              dockRef.current?.querySelector(`[data-settings-group="${group.key}"]`)?.scrollIntoView?.({ block: "start" });
            }}>{group.title}</button>
          ))}
        </nav>
      ) : null}
      <div className="settings-dock-body">
      <div className="settings-search-empty" role="status">No settings match “{query.trim()}”. Try another word.</div>

      <SettingsGroup groupKey="workspace" title="Workspace" description="What you see in your rooms.">
        <SettingsSearchable keywords="workspace environment custom max everything all tools docks panes widgets clis">
          <RecoverableSurface fallback={settingsCardLoadingFallback}>
            <LazyEnvironmentPresetCard
              isAdmin={isAdmin}
              canManageCliRuntimes={canManageCliRuntimes}
              userId={auth?.user?.id}
            />
          </RecoverableSurface>
        </SettingsSearchable>

        <SettingsDisclosure sectionKey="rooms" title="Rooms" description="How many rooms you can open." scope="Your account" icon={PanelLeft}
          help="Choose how many rooms you can open (6 unless you change it). Test rooms that agents open for their checks never count, and agents must delete them when their task ends."
          keywords="rooms room limit maximum how many test rooms agent proof">
          <RoomLimitSettingsCard />
        </SettingsDisclosure>

        <SettingsDisclosure title="Docks" description="Side panels in your menu and toolbar." scope="Your account" icon={Grid2X2}
          help="Docks are the side panels, such as Files, Clipboard or Source Control. Turn off the ones you never use to keep your menu short. Nothing is deleted, and you can turn them back on at any time."
          keywords="side panel menu toolbar files clipboard source control">
          <RecoverableSurface fallback={settingsCardLoadingFallback}>
            <LazyDocksSettingsCard
              gitPluginsActive={gitPluginsActive}
              isAdmin={isAdmin}
            />
          </RecoverableSurface>
        </SettingsDisclosure>

        <SettingsDisclosure title="Panes" description="Tools you can add to a room." scope="Your account" icon={PanelsTopLeft}
          help="Panes are the windows inside a room, such as Browser, Notes or YouTube (AI coding tools are managed in the CLI dock). Turn off the ones you don't need and they leave the Add menu."
          keywords="add menu window browser notes youtube room">
          <RecoverableSurface fallback={settingsCardLoadingFallback}>
            <LazyPanesSettingsCard
              isHarnessEnabled={isHarnessEnabled}
            />
          </RecoverableSurface>
        </SettingsDisclosure>

        <SettingsDisclosure title="Widgets" description="Small floating tools on your desktop." scope="Your account" icon={Sparkles}
          help="Widgets are small tools that float over your workspace, such as a clock or AI usage meters. Turn one on to show it and off to hide it."
          keywords="floating clock quota usage desktop">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyWidgetsSettingsCard /></RecoverableSurface>
        </SettingsDisclosure>
      </SettingsGroup>

      <SettingsGroup groupKey="personal" title="Personal" description="Only you see these changes.">
        <SettingsDisclosure title="Appearance" description="Theme, light or dark colors, icons and background." scope="Your account" icon={Palette}
          help="Change how Space looks. Your choice is saved to your account, so every device you sign in on looks the same. Space reloads once to apply it."
          keywords="theme dark light mode colors icons background look">
          <RecoverableSurface fallback={settingsCardLoadingFallback}>
            <LazyUiThemeSettingsCard
              currentAppearance={currentAppearance}
              currentBackground={currentBackground}
              currentIconPack={currentIconPack}
              currentTheme={currentUiTheme}
              currentGlassTint={currentGlassTint}
              onGlassTintChange={onGlassTintChange}
              onChange={onUiThemeApply}
            />
          </RecoverableSurface>
        </SettingsDisclosure>

        <SettingsDisclosure title="Date & time" description="Time zone and how dates and times are shown." scope="Your account" icon={Clock3}
          help="Choose your time zone and whether times use a 24-hour or AM/PM clock. Every date and time in Space follows this."
          keywords="clock timezone utc 24-hour format">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyDateTimeSettingsCard userId={auth?.user?.id} /></RecoverableSurface>
        </SettingsDisclosure>

        <SettingsDisclosure title="Notifications" description="Pop-ups, sounds, desktop and Telegram for every pane." scope="Your account" icon={Bell}
          help="Notifications tell you when mail arrives, a copilot needs you, or something finishes. Choose the channels (pop-up toasts, sound, desktop notifications in this browser, Telegram) and turn a source down on its own; turning notifications off hides the pop-ups only, the Notification Center still collects them."
          keywords="toast alerts messages notices quiet silence desktop telegram sound mail copilot notification center">
          <RecoverableSurface fallback={settingsCardLoadingFallback}>
            <NotificationSettingsCard suppressNotifications={suppressNotifications} onSuppressNotificationsChange={onSuppressNotificationsChange} />
          </RecoverableSurface>
        </SettingsDisclosure>

        <SettingsDisclosure title="Voice input" description="Talk instead of typing." scope="Your account" icon={Mic}
          help="Speak your prompts instead of typing them. Turn the microphone on, then choose the language and whether your words are added to the text or replace it."
          keywords="microphone speech dictation talk transcription language">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><VoiceSettingsCard /></RecoverableSurface>
        </SettingsDisclosure>

        <SettingsDisclosure title="Keyboard autocorrection" description="Fix text typed in the wrong keyboard language." scope="Your account" icon={Keyboard}
          help="If you type with the wrong keyboard language active (for example Greek letters when you meant English), Space notices it. Press Alt+G to convert the text."
          keywords="layout greek english alt+g typing language">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyKeyboardAutocorrectSettingsCard /></RecoverableSurface>
        </SettingsDisclosure>

        <SettingsDisclosure title="Prompt variables" description="Short #names for text you reuse." scope="Your account" icon={Hash}
          help="Save text you use often under a short #name. Type #name in a prompt and Space puts the full text in its place when you send it."
          keywords="snippets shortcuts hashtag expansion reuse">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyPromptVariablesSettingsCard /></RecoverableSurface>
        </SettingsDisclosure>
      </SettingsGroup>

      <SettingsGroup groupKey="assistants" title="Assistants & AI" description="How your AI helpers and agents work.">
        {canManageInstallation ? <SettingsDisclosure sectionKey="nous" title="Nous" description="The mind of SpaceApp: work on your behalf, promote and approve Warm changes." scope="Your account" icon={Nous}
          help="Work on my behalf turns Nous on: it answers panes and copilots in every room and brings you only releases, irreversible actions, third parties and direction. The next two let it promote dev to stable and approve Warm changes without asking you; the last one, on this device, lets it bring you to a pane that needs you. The Nous dock shows the same switches."
          keywords="nous mind work on my behalf promote dev stable warm approve autonomy focus bring me panes">
          <NousSettingsCard />
        </SettingsDisclosure> : null}

        <SettingsDisclosure sectionKey="dots" title="Dots" description="Your six assistants: models, permissions and reminders." scope="Your account" icon={Bot}
          help="Dots are your built-in assistants. Choose which one opens first, which AI model it uses, how much it may do without asking you, and whether it may message you first."
          keywords="assistant model permissions email slack reminders">
          <RecoverableSurface fallback={settingsCardLoadingFallback}>
            <LazyDotsSettingsCard roomId={roomId} isAdmin={isAdmin} request={dotSettingsRequest} />
          </RecoverableSurface>
        </SettingsDisclosure>

        <SettingsDisclosure sectionKey="job-copilot" title="Job Copilot" description="The agent and account new Job Copilot panes open with." scope="Your account" icon={Bot}
          help="Job Copilot applies for jobs with an AI coding agent. Choose that agent and its account once and every new Job Copilot pane, on every device, opens with it; turn on asking to pick each time."
          keywords="job copilot applications agent claude codex account default ask launch">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyJobCopilotSettingsCard /></RecoverableSurface>
        </SettingsDisclosure>
        <SettingsDisclosure sectionKey="mail-copilot" title="Mail Copilot" description="The agent and account new Mail Copilot panes open with." scope="Your account" icon={Mail}
          help="Mail Copilot shows your Gmail accounts and handles mail with an AI coding agent.
Choose that agent and its account once and every new Mail Copilot pane, on every device, opens with it; turn on asking to pick each time."
          keywords="mail copilot gmail email inbox agent claude codex account default ask launch">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyMailCopilotSettingsCard /></RecoverableSurface>
        </SettingsDisclosure>
        <SettingsDisclosure sectionKey="marketing-copilot" title="Marketing Copilot" description="The agent and account new Marketing Copilot panes open with." scope="Your account" icon={Rocket}
          help="Marketing Copilot promotes SpaceApp with an AI coding agent and the pane's browser. Choose that agent and its account once and every new Marketing Copilot pane, on every device, opens with it; turn on asking to pick each time."
          keywords="marketing copilot promote social posts launch campaign agent claude codex account default ask launch">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyMarketingCopilotSettingsCard /></RecoverableSurface>
        </SettingsDisclosure>
        <SettingsDisclosure sectionKey="freelance-copilot" title="Freelance Copilot" description="The agent and account new Freelance Copilot panes open with." scope="Your account" icon={Handshake}
          help="Freelance Copilot finds clients on freelance platforms with an AI coding agent and the pane's browser. Choose that agent and its account once and every new Freelance Copilot pane, on every device, opens with it; turn on asking to pick each time."
          keywords="freelance copilot upwork contra fiverr toptal clients proposals agent claude codex account default ask launch">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyFreelanceCopilotSettingsCard /></RecoverableSurface>
        </SettingsDisclosure>
        <SettingsDisclosure sectionKey="design" title="Design" description="The designer and account new Design panes open with." scope="Your account" icon={PenTool}
          help="The Design pane makes graphics with an AI coding agent as its designer. Choose that agent and its account once and every new Design pane, on every device, opens with it; turn on asking to pick each time."
          keywords="design graphics banner social images studio designer agent claude codex account default ask launch">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyDesignSettingsCard /></RecoverableSurface>
        </SettingsDisclosure>
        <SettingsDisclosure sectionKey="app-studio" title="App Studio" description="The app builder and account new App Studio panes open with." scope="Your account" icon={TabletSmartphone}
          help="App Studio builds mobile apps for Android and iOS with an AI coding agent and shows every screen on the most-used phones. Choose that agent and its account once and every new App Studio pane, on every device, opens with it; turn on asking to pick each time."
          keywords="app studio mobile app android ios iphone expo react native preview phone agent claude codex account default ask launch">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyAppStudioSettingsCard /></RecoverableSurface>
        </SettingsDisclosure>
        <SettingsDisclosure sectionKey="video" title="Video" description="The editor and account new Video panes open with." scope="Your account" icon={Film}
          help="The Video pane cuts videos into every social format with an AI coding agent as its editor: clipping, transitions, captions, narration and music. Choose that agent and its account once and every new Video pane, on every device, opens with it; turn on asking to pick each time."
          keywords="video studio editor clips shorts reels captions narration music agent claude codex account default ask launch">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyVideoSettingsCard /></RecoverableSurface>
        </SettingsDisclosure>
        <SettingsDisclosure sectionKey="security-copilot" title="Security Copilot" description="The security engineer and account new Security Copilot panes open with." scope="Your account" icon={ShieldHalf}
          help="The Security Copilot keeps every Proxmox host and SpaceApp patched with an AI coding agent: Space watches the vulnerability feeds, the agent inventories the hosts and fixes what they need through Space's gate. Choose that agent and its account once and every new Security Copilot pane, on every device, opens with it; turn on asking to pick each time."
          keywords="security copilot vulnerabilities cve kev patch updates servers proxmox hosts agent claude codex account default ask launch">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazySecurityCopilotSettingsCard /></RecoverableSurface>
        </SettingsDisclosure>
        <SettingsDisclosure sectionKey="youtube-summary" title="YouTube" description="The AI model that summarizes YouTube videos, and where and at what resolution Download saves them." scope="Your account" icon={Youtube}
          help="In a YouTube pane, Summarize with AI has this Gemini model watch the video you are on and write a short summary with its key points; Full text writes down everything said in it, from the video's captions when it has them. Download saves the video in the Agent Files folder and resolution chosen here, adds it to the Video library and tells you in Notifications when it is done. The YouTube pane's Settings button opens the same settings."
          keywords="youtube video summary summarize full text transcript ai gemini model antigravity download folder agent files resolution 4k 1080p">
          <YouTubeSettingsCard />
        </SettingsDisclosure>

        {canManageCliRuntimes ? <SettingsDisclosure hidden={!adminMode} title="Default provider" description="The AI service new chats start with." scope="New sessions" icon={ServerCog}
          help="New chats and agents start with this AI service. Chats that already exist keep the one they use."
          keywords="ai service openai model chat agent">
          <section className="agent-settings-card settings-flat-card settings-provider-card" aria-label="Global provider settings">
            <label className="provider-default-select settings-flat-row">
              <span className="settings-flat-row-copy">
                <strong>Provider</strong>
                <small>
                  {!isCodexEnabled ? "Codex is turned off, so the provider can't be changed."
                    : defaultProvider ? `Route: ${providerRouteLabel(defaultProvider)}` : "Loading providers…"}
                </small>
              </span>
              <select
                aria-label="Default provider"
                name="settings-default-provider"
                value={providerSettings?.defaultProviderId ?? ""}
                onChange={(event) => void selectDefaultProvider(event.target.value)}
                disabled={!isCodexEnabled || providerPending || providers.length === 0}
                title={!isCodexEnabled ? "Enable Codex in Settings" : undefined}
              >
                {providers.length ? (
                  providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.displayName}
                    </option>
                  ))
                ) : (
                  <option value="">No providers</option>
                )}
              </select>
            </label>
            {providerError ? (
              <DockNotice onDismiss={() => setProviderError(null)}>The default provider could not be changed: {providerError}</DockNotice>
            ) : null}
          </section>
        </SettingsDisclosure> : null}

        {isAdmin ? <SettingsDisclosure title="Agent capabilities" description="Skills and extra tools your AI coding agents may use." scope="Installation" icon={Sparkles}
          help="Choose which skills and tool servers your AI coding agents (Claude Code, Codex and others) may use, and see how often they used them. Everything stays on unless you switch it off."
          keywords="skills mcp backends tools routing claude codex usage">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyAgentCapabilitiesCard /></RecoverableSurface>
        </SettingsDisclosure> : null}

        <SettingsDisclosure title="Plugins" description="Services your assistants can act through." scope="Installation" icon={Plug}
          help="Connect outside services, such as GitHub or Slack, so your assistants can work with them for you. You can disconnect a service at any time."
          keywords="integrations github slack connect services accounts">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyPluginsSettingsCard canManage={canManageInstallation} /></RecoverableSurface>
        </SettingsDisclosure>
      </SettingsGroup>

      <SettingsGroup groupKey="connections" title="Accounts & connections" description="Sign-in and outside services.">
        {adminMode && canManageCliRuntimes ? <SettingsSearchable keywords="setup wizard install connect tools accounts first time">
          <div className="settings-setup-shortcut">
            <Compass aria-hidden="true" />
            <span>
              <strong>Setup wizard</strong>
              <small>Connect AI tools and accounts step by step. You can stop and come back at any time.</small>
            </span>
            <button type="button" aria-label="Open setup wizard" onClick={onOpenSetup}>Open</button>
          </div>
        </SettingsSearchable> : null}

        <SettingsDisclosure title="Account & Google" description="Sign in with your Google account." scope="Your account" icon={Users}
          help="Link your Google account to sign in with one click. Your rooms and settings stay the same. Admins can also turn on Google sign-in for everyone here."
          keywords="google sign in login sso account email devices phone mobile app nous revoke">
          <RecoverableSurface fallback={settingsCardLoadingFallback}>
            <LazyGoogleAccountSettingsCard auth={auth ?? null} onAuthRefresh={onAuthRefresh ?? (async () => {})} />
          </RecoverableSurface>
        </SettingsDisclosure>

        {canManageSourceControl ? <SettingsDisclosure hidden={!adminMode} title="GitHub & Gitea" description="Let Space publish its own code." scope="Installation" icon={GitBranch}
          help="Only needed if Space should publish its own updates to your GitHub or Gitea repository. Paste an access token; Space checks it and never shows it again."
          keywords="github gitea token repository publish git">
          <RecoverableSurface fallback={settingsCardLoadingFallback}>
            <LazySourceControlPublishingCard canManage={canManageSourceControl} />
          </RecoverableSurface>
        </SettingsDisclosure> : null}

        {canManageTelegram ? <SettingsDisclosure hidden={!adminMode} title="Telegram notifications" description="Get a Telegram message when work finishes." scope="Installation" icon={Bell}
          help="Get a private Telegram message when an agent finishes a task. Create a bot in Telegram, paste its token here, then pair your chat."
          keywords="telegram bot messages phone alerts">
          <RecoverableSurface fallback={settingsCardLoadingFallback}>
            <LazyTelegramIntegrationCard canManage={canManageTelegram} isCodexEnabled={isCodexEnabled} />
          </RecoverableSurface>
        </SettingsDisclosure> : null}
      </SettingsGroup>

      <SettingsGroup groupKey="maintenance" title="Maintenance" description="Backups, problem reports and updates.">
        <SettingsDisclosure title="Backup & migration" description="Save or restore rooms, panes and settings." scope="Installation" icon={ArrowUpDown}
          help="Download a backup file of your rooms, panes, bookmarks, plans and settings, or load one to restore them or move to another computer."
          keywords="backup restore export import move migrate file">
          <RecoverableSurface fallback={settingsCardLoadingFallback}>
            <LazyConfigurationMigrationCard canManageInstallation={canManageInstallation} />
          </RecoverableSurface>
        </SettingsDisclosure>

        {canManageDiagnostics ? <SettingsDisclosure title="Diagnostics" description="Record technical details to find a problem." scope="Installation" icon={Activity}
          help="Turn this on only while you track down a problem. Space then keeps technical details, and a video of this tab if you choose, for 24 hours."
          keywords="debug recording problem bug support logs">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyAppDiagnosticsSettingsCard canManage={canManageDiagnostics} /></RecoverableSurface>
        </SettingsDisclosure> : null}

        {canManageDiagnostics ? <SettingsDisclosure title="Releases" description="Publish tested changes to your Space." scope="Installation" icon={Rocket}
          help="New changes are tried on the test copy of Space (dev) first. Promote them here when you want them in the Space you use every day (stable). Live deploy progress is in the Source Control dock."
          keywords="update version promote dev stable deploy hotfix">
          <RecoverableSurface fallback={settingsCardLoadingFallback}><LazyReleasesSettingsCard /></RecoverableSurface>
        </SettingsDisclosure> : null}
      </SettingsGroup>
      </div>
      </SettingsSections>
    </div>
  );
}

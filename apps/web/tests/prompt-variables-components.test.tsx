// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptVariableAutocomplete } from "../src/features/prompt-variables/PromptVariableAutocomplete.js";
import { PromptVariablesManagerModal } from "../src/features/prompt-variables/PromptVariablesManagerModal.js";
import { PromptVariablesMenu } from "../src/features/prompt-variables/PromptVariablesMenu.js";
import { PromptVariablesSettingsCard } from "../src/features/prompt-variables/PromptVariablesSettingsCard.js";
import {
  writePromptVariables,
  writePromptVariablesSettings,
  readStoredPromptVariables,
  readStoredPromptVariablesSettings
} from "../src/features/prompt-variables/prompt-variables-store.js";
import type { PromptVariable } from "@space/contracts";

afterEach(cleanup);

const mockVariables: PromptVariable[] = [
  {
    id: "pv_1",
    name: "pc_thai",
    value: "Computer with IP 192.168.10.50 accessed via RT-BKK-01",
    description: "Bangkok terminal bridge",
    category: "Network"
  },
  {
    id: "pv_2",
    name: "prod_db",
    value: "postgres://prod-db.internal:5432/app",
    description: "Production Postgres primary",
    category: "Database"
  }
];

describe("PromptVariableAutocomplete", () => {
  beforeEach(() => {
    window.localStorage.clear();
    writePromptVariables(mockVariables);
    writePromptVariablesSettings({ enabled: true, autoExpandOnSubmit: true });
  });

  it("renders matching variable items and responds to selection and manager open", () => {
    const handleSelect = vi.fn();
    const handleClose = vi.fn();
    const handleOpenManager = vi.fn();

    render(
      <PromptVariableAutocomplete
        query="pc"
        selectedIndex={0}
        onSelect={handleSelect}
        onClose={handleClose}
        onOpenManager={handleOpenManager}
      />
    );

    expect(screen.getByText("Variables")).toBeTruthy();
    expect(screen.getByText(/pc_thai/)).toBeTruthy();
    expect(screen.getByText("Network")).toBeTruthy();

    const manageBtn = screen.getByRole("button", { name: "Manage Prompt Variables" });
    fireEvent.click(manageBtn);
    expect(handleOpenManager).toHaveBeenCalledWith("pc");

    const closeBtn = screen.getByRole("button", { name: "Close" });
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(handleClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByText(/pc_thai/));
    expect(handleSelect).toHaveBeenCalledWith(mockVariables[0]);
  });

  it("shows quick create button when no variables match query", () => {
    const handleOpenManager = vi.fn();

    render(
      <PromptVariableAutocomplete
        query="nonexistent"
        selectedIndex={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onOpenManager={handleOpenManager}
      />
    );

    expect(screen.getByText(/No variable matches/i)).toBeTruthy();
    const createBtn = screen.getByRole("button", { name: /Create #nonexistent/i });
    expect(createBtn).toBeTruthy();
    fireEvent.click(createBtn);
    expect(handleOpenManager).toHaveBeenCalledWith("nonexistent");
  });

  it("does not render when feature is disabled in settings", () => {
    writePromptVariablesSettings({ enabled: false, autoExpandOnSubmit: false });

    const { container } = render(
      <PromptVariableAutocomplete
        query=""
        selectedIndex={0}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(container.firstChild).toBeNull();
  });
});

describe("PromptVariablesManagerModal", () => {
  beforeEach(() => {
    window.localStorage.clear();
    writePromptVariables(mockVariables);
    writePromptVariablesSettings({ enabled: true, autoExpandOnSubmit: true });
    window.confirm = () => true;
  });

  it("renders existing variables and allows creating a new variable", () => {
    const handleClose = vi.fn();

    render(
      <PromptVariablesManagerModal
        open={true}
        onClose={handleClose}
      />
    );

    expect(screen.getByText("Prompt Variables")).toBeTruthy();
    expect(screen.getByText(/pc_thai/)).toBeTruthy();
    expect(screen.getByText(/prod_db/)).toBeTruthy();

    // Click "New Variable"
    const addBtn = screen.getByRole("button", { name: /New Variable/i });
    fireEvent.click(addBtn);

    // Fill form
    const nameInput = screen.getByPlaceholderText(/^pc_thai$/i);
    const valueInput = screen.getByPlaceholderText(/accessible via wireguard tunnel/i);

    fireEvent.change(nameInput, { target: { value: "staging_api" } });
    fireEvent.change(valueInput, { target: { value: "https://api.staging.example.com" } });

    const saveBtn = screen.getByRole("button", { name: /Create Variable/i });
    fireEvent.click(saveBtn);

    const variables = readStoredPromptVariables();
    const created = variables.find((v) => v.name === "staging_api");
    expect(created).toBeDefined();
    expect(created?.value).toBe("https://api.staging.example.com");
  });

  it("allows deleting an existing variable with confirmation", () => {
    render(
      <PromptVariablesManagerModal
        open={true}
        onClose={vi.fn()}
      />
    );

    const deleteBtn = screen.getByRole("button", { name: /Delete #pc_thai/i });
    fireEvent.click(deleteBtn);

    const variables = readStoredPromptVariables();
    expect(variables.some((v) => v.name === "pc_thai")).toBe(false);
  });
});

describe("PromptVariablesSettingsCard", () => {
  beforeEach(() => {
    window.localStorage.clear();
    writePromptVariables(mockVariables);
    writePromptVariablesSettings({ enabled: true, autoExpandOnSubmit: true });
  });

  it("renders toggle controls and responds to user toggle changes", () => {
    render(<PromptVariablesSettingsCard />);

    expect(screen.getByText("Prompt variables")).toBeTruthy();
    const autoExpandToggle = screen.getByRole("switch", { name: "Auto-expand #variables on submission" }) as HTMLInputElement;
    expect(autoExpandToggle.checked).toBe(true);

    fireEvent.click(autoExpandToggle);
    expect(readStoredPromptVariablesSettings().autoExpandOnSubmit).toBe(false);
  });
});

describe("PromptVariablesMenu", () => {
  beforeEach(() => {
    window.localStorage.clear();
    writePromptVariables(mockVariables);
    writePromptVariablesSettings({ enabled: true, autoExpandOnSubmit: true });
  });

  it("renders trigger button with count badge and opens popover on click", () => {
    render(
      <div className="pane-card" style={{ width: 800, height: 600 }}>
        <div className="terminal-floating-controls">
          <PromptVariablesMenu paneTitle="Terminal 1" />
        </div>
      </div>
    );

    const button = screen.getByRole("button", { name: /Prompt Variables \(#\) · Terminal 1/i });
    expect(button).toBeTruthy();
    // Trigger button has no number badge
    expect(button.querySelector(".terminal-plans-button-badge")).toBeNull();

    fireEvent.click(button);

    // Popover is open
    expect(screen.getByRole("dialog", { name: "Prompt Variables" })).toBeTruthy();
    expect(screen.getByText("#pc_thai")).toBeTruthy();
    expect(screen.getByText("#prod_db")).toBeTruthy();

    // Escape closes popover
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Prompt Variables" })).toBeNull();
  });

  it("inserts variable definition and closes popover when clicking insert", () => {
    const handleInsert = vi.fn();

    render(
      <div className="pane-card" style={{ width: 800, height: 600 }}>
        <div className="terminal-floating-controls">
          <PromptVariablesMenu paneTitle="CLI" onInsertVariable={handleInsert} />
        </div>
      </div>
    );

    const button = screen.getByRole("button", { name: /Prompt Variables \(#\) · CLI/i });
    fireEvent.click(button);

    const insertBtns = screen.getAllByRole("button", { name: "Insert" });
    expect(insertBtns.length).toBeGreaterThan(0);
    fireEvent.click(insertBtns[0]!);

    expect(handleInsert).toHaveBeenCalledWith(mockVariables[0]);
    // Dialog closes
    expect(screen.queryByRole("dialog", { name: "Prompt Variables" })).toBeNull();
  });

  it("filters variables by search query inside the popover", () => {
    render(
      <div className="pane-card" style={{ width: 800, height: 600 }}>
        <div className="terminal-floating-controls">
          <PromptVariablesMenu open={true} />
        </div>
      </div>
    );

    const searchInput = screen.getByRole("textbox", { name: "Search prompt variables" });
    fireEvent.change(searchInput, { target: { value: "postgres" } });

    expect(screen.queryByText("#pc_thai")).toBeNull();
    expect(screen.getByText("#prod_db")).toBeTruthy();
  });

  it("allows creating a new variable directly in the popover form", () => {
    render(
      <div className="pane-card" style={{ width: 800, height: 600 }}>
        <div className="terminal-floating-controls">
          <PromptVariablesMenu open={true} />
        </div>
      </div>
    );

    const newBtn = screen.getByRole("button", { name: "New prompt variable" });
    fireEvent.click(newBtn);

    expect(screen.getByText("New Prompt Variable")).toBeTruthy();

    const nameInput = screen.getByLabelText("Trigger Name");
    const valInput = screen.getByLabelText("Definition / Injected Prompt");

    fireEvent.change(nameInput, { target: { value: "redis_cache" } });
    fireEvent.change(valInput, { target: { value: "redis://10.0.0.8:6379/1" } });

    const saveBtn = screen.getByRole("button", { name: "Save Variable" });
    fireEvent.click(saveBtn);

    const stored = readStoredPromptVariables();
    expect(stored.some((v) => v.name === "redis_cache")).toBe(true);
  });

  it("renders count badge inside popover header when opened and keeps trigger button clean", () => {
    const manyVariables: PromptVariable[] = Array.from({ length: 12 }, (_, i) => ({
      id: `pv_${i}`,
      name: `var_${i}`,
      value: `val_${i}`
    }));
    writePromptVariables(manyVariables);

    render(
      <div className="pane-card" style={{ width: 800, height: 600 }}>
        <div className="terminal-floating-controls">
          <PromptVariablesMenu paneTitle="CLI" open={true} />
        </div>
      </div>
    );

    const badge = screen.getByText("12");
    expect(badge).toBeTruthy();
    expect(badge.className).toContain("terminal-plans-count-badge");

    const triggerBtn = screen.getByRole("button", { name: /Prompt Variables \(#\) · CLI/i });
    expect(triggerBtn.querySelector(".terminal-plans-button-badge")).toBeNull();
  });
});



describe("PromptVariablesMenu editing safety", () => {
  beforeEach(() => {
    window.localStorage.clear();
    writePromptVariables(mockVariables);
    writePromptVariablesSettings({ enabled: true, autoExpandOnSubmit: true });
  });

  const renderOpenMenu = () => render(
    <div className="pane-card" style={{ width: 800, height: 600 }}>
      <div className="terminal-floating-controls">
        <PromptVariablesMenu open={true} />
      </div>
    </div>
  );

  it("refuses a new variable that would silently replace an existing name and keeps the value as typed", () => {
    renderOpenMenu();
    fireEvent.click(screen.getByRole("button", { name: "New prompt variable" }));
    fireEvent.change(screen.getByLabelText("Trigger Name"), { target: { value: "#PC_THAI" } });
    fireEvent.change(screen.getByLabelText("Definition / Injected Prompt"), { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Variable" }));
    expect(screen.getByText("A variable named #PC_THAI already exists.")).toBeTruthy();
    expect(readStoredPromptVariables().find((v) => v.name.toLowerCase() === "pc_thai")?.value).toBe(mockVariables[0]!.value);

    fireEvent.change(screen.getByLabelText("Trigger Name"), { target: { value: "indent" } });
    fireEvent.change(screen.getByLabelText("Definition / Injected Prompt"), { target: { value: "  two leading spaces " } });
    fireEvent.click(screen.getByRole("button", { name: "Save Variable" }));
    expect(readStoredPromptVariables().find((v) => v.name === "indent")?.value).toBe("  two leading spaces ");
  });

  it("deletes at once and offers Undo instead of a blocking confirm", () => {
    const confirm = vi.spyOn(window, "confirm");
    renderOpenMenu();
    fireEvent.click(screen.getByRole("button", { name: "Delete #prod_db" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(readStoredPromptVariables().some((v) => v.name === "prod_db")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(readStoredPromptVariables().find((v) => v.name === "prod_db")).toEqual(mockVariables[1]);
    confirm.mockRestore();
  });

  it("previews an import and changes nothing until Merge", async () => {
    const { container } = renderOpenMenu();
    const input = container.ownerDocument.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([JSON.stringify([
      { name: "pc_thai", value: "10.0.0.9 new" },
      { name: "fresh_one", value: "fresh value" },
      { name: "bad name!", value: "x" }
    ])], "vars.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText("vars.json: 2 variables (1 new, 1 update existing, 1 skipped).")).toBeTruthy();
    expect(readStoredPromptVariables()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    const stored = readStoredPromptVariables();
    expect(stored).toHaveLength(3);
    expect(stored.find((v) => v.name === "pc_thai")?.value).toBe("10.0.0.9 new");
    expect(stored.find((v) => v.name === "prod_db")).toBeTruthy();

    fireEvent.change(input, { target: { files: [new File(["{not json"], "broken.json")] } });
    expect((await screen.findByRole("alert")).textContent).toContain("The file is not valid JSON.");
  });

  it("marks variable values for the sensitive-data mask and inserts with a plain label", () => {
    render(
      <div className="pane-card" style={{ width: 800, height: 600 }}>
        <div className="terminal-floating-controls">
          <PromptVariablesMenu open={true} onInsertVariable={vi.fn()} />
        </div>
      </div>
    );
    const value = screen.getByText(mockVariables[0]!.value);
    expect(value.getAttribute("data-sensitive-masked")).toBe("manual");
    expect(value.closest("[title]")?.getAttribute("title") ?? "").not.toContain("192.168.10.50");
    expect(screen.getAllByRole("button", { name: "Insert" })[0]!.getAttribute("title")).toBe("Insert #pc_thai");
  });
});

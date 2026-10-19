import { createHash } from "node:crypto";
import type { RepositoryPage, RepositoryProviderId } from "@space/contracts";
import type { ProviderExchange, ProviderResponse, ProviderUrlPolicy } from "../provider-transport.js";
import { GitControlError } from "../errors.js";

export function invalid(code = "PROVIDER_FAILED", message = "Provider returned an invalid response."): never { throw new GitControlError(code, message, 502); }
export function object(value: unknown): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(); return value as Record<string, any>; }
export function array(value: unknown): unknown[] { if (!Array.isArray(value)) return invalid(); return value; }
export function text(value: unknown): string { if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) return invalid(); return value; }
export function numericId(value: string): string { if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new GitControlError("INVALID_REPOSITORY", "A stable numeric identifier is required."); return value; }
export function segment(value: string): string { if (!value || value === "." || value === ".." || /[\/\\\x00-\x1f\x7f]/.test(value)) throw new GitControlError("INVALID_REPOSITORY", "Invalid repository identifier."); return encodeURIComponent(value); }
export function repositoryName(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) || value.endsWith(".git")) throw new GitControlError("INVALID_REPOSITORY", "Enter a repository name using letters, numbers, dots, underscores or hyphens."); return value; }
export function requiredTarget(): never { throw new GitControlError("TARGET_REQUIRED", "Select an existing repository target."); }
export function permission(): never { throw new GitControlError("INSUFFICIENT_PERMISSION", "Account cannot create a repository in this target.", 403); }
const cursorError = (): never => { throw new GitControlError("INVALID_CURSOR", "Pagination cursor does not match this request."); };
export interface PageInput { page?: number; cursor?: string }
export abstract class AdapterBase {
  constructor(readonly provider: RepositoryProviderId, protected readonly server: string, protected readonly api: string,
    private readonly authorization: string, protected readonly policy: ProviderUrlPolicy, private readonly exchange: ProviderExchange) {}
  protected url(path: string, params: Record<string, string | number | undefined> = {}): URL {
    const url = new URL(this.api + path); for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value)); return url;
  }
  protected call(path: string, method = "GET", body?: unknown, params: Record<string, string | number | undefined> = {}): Promise<ProviderResponse> {
    return this.exchange(this.url(path, params), this.authorization, method, body);
  }
  protected async data(path: string, method = "GET", body?: unknown, params: Record<string, string | number | undefined> = {}) { return (await this.call(path, method, body, params)).data; }
  /**
   * The repository-create request and the mapping of its answer. A failure here (including an unreadable
   * success response) may leave a created repository, so it is marked as attempted, never as rejected.
   */
  protected async createRequest<T>(path: string, body: unknown, map: (data: unknown) => T | Promise<T>, params: Record<string, string | number | undefined> = {}): Promise<T> {
    try { return await map(await this.data(path, "POST", body, params)); }
    catch (error) { const failure = error instanceof GitControlError ? error : new GitControlError("PROVIDER_FAILED", "Provider returned an invalid response.", 502); failure.createAttempted = true; throw failure; }
  }
  protected clone(input: string, stripUsername = false): string {
    let url: URL; try { url = new URL(input); } catch { throw new GitControlError("REMOTE_MISMATCH", "Invalid provider clone URL.", 409); }
    const base = new URL(this.server), prefix = base.pathname.replace(/\/$/, "") + "/";
    if (url.origin !== base.origin || url.password || url.username && !stripUsername || url.search || url.hash || !url.pathname.startsWith(prefix)) throw new GitControlError("REMOTE_MISMATCH", "Repository URL does not match the connected provider.", 409);
    const parts = url.pathname.slice(prefix.length).split("/");
    if (parts.length < 2 || parts.some(part => { try { const s = decodeURIComponent(part); return !s || s === "." || s === ".." || /[\/\\\x00-\x1f\x7f]/.test(s); } catch { return true; } })) throw new GitControlError("REMOTE_MISMATCH", "Repository path is invalid.", 409);
    if (this.provider === "azure-devops" && (parts.length !== 3 || parts[1] !== "_git")) throw new GitControlError("REMOTE_MISMATCH", "Select a repository in this Azure organization.", 409);
    url.username = ""; return url.toString();
  }
  async validateCloneUrl(input: string): Promise<string> { const url = this.clone(input); await this.policy.address(new URL(url)); return url; }
  /** alternatePaths: canonical next-link paths a provider documents for the same collection (GitHub /organizations/{id}/repos). */
  protected async page(path: string, params: Record<string, string | number | undefined>, input: PageInput, context: unknown, style: "array" | "values" | "azure" = "array", alternatePaths: string[] = []) {
    if (input.cursor && input.page !== undefined) cursorError();
    const initial = this.url(path, params);
    const scope = createHash("sha256").update(JSON.stringify([this.provider, this.server, initial.toString(), context])).digest("hex");
    const pagination = new Set(["page", "continuationToken", "after"]);
    const validate = (url: URL) => {
      if (url.origin !== initial.origin || url.pathname !== initial.pathname && !alternatePaths.includes(url.pathname) || url.username || url.password || url.hash) cursorError();
      for (const [key, value] of initial.searchParams) if (!pagination.has(key) && url.searchParams.get(key) !== value) cursorError();
      for (const [key, value] of url.searchParams) {
        if (url.searchParams.getAll(key).length !== 1 || !initial.searchParams.has(key) && !pagination.has(key)) cursorError();
        if (key === "page" && (!/^[1-9][0-9]{0,5}$/.test(value) || Number(value) > 100000)) cursorError();
      }
    };
    let url = new URL(initial);
    if (input.cursor) {
      try { const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); if (decoded.scope !== scope || typeof decoded.url !== "string" || input.cursor.length > 4096) cursorError(); url = new URL(decoded.url); validate(url); } catch { cursorError(); }
    } else if (input.page !== undefined) { if (!Number.isInteger(input.page) || input.page < 1 || input.page > 1000) cursorError(); url.searchParams.set("page", String(input.page)); }
    const response = await this.exchange(url, this.authorization, "GET");
    const envelope = style === "array" ? null : object(response.data);
    const values = array(envelope ? envelope[style === "azure" ? "value" : "values"] : response.data);
    let next: URL | null = null;
    const link = response.headers.link?.match(/<([^>]+)>;\s*rel="?next"?/);
    const parse = (value: string) => { try { return new URL(value, url); } catch { return cursorError(); } };
    if (link) next = parse(link[1]!);
    else if (typeof envelope?.next === "string" && envelope.next) next = parse(envelope.next);
    else if (response.headers["x-ms-continuationtoken"]) { next = new URL(url); next.searchParams.set("continuationToken", response.headers["x-ms-continuationtoken"]!); }
    else if (response.headers["x-next-page"]) { next = new URL(url); next.searchParams.set("page", response.headers["x-next-page"]!); }
    else if (style === "array" && response.headers["x-next-page"] === undefined && !response.headers.link && values.length === 50) { next = new URL(url); next.searchParams.set("page", String(Number(url.searchParams.get("page") || "1") + 1)); }
    if (next) { validate(next); if (next.toString() === url.toString()) cursorError(); }
    return { values, nextPage: next?.searchParams.has("page") ? Number(next.searchParams.get("page")) : null,
      nextCursor: next ? Buffer.from(JSON.stringify({ scope, url: next.toString() })).toString("base64url") : null };
  }
  protected result<T>(page: { nextPage: number | null; nextCursor: string | null }, data: T[]): RepositoryPage<T> { return { data, nextPage: page.nextPage, nextCursor: page.nextCursor }; }
}

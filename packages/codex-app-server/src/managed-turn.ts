import { CodexManagedTurnDeliveryError, codexRetryableFailure } from "./managed-turn-errors.js";
import { isAbsolute } from "node:path";
import { WebSocket } from "ws";
import { assertCodexAppServerSocketRpcMethodAllowed, codexAppServerSocketMaxPayloadBytes, type CodexAppServerSocketControlServiceOptions, type CodexAppServerSocketStartTurnInput, type CodexAppServerSocketStartedTurn } from "./index.js";
/** This proves native accepted turn configuration, NOT provider inference telemetry. */
export interface CodexAcceptedTurnSelection {
    source: "NATIVE_ACCEPTED_TURN_CONFIGURATION";
    modelId: string;
    reasoningEffort: string;
    threadId: string;
    turnId: string;
    commandId: string;
    observedAt: string;
    completedAt: string;
    transport: "CONTINUOUS_NATIVE_NOTIFICATIONS";
    providerTelemetry: false;
}
export type CodexManagedTurnEvidence = {
    status: "OBSERVING" | "VERIFIED" | "INVALID";
    selection: CodexAcceptedTurnSelection | null;
};
export interface CodexManagedTurnObservation {
    read(): CodexManagedTurnEvidence;
    close(): void;
}
export interface CodexManagedStartedTurn extends CodexAppServerSocketStartedTurn {
    observation: CodexManagedTurnObservation;
}
/** A separate managed-only control connection. The existing Space socket mux
 * broadcasts its subscribed native stream; no attach/resume or lifecycle RPCs.
 * Keep the original five-second handshake/send deadline. After acceptance this
 * connection only observes, and loss of continuity invalidates evidence forever.
 */
export async function startObservedCodexTurn(options: CodexAppServerSocketControlServiceOptions, input: CodexAppServerSocketStartTurnInput): Promise<CodexManagedStartedTurn> {
    if (!isAbsolute(options.socketPath) || !input.prompt.trim() || input.prompt.trim().length > 20000 ||
        !input.threadId || !input.clientUserMessageId ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.model ?? "") ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.reasoningEffort ?? ""))
        throw new Error("Invalid managed Codex turn configuration.");
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws+unix://${options.socketPath}:/rpc`, {
            maxPayload: codexAppServerSocketMaxPayloadBytes, perMessageDeflate: false
        });
        let settled = false, sent = false, closed = false, initialized = false;
        let startedId: string | null = null, acceptedId: string | null = null, completedId: string | null = null;
        let invalid = false;
        let selection: CodexAcceptedTurnSelection | null = null;
        const observedAt = new Date().toISOString();
        let completedAt: string | null = null;
        const observation: CodexManagedTurnObservation = {
            read: () => ({ status: invalid ? "INVALID" : selection ? "VERIFIED" : "OBSERVING", selection: invalid ? null : selection ? { ...selection } : null }),
            close: () => {
                if (!selection) invalid = true;
                closed = true;
                clearTimeout(deadline);
                socket.terminate();
            }
        };
        const fail = (rejection?: CodexManagedTurnDeliveryError) => {
            invalid = true;
            observation.close();
            if (!settled) {
                settled = true;
                reject(rejection ?? new CodexManagedTurnDeliveryError(sent ? "UNKNOWN" : "NOT_SENT"));
            }
        };
        const deadline = setTimeout(() => fail(), Math.max(1, options.timeoutMs ?? 5000));
        const request = (id: number, method: string, params: unknown) => {
            assertCodexAppServerSocketRpcMethodAllowed(method);
            if (closed || socket.readyState !== WebSocket.OPEN)
                throw new Error("Managed Codex connection is closed.");
            socket.send(JSON.stringify({ id, method, params }));
        };
        const finalize = () => {
            if (!acceptedId || !completedId)
                return;
            if (startedId !== acceptedId || completedId !== acceptedId)
                invalid = true;
            if (!invalid)
                selection = { source: "NATIVE_ACCEPTED_TURN_CONFIGURATION", modelId: input.model!, reasoningEffort: input.reasoningEffort!,
                    threadId: input.threadId, turnId: acceptedId, commandId: input.clientUserMessageId, observedAt, completedAt: completedAt!,
                    transport: "CONTINUOUS_NATIVE_NOTIFICATIONS", providerTelemetry: false };
            observation.close();
        };
        socket.once('open', () => { try {
            request(0, 'initialize', { clientInfo: options.clientInfo ?? { name: 'space', title: 'Space', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
        }
        catch {
            fail();
        } });
        socket.on('message', (raw, binary) => {
            if (binary) {
                fail();
                return;
            }
            try {
                const m = JSON.parse(raw.toString());
                if (m.method) {
                    // Server requests belong to the existing TUI authority; never answer them here.
                    if (m.id !== undefined) return;
                    const p = m.params;
                    if (!p || p.threadId !== input.threadId)
                        return;
                    if (m.method === 'thread/settings/updated') {
                        if (p.threadSettings?.model !== input.model || p.threadSettings?.effort !== input.reasoningEffort)
                            invalid = true;
                    }
                    else if (m.method === 'model/rerouted') {
                        // Even a restored model cannot erase routing ambiguity for the turn.
                        if (!acceptedId || p.turnId === acceptedId)
                            invalid = true;
                    }
                    else if (m.method === 'turn/started') {
                        if (!sent || typeof p.turn?.id !== 'string' || (startedId && startedId !== p.turn.id))
                            invalid = true;
                        startedId = p.turn?.id ?? null;
                    }
                    else if (m.method === 'turn/completed') {
                        if (!sent || typeof p.turn?.id !== 'string')
                            invalid = true;
                        completedId = p.turn?.id ?? null;
                        completedAt = new Date().toISOString();
                        finalize();
                    }
                    else if (['thread/closed', 'thread/reverted', 'thread/deleted', 'thread/archived'].includes(m.method))
                        invalid = true;
                    return;
                }
                if (m.error) {
                    fail(m.id === 1 && sent && !acceptedId && !startedId && !completedId ? new CodexManagedTurnDeliveryError('REJECTED',codexRetryableFailure(m.error)) : undefined);
                    return;
                }
                if (m.id === 0) {
                    if (initialized) { fail(); return; }
                    initialized = true;
                    socket.send(JSON.stringify({ method: 'initialized', params: {} }));
                    void (async () => {
                        try {
                            await input.beforeSend?.();
                            if (closed || invalid)
                                throw new Error('Observation was invalidated before start.');
                            sent = true;
                            request(1, 'turn/start', { threadId: input.threadId, input: [{ type: 'text', text: input.prompt.trim(), text_elements: [] }],
                                clientUserMessageId: input.clientUserMessageId, model: input.model, effort: input.reasoningEffort, outputSchema: input.outputSchema });
                        }
                        catch {
                            fail();
                        }
                    })();
                }
                else if (m.id === 1 && !settled) {
                    const turn = m.result?.turn;
                    if (typeof turn?.id !== 'string' || !['inProgress', 'completed', 'interrupted', 'failed'].includes(turn.status)) {
                        fail();
                        return;
                    }
                    acceptedId = turn.id;
                    settled = true;
                    clearTimeout(deadline);
                    finalize();
                    resolve({ turnId: turn.id, status: turn.status, observation });
                }
                else
                    fail();
            }
            catch {
                fail();
            }
        });
        socket.once('error', () => fail());
        socket.once('close', () => { if (!closed)
            fail(); });
    });
}

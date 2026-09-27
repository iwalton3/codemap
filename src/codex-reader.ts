import { homedir } from "node:os";
import { join } from "node:path";
import { CODEX_CLI_ROLE_VERSION } from "./codex-harness.js";
import { resolveFreshCodexCliContext, type CodexVerifierContextOptions } from "./codex-verifier-context.js";

type Purpose = "issue-application" | "operation-signoff";
type Row = Record<string, any>;
const object = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const tools: Record<Purpose, string> = {
  "issue-application": "submit_application_verdict", "operation-signoff": "submit_operation_signoff_verdict",
};
interface Host {
  version: 1; principal: string; clientInfo: unknown; requestMeta: unknown;
  tool: string; arguments: Row;
}
/** Only the dispatcher can mint this from its initialized client and host request metadata. */
export interface CodexReaderSubmission { readonly nativeReaderSubmission: true }
const submissions = new WeakMap<CodexReaderSubmission, Host>();
export const codexReaderTranscriptDir = (): string => process.env.CODEMAP_CODEX_TRANSCRIPT_DIR ?? join(homedir(), ".codex", "sessions");

export function mintCodexReaderSubmission(input: {
  principal: string | null; clientInfo: unknown; requestMeta: unknown; tool: string; arguments: unknown;
}, dir = codexReaderTranscriptDir()): CodexReaderSubmission | { error: string } {
  if (!object(input.clientInfo) || input.clientInfo.name !== "codex-mcp-client"
    || input.clientInfo.version !== CODEX_CLI_ROLE_VERSION || !object(input.arguments)
    || !Object.values(tools).includes(input.tool)) return { error: "unsupported native reader submission" };
  const checked = resolveFreshCodexCliContext({ ...input, requestTool: input.tool, transcriptDir: dir });
  if (!checked.supported) return { error: checked.reason };
  const capability: CodexReaderSubmission = Object.freeze({ nativeReaderSubmission: true });
  submissions.set(capability, structuredClone({ version: 1, principal: input.principal!,
    clientInfo: input.clientInfo, requestMeta: input.requestMeta, tool: input.tool, arguments: input.arguments }));
  return capability;
}

/** Serialized metadata is never accepted in place of an in-process dispatcher capability. */
export function bindCodexReaderHost(capability: CodexReaderSubmission, purpose: string, requestId: string, body: string): string | { error: string } {
  const host = submissions.get(capability);
  let verdict: unknown;
  try { verdict = JSON.parse(body); } catch { return { error: "malformed native reader verdict" }; }
  if (!host || !(purpose in tools) || host.tool !== tools[purpose as Purpose]
    || !object(verdict) || host.arguments.requestId !== requestId
    || host.arguments.verdict !== verdict.verdict || host.arguments.rationale !== verdict.rationale)
    return { error: "native reader submission does not match this held receipt" };
  return JSON.stringify(host);
}

export function verifyCodexReaderReceipt(input: {
  nativeHost: string; purpose: string; requestId: string; prompt: string; body: { verdict: string; rationale: string };
  receipt: string; agentId: string; callId: string; dir?: string;
}): { agentId: string; callId: string; session: string; launch: string; launchedAt: string } | { error: string } {
  try {
    const host: unknown = JSON.parse(input.nativeHost);
    if (!object(host) || host.version !== 1 || !(input.purpose in tools) || host.tool !== tools[input.purpose as Purpose]
      || !object(host.requestMeta) || !object(host.arguments) || host.requestMeta.threadId !== input.agentId
      || host.requestMeta.callId !== input.callId || host.arguments.requestId !== input.requestId
      || host.arguments.verdict !== input.body.verdict || host.arguments.rationale !== input.body.rationale)
      return { error: "native reader receipt identity or content differs" };
    const result = { content: [{ type: "text", text: JSON.stringify({ ok: true, held: true, receipt: input.receipt }, null, 2) }] };
    const options: CodexVerifierContextOptions = { principal: host.principal, clientInfo: host.clientInfo,
      requestMeta: host.requestMeta, requestTool: host.tool, transcriptDir: input.dir ?? codexReaderTranscriptDir(),
      completedRequests: [{ requestMeta: host.requestMeta, tool: host.tool, arguments: host.arguments, result }] };
    const checked = resolveFreshCodexCliContext(options);
    if (!checked.supported) return { error: checked.reason };
    if (checked.prompt !== input.prompt) return { error: "native reader launch did not use the exact issued brief" };
    return { agentId: input.agentId, callId: input.callId, session: input.agentId,
      launch: checked.launch, launchedAt: checked.launchedAt };
  } catch { return { error: "native reader receipt provenance is malformed or unreadable" }; }
}

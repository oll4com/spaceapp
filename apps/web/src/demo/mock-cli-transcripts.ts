/**
 * Authentic virtual mock CLI transcripts for all 16 Space CLI tools.
 * Styled after modern terminal agent interfaces with ANSI color highlights,
 * status trees, colored diff blocks, and interactive command handling.
 */

function diffLine(type: "+" | "-", lineNum: number | string, content: string): string {
  const prefix = `  ${lineNum} ${type}   ${content}`;
  const padded = prefix.padEnd(66, " ");
  if (type === "-") {
    return `\x1b[48;5;52m\x1b[38;5;203m${padded}\x1b[0m\r\n`;
  }
  return `\x1b[48;5;22m\x1b[38;5;120m${padded}\x1b[0m\r\n`;
}

export interface CliMockDefinition {
  runtimeId: string;
  brand: string;
  displayName: string;
  model: string;
  modelId: string;
  cwd: string;
  version: string;
  transcript: string;
  diff: string;
  testOutput: string;
  help: string;
  ls: string;
}

export const CLI_MOCK_DEFINITIONS: Record<string, CliMockDefinition> = {
  "cli:claude": {
    runtimeId: "cli:claude",
    brand: "claude",
    displayName: "Claude Code CLI",
    model: "Sonnet 5 · Claude Max",
    modelId: "claude-3-7-sonnet",
    cwd: "~/Projects/bridgemind/bridgemind-api",
    version: "v2.4.1",
    transcript:
      `\x1b[38;5;209m  ▄▀▄  ▄▀▄\x1b[0m   \x1b[1mClaude Code\x1b[0m \x1b[2mv2.4.1\x1b[0m\r\n` +
      `\x1b[38;5;209m █ █ █ █ █\x1b[0m  \x1b[2mSonnet 5 · Claude Max\x1b[0m\r\n` +
      `\x1b[38;5;209m █▀▀▀▀▀▀▀█\x1b[0m  \x1b[2m~/Projects/bridgemind/bridgemind-api\x1b[0m\r\n` +
      `\x1b[38;5;209m █ █   █ █\x1b[0m\r\n\r\n` +
      `\x1b[1m> tighten the subscription guard so a cancelled tier cannot reach a PRO route\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mRead\x1b[0m(src/common/guards/subscription.guard.ts)\r\n` +
      `  \x1b[2m└ Read 84 lines\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mUpdate\x1b[0m(src/common/guards/subscription.guard.ts)\r\n` +
      `  \x1b[2m└ Updated subscription.guard.ts with 3 additions and 1 removal\x1b[0m\r\n` +
      diffLine("-", 41, "if (!subscription) {") +
      diffLine("+", 41, "if (!subscription || subscription.status !== 'active') {") +
      diffLine("+", 42, "  throw new ForbiddenException('Subscription inactive');") +
      `\r\n` +
      `\x1b[37m●\x1b[0m Guard updated. Running the subscription suite before I add the regression test.\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mBash\x1b[0m(npm run test -- subscription)\r\n` +
      `  \x1b[2m└ Running...\x1b[0m\r\n` +
      `\x1b[38;5;208m✱\x1b[0m \x1b[38;5;208mTesting..\x1b[0m \x1b[2m(esc to interrupt · 48s · ↓ 1.8k tokens)\x1b[0m\r\n\r\n` +
      `\x1b[2m> Try "git diff", or type help\x1b[0m\r\n` +
      `\x1b[35m▶ ▶\x1b[0m \x1b[35m\x1b[1maccept edits on\x1b[0m \x1b[2m(shift+tab to cycle)\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mdiff --git a/src/common/guards/subscription.guard.ts b/src/common/guards/subscription.guard.ts\x1b[0m\r\n` +
      `\x1b[2m--- a/src/common/guards/subscription.guard.ts\r\n+++ b/src/common/guards/subscription.guard.ts\x1b[0m\r\n` +
      diffLine("-", 41, "if (!subscription) {") +
      diffLine("+", 41, "if (!subscription || subscription.status !== 'active') {") +
      diffLine("+", 42, "  throw new ForbiddenException('Subscription inactive');"),
    testOutput:
      `\x1b[1m> bridgemind-api@2.4.1 test\x1b[0m\r\n` +
      `\x1b[2m> jest --testPathPattern=subscription\x1b[0m\r\n\r\n` +
      `\x1b[32m\x1b[1mPASS\x1b[0m test/subscription.guard.spec.ts\r\n` +
      `  \x1b[32m✓\x1b[0m \x1b[2mallows active subscription to proceed\x1b[0m (18 ms)\r\n` +
      `  \x1b[32m✓\x1b[0m \x1b[2mblocks cancelled subscription from PRO route with 403\x1b[0m (12 ms)\r\n` +
      `  \x1b[32m✓\x1b[0m \x1b[2mthrows ForbiddenException with clear message\x1b[0m (8 ms)\r\n\r\n` +
      `\x1b[32m\x1b[1mTest Suites: 1 passed\x1b[0m, 1 total\r\n` +
      `\x1b[32m\x1b[1mTests:       3 passed\x1b[0m, 3 total\r\n` +
      `\x1b[2mSnapshots:   0 total\r\nTime:        1.42s\x1b[0m`,
    help:
      `\x1b[1mClaude Code shortcuts:\x1b[0m\r\n` +
      `  git diff       Review pending code changes\r\n` +
      `  npm test       Execute Jest subscription test suite\r\n` +
      `  clear          Clear the terminal viewport\r\n` +
      `  Shift+Tab      Cycle through accept/reject options`,
    ls:
      `package.json  tsconfig.json  src/  test/  nest-cli.json  README.md`
  },

  "cli:codex": {
    runtimeId: "cli:codex",
    brand: "codex",
    displayName: "Codex CLI",
    model: "gpt-5.6-sol (Reasoning: high)",
    modelId: "gpt-5.6-sol",
    cwd: "/workspace/space-platform",
    version: "v0.9.4",
    transcript:
      `\x1b[32m●\x1b[0m \x1b[1mEdited\x1b[0m test/subscription.e2e-spec.ts \x1b[32m(+41 -0)\x1b[0m\r\n` +
      diffLine("+", 1, "describe('cancelled tier', () => {") +
      diffLine("+", 2, "  it('gets 403 on a PRO route', async () => {") +
      `  \x1b[2m:\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mRan\x1b[0m npm run test:e2e -- subscription\r\n` +
      `  \x1b[2m└\x1b[0m \x1b[32m\x1b[1mPASS\x1b[0m \x1b[2mtest/subscription.e2e-spec.ts\x1b[0m\r\n` +
      `    \x1b[32m✓\x1b[0m \x1b[2mcancelled tier gets 403 on a PRO route\x1b[0m\r\n` +
      `    \x1b[2m.. +2 lines\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 1m 08s ―――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Added the cancelled-tier regression. Runs green.\r\n\r\n` +
      `\x1b[2m> Try "npm test", or type help\x1b[0m\r\n` +
      `\x1b[2m96% context left · ? for shortcuts\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mdiff --git a/test/subscription.e2e-spec.ts b/test/subscription.e2e-spec.ts\x1b[0m\r\n` +
      diffLine("+", 1, "describe('cancelled tier', () => {") +
      diffLine("+", 2, "  it('gets 403 on a PRO route', async () => {") +
      diffLine("+", 3, "    const res = await request(app).get('/v1/billing/pro');") +
      diffLine("+", 4, "    expect(res.status).toBe(403);") +
      diffLine("+", 5, "  });") +
      diffLine("+", 6, "});"),
    testOutput:
      `\x1b[32m\x1b[1mPASS\x1b[0m test/subscription.e2e-spec.ts (2.1s)\r\n` +
      `  \x1b[32m✓\x1b[0m \x1b[2mcancelled tier gets 403 on a PRO route (24ms)\x1b[0m\r\n` +
      `  \x1b[32m✓\x1b[0m \x1b[2mactive tier gets 200 with tenant scope (14ms)\x1b[0m\r\n` +
      `\x1b[32mTests: 2 passed, 2 total\x1b[0m`,
    help:
      `\x1b[1mCodex CLI shortcuts:\x1b[0m\r\n` +
      `  npm test       Run subscription e2e tests\r\n` +
      `  git diff       View staged and unstaged code changes\r\n` +
      `  clear          Clear the screen\r\n` +
      `  ?              Show this shortcut list`,
    ls:
      `package.json  src/  test/  contracts/  vitest.config.ts  README.md`
  },

  "cli:opencode": {
    runtimeId: "cli:opencode",
    brand: "opencode",
    displayName: "OpenCode CLI",
    model: "deepseek-reasoner",
    modelId: "deepseek-r1-reasoner",
    cwd: "/opt/spaceapp/apps/web",
    version: "v1.18.2",
    transcript:
      `\x1b[38;5;75m◆\x1b[0m \x1b[1mOpenCode Interpreter\x1b[0m \x1b[2mv1.18.2\x1b[0m\r\n` +
      `\x1b[2mEngine: deepseek-reasoner · Session: opencode-401\x1b[0m\r\n` +
      `\x1b[2m/opt/spaceapp/apps/web\x1b[0m\r\n\r\n` +
      `\x1b[1m> optimize pane layout transitions and eliminate reflow during six-room cycling\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mAnalyzeAST\x1b[0m(src/features/room-manager/room-layout.tsx)\r\n` +
      `  \x1b[2m└ Evaluated 3 layout triggers in pane visibility observer\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mUpdate\x1b[0m(src/features/room-manager/room-layout.tsx)\r\n` +
      `  \x1b[2m└ Replaced timed parking with settled requestAnimationFrame sync\x1b[0m\r\n` +
      diffLine("-", 18, "container.style.gridTemplateColumns = calculateColumns(activePanes);") +
      diffLine("+", 18, "requestAnimationFrame(() => applyFixedLayoutBudget(container, 96));") +
      `\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mBash\x1b[0m(pnpm vitest run room-layout.test.ts)\r\n` +
      `  \x1b[2m└\x1b[0m \x1b[32m\x1b[1mPASS\x1b[0m \x1b[2mtests/room-layout.test.ts\x1b[0m\r\n` +
      `    \x1b[32m✓\x1b[0m \x1b[2mpane layout settled in <16ms (60fps)\x1b[0m\r\n` +
      `    \x1b[32m✓\x1b[0m \x1b[2msix-room 96-pane budget preserved\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 42s ――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Zero layout reflow detected during rapid room navigation.\r\n\r\n` +
      `\x1b[2m> Try "git status", or type help\x1b[0m\r\n` +
      `\x1b[2m128k context · mode: autonomous\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mdiff --git a/src/features/room-manager/room-layout.tsx b/src/features/room-manager/room-layout.tsx\x1b[0m\r\n` +
      diffLine("-", 18, "container.style.gridTemplateColumns = calculateColumns(activePanes);") +
      diffLine("+", 18, "requestAnimationFrame(() => applyFixedLayoutBudget(container, 96));"),
    testOutput:
      `\x1b[32m\x1b[1mPASS\x1b[0m tests/room-layout.test.ts (840ms)\r\n` +
      `  \x1b[32m✓\x1b[0m \x1b[2mpane layout settled in <16ms (60fps)\x1b[0m\r\n` +
      `  \x1b[32m✓\x1b[0m \x1b[2msix-room 96-pane budget preserved\x1b[0m\r\n` +
      `\x1b[32mTests: 2 passed, 2 total\x1b[0m`,
    help:
      `\x1b[1mOpenCode commands:\x1b[0m\r\n` +
      `  /help          Show interpreter options\r\n` +
      `  /mode          Toggle autonomous / supervised execution\r\n` +
      `  git diff       Show modified files\r\n` +
      `  clear          Clear the terminal viewport`,
    ls:
      `package.json  src/  tests/  public/  vite.config.ts  tsconfig.json`
  },

  "cli:gemini": {
    runtimeId: "cli:gemini",
    brand: "gemini",
    displayName: "Gemini CLI",
    model: "Gemini 3.8 Flash (High)",
    modelId: "gemini-3.8-flash",
    cwd: "/opt/spaceapp",
    version: "v3.8.0",
    transcript:
      `\x1b[38;5;39m✦\x1b[0m \x1b[1mGoogle Gemini CLI\x1b[0m \x1b[2mv3.8.0 (Antigravity Core)\x1b[0m\r\n` +
      `\x1b[2mModel: Gemini 3.8 Flash (High) · Multimodal Engine\x1b[0m\r\n` +
      `\x1b[2m/opt/spaceapp\x1b[0m\r\n\r\n` +
      `\x1b[1m> audit multimodal vision pipeline and streamline image attachment parsing\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mInspect\x1b[0m(src/runtime/vision-pipeline.ts)\r\n` +
      `  \x1b[2m└ Verified native embedded vision capability across Reasonix/DeepSeek runtimes\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mPatch\x1b[0m(src/runtime/vision-pipeline.ts)\r\n` +
      diffLine("-", 56, "return callMcpTool('vision', 'describe_image', { path });") +
      diffLine("+", 55, "if (model.hasNativeVision) return dispatchNativeVision(image);") +
      `\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mBenchmark\x1b[0m(vision throughput)\r\n` +
      `  \x1b[2m└ Native vision latency: 42ms (was 380ms via external MCP proxy)\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 29s ――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Native vision precedence enforced. Full parity with Codex CLI.\r\n\r\n` +
      `\x1b[2m> Try "/model", or type help\x1b[0m\r\n` +
      `\x1b[38;5;39m✦\x1b[0m \x1b[2m99.2% tokens remaining · Connected to Google AI Studio\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mdiff --git a/src/runtime/vision-pipeline.ts b/src/runtime/vision-pipeline.ts\x1b[0m\r\n` +
      diffLine("-", 56, "return callMcpTool('vision', 'describe_image', { path });") +
      diffLine("+", 55, "if (model.hasNativeVision) return dispatchNativeVision(image);"),
    testOutput:
      `\x1b[32m\x1b[1mPASS\x1b[0m tests/vision-pipeline.test.ts\r\n` +
      `  \x1b[32m✓\x1b[0m \x1b[2mnative vision decodes image in 42ms\x1b[0m\r\n` +
      `  \x1b[32m✓\x1b[0m \x1b[2mprecedence blocks unneeded MCP vision calls\x1b[0m\r\n` +
      `\x1b[32m2 passed, 2 total\x1b[0m`,
    help:
      `\x1b[1mGemini Antigravity slash commands:\x1b[0m\r\n` +
      `  /plan          Create an execution plan\r\n` +
      `  /model         Switch active Gemini model\r\n` +
      `  /learn         Record a verified operational pattern\r\n` +
      `  clear          Clear the active terminal buffer`,
    ls:
      `apps/  packages/  deploy/  docs/  scripts/  package.json  README.md`
  },

  "cli:autohand": {
    runtimeId: "cli:autohand",
    brand: "autohand",
    displayName: "Autohand Code CLI",
    model: "claude-3.5-sonnet:beta",
    modelId: "claude-3-5-sonnet",
    cwd: "/opt/spaceapp/backend",
    version: "v2.1.0",
    transcript:
      `\x1b[38;5;33m⚡\x1b[0m \x1b[1mAutohand Code\x1b[0m \x1b[2mv2.1.0 (OpenRouter Core)\x1b[0m\r\n` +
      `\x1b[2mModel: anthropic/claude-3.5-sonnet:beta · /opt/spaceapp/backend\x1b[0m\r\n\r\n` +
      `\x1b[1m> implement rate-limiting middleware using Redis token-bucket algorithm\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mCreate\x1b[0m(packages/server/middleware/token-bucket.ts)\r\n` +
      diffLine("+", 1, "export class TokenBucketLimiter {") +
      diffLine("+", 2, "  constructor(private redis: RedisClient, private capacity = 60) {}") +
      `\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mBash\x1b[0m(bun test token-bucket.test.ts)\r\n` +
      `  \x1b[2m└\x1b[0m \x1b[32m\x1b[1mPASS\x1b[0m \x1b[2m(6 tests in 42ms)\x1b[0m\r\n` +
      `    \x1b[32m✓\x1b[0m \x1b[2m100 burst requests throttled correctly at threshold\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 18s ――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Middleware wired into /api/v1/auth routes successfully.\r\n\r\n` +
      `\x1b[2m> Try "status", or type help\x1b[0m\r\n` +
      `\x1b[2mLatency: 280ms · Cost: $0.0034\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mdiff --git a/middleware/token-bucket.ts b/middleware/token-bucket.ts\x1b[0m\r\n` +
      diffLine("+", 1, "export class TokenBucketLimiter {") +
      diffLine("+", 2, "  constructor(private redis: RedisClient, private capacity = 60) {}") +
      diffLine("+", 3, "}"),
    testOutput:
      `\x1b[32m\x1b[1mbun test v1.2.0\x1b[0m\r\n` +
      `token-bucket.test.ts:\r\n` +
      `\x1b[32m✓\x1b[0m \x1b[2mrefills tokens at fixed rate\x1b[0m [4ms]\r\n` +
      `\x1b[32m✓\x1b[0m \x1b[2mthrottles burst traffic\x1b[0m [11ms]\r\n` +
      `\x1b[32m2 pass, 0 fail\x1b[0m`,
    help:
      `\x1b[1mAutohand Code options:\x1b[0m\r\n` +
      `  status         Check OpenRouter route latency and credits\r\n` +
      `  models         List available model endpoints\r\n` +
      `  clear          Clear the terminal viewport`,
    ls:
      `index.ts  routes/  middleware/  bun.lockb  package.json`
  },

  "cli:qwen": {
    runtimeId: "cli:qwen",
    brand: "qwen",
    displayName: "Qwen Code CLI",
    model: "Qwen2.5-Coder-32B-Instruct",
    modelId: "qwen-2.5-coder-32b",
    cwd: "/projects/ecommerce-core",
    version: "v2.5.8",
    transcript:
      `\x1b[38;5;135m✿\x1b[0m \x1b[1mQwen Code\x1b[0m \x1b[2mv2.5.8 (Alibaba Coding Plan)\x1b[0m\r\n` +
      `\x1b[2mModel: Qwen2.5-Coder-32B-Instruct · /projects/ecommerce-core\x1b[0m\r\n\r\n` +
      `\x1b[1m> optimize PostgreSQL partition pruning for high-concurrency order query\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mReadSchema\x1b[0m(db/migrations/20261001_orders_partition.sql)\r\n` +
      `  \x1b[2m└ Found unpruned sequential scan on orders table\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mUpdate\x1b[0m(src/models/order-query.ts)\r\n` +
      diffLine("-", 72, "SELECT * FROM orders WHERE created_at >= $1;") +
      diffLine("+", 72, "SELECT * FROM orders_y2026m10 WHERE created_at >= $1 AND tid = $2;") +
      `\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mBenchmark\x1b[0m(query execution)\r\n` +
      `  \x1b[2m└ Execution time: 142ms -> 4.2ms (33x throughput increase)\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 35s ――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Query plan confirmed: Index Scan on orders_2026_q4_idx.\r\n\r\n` +
      `\x1b[2m> Try "explain", or type help\x1b[0m\r\n` +
      `\x1b[2mQwen Code listening · 256k context\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mdiff --git a/src/models/order-query.ts b/src/models/order-query.ts\x1b[0m\r\n` +
      diffLine("-", 72, "SELECT * FROM orders WHERE created_at >= $1;") +
      diffLine("+", 72, "SELECT * FROM orders_y2026m10 WHERE created_at >= $1 AND tid = $2;"),
    testOutput:
      `\x1b[32m\x1b[1mPASS\x1b[0m test/order-query.spec.ts\r\n` +
      `  \x1b[32m✓\x1b[0m \x1b[2mprunes query partition accurately\x1b[0m (4.2 ms)\r\n` +
      `\x1b[32m1 passed\x1b[0m`,
    help:
      `\x1b[1mQwen Code commands:\x1b[0m\r\n` +
      `  explain        Explain SQL plan or AST structure\r\n` +
      `  refactor       Apply code transformation\r\n` +
      `  clear          Clear the viewport`,
    ls:
      `src/  db/  migrations/  docker-compose.yml  package.json`
  },

  "cli:kimi": {
    runtimeId: "cli:kimi",
    brand: "kimi",
    displayName: "Kimi Code CLI",
    model: "moonshot-v1-128k",
    modelId: "moonshot-v1-128k",
    cwd: "/opt/spaceapp/docs/analytics",
    version: "v1.6.0",
    transcript:
      `\x1b[38;5;45m◆\x1b[0m \x1b[1mKimi Code CLI\x1b[0m \x1b[2mv1.6.0 (Moonshot AI)\x1b[0m\r\n` +
      `\x1b[2mModel: moonshot-v1-128k · Long-Context Intelligence\x1b[0m\r\n` +
      `\x1b[2m/opt/spaceapp/docs/analytics\x1b[0m\r\n\r\n` +
      `\x1b[1m> summarize weekly operational metrics and generate cross-service health matrix\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mScanLogs\x1b[0m(/opt/spaceapp/var/logs/services/)\r\n` +
      `  \x1b[2m└ Ingested 1.2M lines across api, temporal, and nginx\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mSynthesize\x1b[0m(var/reports/health-matrix-2026-w40.json)\r\n` +
      `  \x1b[2m└ Health: 99.98% · P99 Latency: 48ms · Zero 5xx errors recorded\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 52s ――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Published report to Space Agent Files dock.\r\n\r\n` +
      `\x1b[2m> Try "/summary", or type help\x1b[0m\r\n` +
      `\x1b[2mMoonshot Context: 14.8k / 128k used\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mGenerated report artifact: health-matrix-2026-w40.json\x1b[0m\r\n` +
      `\x1b[32m+ Uptime: 99.98%\r\n+ P99 Latency: 48ms\r\n+ Error Rate: 0.00%\x1b[0m`,
    testOutput:
      `\x1b[32mLog audit verified. 1,248,102 entries validated with zero corrupt frames.\x1b[0m`,
    help:
      `\x1b[1mKimi CLI commands:\x1b[0m\r\n` +
      `  /file <path>   Ingest large context file\r\n` +
      `  /summary       Output executive briefing\r\n` +
      `  clear          Clear the screen`,
    ls:
      `health-matrix-2026-w40.json  service-metrics.tsv  analysis.md`
  },

  "cli:grok": {
    runtimeId: "cli:grok",
    brand: "grok",
    displayName: "Grok Build CLI",
    model: "grok-3-code",
    modelId: "grok-3-code",
    cwd: "/opt/spaceapp/apps/builder",
    version: "v2.0.4",
    transcript:
      `\x1b[38;5;231m✕\x1b[0m \x1b[1mGrok Build CLI\x1b[0m \x1b[2mv2.0.4 (xAI Engineering)\x1b[0m\r\n` +
      `\x1b[2mModel: grok-3-code · Low-Latency Compiler Suite\x1b[0m\r\n` +
      `\x1b[2m/opt/spaceapp/apps/builder\x1b[0m\r\n\r\n` +
      `\x1b[1m> build high-speed zero-copy IPC transport between worker threads and main loop\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mPatch\x1b[0m(src/native/shared_ring_buffer.rs)\r\n` +
      diffLine("+", 88, "let ring = SharedMemoryRing::attach('/dev/shm/space_ipc_0')?;") +
      diffLine("+", 89, "ring.push_zero_copy(&slice)?;") +
      `\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mCargo\x1b[0m(cargo build --release --locked)\r\n` +
      `  \x1b[2m└ Finished release [optimized] target(s) in 3.42s\x1b[0m\r\n` +
      `  \x1b[2m└ Throughput benchmark: 14.2 GB/sec at 1.8μs latency\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 21s ――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Zero-copy memory ring active. Ring buffer verified green.\r\n\r\n` +
      `\x1b[2m> Try "cargo test", or type help\x1b[0m\r\n` +
      `\x1b[2mEngine: grok-3 · Realtime compilation ready\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mdiff --git a/src/native/shared_ring_buffer.rs b/src/native/shared_ring_buffer.rs\x1b[0m\r\n` +
      diffLine("+", 88, "let ring = SharedMemoryRing::attach('/dev/shm/space_ipc_0')?;") +
      diffLine("+", 89, "ring.push_zero_copy(&slice)?;"),
    testOutput:
      `\x1b[32m\x1b[1mrunning 4 tests\x1b[0m\r\n` +
      `test ring_buffer::tests::test_concurrent_push ... \x1b[32mok\x1b[0m\r\n` +
      `test ring_buffer::tests::test_zero_copy_slice  ... \x1b[32mok\x1b[0m\r\n` +
      `\x1b[32mtest result: ok. 4 passed; 0 failed\x1b[0m`,
    help:
      `\x1b[1mGrok Build options:\x1b[0m\r\n` +
      `  cargo test     Run native Rust test suite\r\n` +
      `  bench          Run microbenchmarks\r\n` +
      `  clear          Clear terminal window`,
    ls:
      `Cargo.toml  Cargo.lock  src/  benches/  target/`
  },

  "cli:deepseek": {
    runtimeId: "cli:deepseek",
    brand: "deepseek",
    displayName: "DeepSeek CLI",
    model: "deepseek-r1-reasoner",
    modelId: "deepseek-r1-reasoner",
    cwd: "/opt/spaceapp/ai-engine",
    version: "v3.1",
    transcript:
      `\x1b[38;5;32m🐋\x1b[0m \x1b[1mDeepSeek Coder CLI\x1b[0m \x1b[2mv3.1\x1b[0m\r\n` +
      `\x1b[2mModel: deepseek-r1-reasoner (Full Reasoning Mode)\x1b[0m\r\n` +
      `\x1b[2m/opt/spaceapp/ai-engine\x1b[0m\r\n\r\n` +
      `\x1b[1m> deduce optimal KV-cache eviction policy under 4-bit quantization\x1b[0m\r\n\r\n` +
      `\x1b[38;5;246m● Chain-of-Thought Reasoning:\x1b[0m\r\n` +
      `  \x1b[2m├─ Analyze attention sparsity: 87% of heads exhibit diagonal concentration\x1b[0m\r\n` +
      `  \x1b[2m├─ Formulate PageRank score per token chunk to preserve long-range dependencies\x1b[0m\r\n` +
      `  \x1b[2m└─ Implement dynamic eviction threshold based on cumulative softmax mass\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mImplement\x1b[0m(src/inference/kv_cache_manager.py)\r\n` +
      `  \x1b[2m└ Perplexity test on 10k context: 4.12 (baseline: 4.11)\x1b[0m\r\n` +
      `  \x1b[2m└ VRAM savings: 4.2x reduction (fits 64k tokens on single 24GB card)\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 1m 14s ――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Math proof and benchmark confirmed. Code generated.\r\n\r\n` +
      `\x1b[2m> Try "reason", or type help\x1b[0m\r\n` +
      `\x1b[2mTokens: 4.1k/s · Temperature: 0.6\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mApplied KV-Cache policy update in src/inference/kv_cache_manager.py\x1b[0m\r\n` +
      diffLine("+", 45, "def evict_sparse_kv_chunks(tensor, threshold=0.01):") +
      diffLine("+", 46, "    mask = compute_pagerank_weights(tensor) > threshold") +
      diffLine("+", 47, "    return tensor[mask]"),
    testOutput:
      `\x1b[32mPerplexity benchmark: 4.12 across 10,000 token evaluation dataset (PASS)\x1b[0m`,
    help:
      `\x1b[1mDeepSeek CLI options:\x1b[0m\r\n` +
      `  reason         Display full Chain-of-Thought trace\r\n` +
      `  benchmark      Run FP8/INT4 quantization checks\r\n` +
      `  clear          Clear the terminal screen`,
    ls:
      `kv_cache_manager.py  inference.py  quantize.py  requirements.txt`
  },

  "cli:cursor": {
    runtimeId: "cli:cursor",
    brand: "cursor",
    displayName: "Cursor CLI",
    model: "claude-3-5-sonnet",
    modelId: "claude-3-5-sonnet",
    cwd: "/workspace/space-web",
    version: "v0.42.0",
    transcript:
      `\x1b[38;5;255m▶\x1b[0m \x1b[1mCursor Agent CLI\x1b[0m \x1b[2mv0.42.0\x1b[0m\r\n` +
      `\x1b[2mModel: claude-3-5-sonnet · Index: 14,208 symbols indexed\x1b[0m\r\n` +
      `\x1b[2m/workspace/space-web\x1b[0m\r\n\r\n` +
      `\x1b[1m> refactor state management to atomic jotai atoms in features/dock\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mSearchCodebase\x1b[0m(usages of useWorkspaceStore in src/features/dock/)\r\n` +
      `  \x1b[2m└ Located 19 references across 7 component files\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mRefactor\x1b[0m(src/features/dock/dock-state.ts)\r\n` +
      diffLine("-", 12, "export const [useDockState] = createStore({...});") +
      diffLine("+", 12, "export const dockActiveItemAtom = atom<string | null>(null);") +
      diffLine("+", 13, "export const dockCollapsedAtom = atom(false);") +
      `\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mCompile\x1b[0m(tsc --noEmit)\r\n` +
      `  \x1b[2m└ 0 errors, 0 warnings. Vite HMR reloaded in 48ms.\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 26s ――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m All 7 files updated cleanly with atomic subscriptions.\r\n\r\n` +
      `\x1b[2m> Try "git diff", or type help\x1b[0m\r\n` +
      `\x1b[2mIndex up to date · 100% synchronized\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mdiff --git a/src/features/dock/dock-state.ts b/src/features/dock/dock-state.ts\x1b[0m\r\n` +
      diffLine("-", 12, "export const [useDockState] = createStore({...});") +
      diffLine("+", 12, "export const dockActiveItemAtom = atom<string | null>(null);") +
      diffLine("+", 13, "export const dockCollapsedAtom = atom(false);"),
    testOutput:
      `\x1b[32m\x1b[1m✓ TypeScript typecheck passed: 0 errors in 14,208 files\x1b[0m`,
    help:
      `\x1b[1mCursor Agent commands:\x1b[0m\r\n` +
      `  git diff       Review semantic code modifications\r\n` +
      `  index          Check symbol indexing status\r\n` +
      `  clear          Clear the terminal viewport`,
    ls:
      `src/  features/  components/  package.json  vite.config.ts`
  },

  "cli:copilot": {
    runtimeId: "cli:copilot",
    brand: "copilot",
    displayName: "GitHub Copilot CLI",
    model: "gpt-5-copilot",
    modelId: "gpt-5-copilot",
    cwd: "/opt/spaceapp",
    version: "v1.0.8",
    transcript:
      `\x1b[38;5;141m🐙\x1b[0m \x1b[1mGitHub Copilot CLI\x1b[0m \x1b[2mv1.0.8\x1b[0m\r\n` +
      `\x1b[2mAuth: github.com/operator · spaceapp/core\x1b[0m\r\n\r\n` +
      `\x1b[1m> generate GitHub Actions matrix workflow for multiplatform release binaries\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mGenerate\x1b[0m(.github/workflows/multiplatform-release.yml)\r\n` +
      diffLine("+", 1, "name: Multiplatform Release") +
      diffLine("+", 2, "on: { push: { tags: ['v*.*.*'] } }") +
      diffLine("+", 3, "jobs: { build: { strategy: { matrix: { os: [linux, win, mac] } } }") +
      `\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mValidate\x1b[0m(actionlint)\r\n` +
      `  \x1b[2m└ Checked schema against GitHub Actions API: valid\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 16s ――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Workflow template created. Tag triggers ready.\r\n\r\n` +
      `\x1b[2m> Try "gh copilot explain", or type help\x1b[0m\r\n` +
      `\x1b[2mModel: GPT-5 Copilot Preview\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mGenerated .github/workflows/multiplatform-release.yml\x1b[0m\r\n` +
      diffLine("+", 1, "name: Multiplatform Release") +
      diffLine("+", 2, "jobs: { build: { runs-on: ubuntu-latest } }"),
    testOutput:
      `\x1b[32mactionlint: 0 errors found in .github/workflows/\x1b[0m`,
    help:
      `\x1b[1mGitHub Copilot CLI options:\x1b[0m\r\n` +
      `  gh copilot suggest   Get command suggestions\r\n` +
      `  gh copilot explain   Explain command arguments\r\n` +
      `  clear                Clear screen`,
    ls:
      `.github/  package.json  apps/  packages/  LICENSE`
  },

  "cli:hermes": {
    runtimeId: "cli:hermes",
    brand: "hermes",
    displayName: "Hermes Agent CLI",
    model: "hermes-3-llama-3.1-405b",
    modelId: "hermes-3",
    cwd: "/opt/spaceapp/var/missions",
    version: "v2.8.1",
    transcript:
      `\x1b[38;5;214m☤\x1b[0m \x1b[1mHermes Agent CLI\x1b[0m \x1b[2mv2.8.1 (Autonomous Worker)\x1b[0m\r\n` +
      `\x1b[2mDispatch: Mission #401 · /opt/spaceapp/var/missions\x1b[0m\r\n\r\n` +
      `\x1b[1m> orchestrate background database vacuum and sync replication status\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mExecute\x1b[0m(VACUUM ANALYZE VERBOSE)\r\n` +
      `  \x1b[2m└ Reclaimed 142 MB free pages, updated planner statistics\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mCheckReplication\x1b[0m(replica @ 192.0.2.3)\r\n` +
      `  \x1b[2m└ Replication lag: 0 bytes (streaming in sync)\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 38s ――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Maintenance completed. Audit log mission-401.log recorded.\r\n\r\n` +
      `\x1b[2m> Try "mission status", or type help\x1b[0m\r\n` +
      `\x1b[2mWorker: IDLE · Heartbeat: OK\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mRecorded audit event in var/missions/mission-401.log\x1b[0m\r\n` +
      `\x1b[32m+ 2026-10-02T08:20:00Z [INFO] VACUUM ANALYZE completed on 42 relations\x1b[0m`,
    testOutput:
      `\x1b[32mPostgreSQL cluster health: OK (connections: 18/200, lag: 0 bytes)\x1b[0m`,
    help:
      `\x1b[1mHermes Agent commands:\x1b[0m\r\n` +
      `  mission status Check running daemon jobs\r\n` +
      `  mission queue  Inspect pending queue\r\n` +
      `  clear          Clear the viewport`,
    ls:
      `mission-401.log  dispatch-queue.db  hermes-worker.sock`
  },

  "cli:omp": {
    runtimeId: "cli:omp",
    brand: "omp",
    displayName: "Oh My Pi CLI",
    model: "pi-embedded-llm",
    modelId: "pi-embedded",
    cwd: "/home/pi",
    version: "v3.3.4",
    transcript:
      `\x1b[38;5;196mπ\x1b[0m \x1b[1mOh My Pi CLI\x1b[0m \x1b[2mv3.3.4 (Embedded & Edge)\x1b[0m\r\n` +
      `\x1b[2mHardware: Raspberry Pi 5 / RK3588 (ARM64) · Node #03\x1b[0m\r\n\r\n` +
      `\x1b[1m> tune GPIO interrupt frequency and check hardware PWM fan controller\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mReadSensor\x1b[0m(/sys/class/thermal/thermal_zone0/temp)\r\n` +
      `  \x1b[2m└ Core temperature: 39.2°C · Fan speed: 1,450 RPM\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mApplySysctl\x1b[0m(/etc/sysctl.d/99-edge-lowlatency.conf)\r\n` +
      `  \x1b[2m└ fs.file-max = 2097152 · net.core.rmem_max = 16777216\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 12s ――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Hardware diagnostics: All 40 pins OK. Interrupt latency < 12μs.\r\n\r\n` +
      `\x1b[2m> Try "pimon", or type help\x1b[0m\r\n` +
      `\x1b[2mCPU: 39°C · RAM: 1.2/8GB · Uptime: 42d 18h\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1m/etc/sysctl.d/99-edge-lowlatency.conf\x1b[0m\r\n` +
      diffLine("+", 1, "fs.file-max = 2097152") +
      diffLine("+", 2, "net.core.rmem_max = 16777216"),
    testOutput:
      `\x1b[32mGPIO Pin Diagnostics: 40/40 pins nominal. PWM frequency: 25kHz.\x1b[0m`,
    help:
      `\x1b[1mOh My Pi commands:\x1b[0m\r\n` +
      `  pimon          Open hardware telemetry monitor\r\n` +
      `  gpio readall   Dump current pin states\r\n` +
      `  clear          Clear the terminal`,
    ls:
      `scripts/  sysctl.d/  firmware/  pin-config.json`
  },

  "cli:qoder": {
    runtimeId: "cli:qoder",
    brand: "qoder",
    displayName: "Qoder CLI",
    model: "qoder-engine-v2",
    modelId: "qoder-engine-v2",
    cwd: "/opt/spaceapp",
    version: "v1.2.0",
    transcript:
      `\x1b[38;5;81m⚙\x1b[0m \x1b[1mQoder CLI\x1b[0m \x1b[2mv1.2.0 (Code Intelligence Engine)\x1b[0m\r\n` +
      `\x1b[2mLanguage Server: TypeScript 5.7 / Rust 1.84 · /opt/spaceapp\x1b[0m\r\n\r\n` +
      `\x1b[1m> find cyclic dependencies and calculate module coupling score\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mDependencyGraph\x1b[0m(412 internal modules)\r\n` +
      `  \x1b[2m└ Cycles detected: 0 · Maximum dependency depth: 6\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mCouplingMetric\x1b[0m(module fan-in / fan-out)\r\n` +
      `  \x1b[2m└ @space/contracts: fan-in 98 · live-api: fan-in 84\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 24s ――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Architectural boundary validated. Zero cyclic locks.\r\n\r\n` +
      `\x1b[2m> Try "graph --export", or type help\x1b[0m\r\n` +
      `\x1b[2mLSP status: healthy · Memory: 82MB\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mModule Dependency Report\x1b[0m\r\n` +
      `\x1b[32m✓ 412 modules analyzed\r\n✓ 0 circular dependencies\r\n✓ Clean architecture verified\x1b[0m`,
    testOutput:
      `\x1b[32mDependency tree check passed: No prohibited imports between tiers.\x1b[0m`,
    help:
      `\x1b[1mQoder CLI commands:\x1b[0m\r\n` +
      `  graph --export Export module dependency DOT graph\r\n` +
      `  symbols        Search index across workspace\r\n` +
      `  clear          Clear screen`,
    ls:
      `apps/  packages/  tsconfig.base.json  pnpm-workspace.yaml`
  },

  "cli:muse": {
    runtimeId: "cli:muse",
    brand: "muse",
    displayName: "Muse Code CLI",
    model: "muse-audio-v1",
    modelId: "muse-audio-v1",
    cwd: "/opt/spaceapp/media",
    version: "v0.9.1",
    transcript:
      `\x1b[38;5;177m♪\x1b[0m \x1b[1mMuse Code CLI\x1b[0m \x1b[2mv0.9.1 (Creative Synthesis & Audio)\x1b[0m\r\n` +
      `\x1b[2mDSP Engine: WebAudio / WebAssembly · Latency: 4.8ms\x1b[0m\r\n\r\n` +
      `\x1b[1m> generate adaptive ambient soundtrack for Space workspace focus mode\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mSynthesize\x1b[0m(binaural generator 432Hz root, 60BPM pulse)\r\n` +
      `  \x1b[2m└ Stereo 48,000Hz · Bitrate: 320kbps\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mExport\x1b[0m(demo/media/space-loop-focus.mp3)\r\n` +
      `  \x1b[2m└ 60-second seamless looping audio rendered\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 19s ――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Audio track ready. Integrated into YouTube / Media player.\r\n\r\n` +
      `\x1b[2m> Try "play", or type help\x1b[0m\r\n` +
      `\x1b[2mAudio engine: WebAssembly SIMD active\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mExported Audio Track: demo/media/space-loop-focus.mp3\x1b[0m\r\n` +
      `\x1b[32m+ Duration: 60.00s (looping)\r\n+ Codec: MP3 320kbps 48kHz\x1b[0m`,
    testOutput:
      `\x1b[32mSeamless loop check: Cross-correlation score 0.998 (Zero click artifact)\x1b[0m`,
    help:
      `\x1b[1mMuse CLI commands:\x1b[0m\r\n` +
      `  play           Start audio preview playback\r\n` +
      `  mix            Adjust synthesizer layers\r\n` +
      `  clear          Clear the terminal viewport`,
    ls:
      `space-loop-focus.mp3  synthesizer.wasm  dsp-preset.json`
  },

  "cli:droid": {
    runtimeId: "cli:droid",
    brand: "droid",
    displayName: "Droid CLI",
    model: "factory-droid-v4",
    modelId: "factory-droid-v4",
    cwd: "/var/droid/mesh",
    version: "v4.0.0",
    transcript:
      `\x1b[38;5;82m🤖\x1b[0m \x1b[1mDroid CLI\x1b[0m \x1b[2mv4.0.0 (Factory Robotics & Device Fabric)\x1b[0m\r\n` +
      `\x1b[2mMesh: 12 Virtual Nodes · Container Sandbox\x1b[0m\r\n\r\n` +
      `\x1b[1m> provision isolated container sandbox and verify network namespace isolation\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mCGroup\x1b[0m(/sys/fs/cgroup/droid-sandbox-01)\r\n` +
      `  \x1b[2m└ CPU quota: 200% (2 cores) · Memory cap: 1024 MB\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m \x1b[1mNetworkVeth\x1b[0m(veth_host0 <-> veth_droid0, IP: 10.99.1.14)\r\n` +
      `  \x1b[2m└ Ping test to bridge: 0.08ms RTT (isolated subnet)\x1b[0m\r\n\r\n` +
      `\x1b[2m― Worked for 31s ――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[37m●\x1b[0m Sandbox verified. Non-root UID 10001, drop-capabilities enforced.\r\n\r\n` +
      `\x1b[2m> Try "nodes", or type help\x1b[0m\r\n` +
      `\x1b[2mNodes: 12 online · Mesh health: 100%\x1b[0m\r\n` +
      `> `,
    diff:
      `\x1b[1mProvisioned sandbox configuration: /etc/droid/sandboxes/droid-01.json\x1b[0m\r\n` +
      diffLine("+", 1, "{\"uid\": 10001, \"isolation\": \"cgroup_v2\", \"cap_drop\": [\"ALL\"]}"),
    testOutput:
      `\x1b[32mNetwork isolation verified: Zero leaked sockets to host network.\x1b[0m`,
    help:
      `\x1b[1mDroid CLI commands:\x1b[0m\r\n` +
      `  nodes          List active mesh node containers\r\n` +
      `  sandbox test   Run security isolation benchmark\r\n` +
      `  clear          Clear the terminal viewport`,
    ls:
      `droid-01.json  mesh-status.json  veth-mapping.tsv`
  },

  "cli:root": {
    runtimeId: "cli:root",
    brand: "root",
    displayName: "Root CLI",
    model: "system-shell",
    modelId: "root-bash",
    cwd: "/root",
    version: "v6.8.12",
    transcript:
      `\x1b[1m# Root Maintenance Shell\x1b[0m \x1b[2m(Simulated public-host environment)\x1b[0m\r\n` +
      `\x1b[2mLinux space-vm207 6.8.12-1-pve #1 SMP PREEMPT_DYNAMIC\x1b[0m\r\n\r\n` +
      `\x1b[1m# systemctl status space-backend --no-pager\x1b[0m\r\n\r\n` +
      `\x1b[32m●\x1b[0m space-backend.service - Space Platform Agent Backend\r\n` +
      `   \x1b[2mLoaded: loaded (/etc/systemd/system/space-backend.service; enabled)\x1b[0m\r\n` +
      `   \x1b[32mActive: active (running)\x1b[0m \x1b[2msince Wed 2026-10-01 12:00:00 UTC\x1b[0m\r\n` +
      `   \x1b[2mMain PID: 1042 (node) · Tasks: 24 · Memory: 184.2M\x1b[0m\r\n\r\n` +
      `\x1b[2m― Status OK ―――――――――――――――――――――――――――――――――――――――――――――――――――――\x1b[0m\r\n\r\n` +
      `\x1b[2m# Type commands or 'help'\x1b[0m\r\n` +
      `# `,
    diff:
      `\x1b[1mActive services: space-backend (running), nginx (running), postgresql (running)\x1b[0m`,
    testOutput:
      `\x1b[32mAll core systemd units operating normally.\x1b[0m`,
    help:
      `\x1b[1mRoot Shell Commands:\x1b[0m\r\n` +
      `  systemctl status <service>\r\n` +
      `  uptime\r\n` +
      `  clear`,
    ls:
      `.ssh/  .secrets/  space/  scripts/`
  }
};

export function getCliMockDefinition(runtimeId: string | null | undefined): CliMockDefinition {
  const normalized = (runtimeId ?? "cli:codex").startsWith("cli:")
    ? (runtimeId ?? "cli:codex")
    : `cli:${runtimeId ?? "codex"}`;
  return CLI_MOCK_DEFINITIONS[normalized] ?? CLI_MOCK_DEFINITIONS["cli:codex"]!;
}

export function getCliMockTranscript(runtimeId: string | null | undefined): string {
  return getCliMockDefinition(runtimeId).transcript;
}

export function getCliMockModel(runtimeId: string | null | undefined): string {
  return getCliMockDefinition(runtimeId).modelId;
}

export function getCliMockCwd(runtimeId: string | null | undefined): string {
  return getCliMockDefinition(runtimeId).cwd;
}

export function handleCliMockInput(runtimeId: string | null | undefined, rawCommand: string): string {
  const def = getCliMockDefinition(runtimeId);
  const command = rawCommand.trim();
  if (!command) return "\r\n> ";

  if (command === "clear") {
    return "\x1b[2J\x1b[H> ";
  }
  if (command === "help" || command === "?" || command === "--help" || command === "-h") {
    return `\r\n${def.help}\r\n\r\n> `;
  }
  if (command === "git diff" || command === "diff") {
    return `\r\n${def.diff}\r\n\r\n> `;
  }
  if (
    command === "npm test" ||
    command === "test" ||
    command === "pnpm test" ||
    command === "bun test" ||
    command === "cargo test" ||
    command === "pytest"
  ) {
    return `\r\n${def.testOutput}\r\n\r\n> `;
  }
  if (command === "ls" || command === "dir" || command === "ll") {
    return `\r\n${def.ls}\r\n\r\n> `;
  }
  if (command === "status") {
    return `\r\n\x1b[32m●\x1b[0m \x1b[1m${def.displayName}\x1b[0m (${def.model})\r\n` +
      `  \x1b[2mCWD: ${def.cwd}\x1b[0m\r\n` +
      `  \x1b[32m✓\x1b[0m \x1b[2mStatus: READY · Local simulated environment\x1b[0m\r\n\r\n> `;
  }

  // Simulated AI response for any other command
  return (
    `\r\nReceived: ${command}\r\n` +
    `\x1b[32m●\x1b[0m \x1b[1mAnalyzing workspace for:\x1b[0m ${command}\r\n` +
    `  \x1b[2m└ Scanning symbols in ${def.cwd}...\x1b[0m\r\n` +
    `\x1b[32m●\x1b[0m \x1b[1mExecuted simulated task step\x1b[0m \x1b[2m(0 errors, 0 warnings)\x1b[0m\r\n` +
    `\x1b[37m●\x1b[0m Completed in 0.36s.\r\n\r\n> `
  );
}

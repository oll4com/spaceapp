export const DEV_STACK_STATE_DIR = ".dev-stack";
export const DEV_STACK_PROJECT_NAME = "spaceapp-dev-stack";
export const DEV_STACK_BIND_HOST = "127.0.0.1";

export const DEFAULT_DEV_STACK_PORTS = {
  api: 4912,
  web: 4913,
  postgres: 5433,
  temporal: 7234,
};

export const DEV_STACK_PORT_ENV_VARS = {
  api: "SPACE_DEV_STACK_API_PORT",
  web: "SPACE_DEV_STACK_WEB_PORT",
  postgres: "SPACE_DEV_STACK_POSTGRES_PORT",
  temporal: "SPACE_DEV_STACK_TEMPORAL_PORT",
};

export const DEV_STACK_POSTGRES_IMAGE =
  "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b";

export const DEV_STACK_TEMPORAL_IMAGE =
  "temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312";

const MIN_PORT = 1;
const MAX_PORT = 65535;

function parsePort(value, fallback) {
  if (typeof value !== "string" && typeof value !== "number") {
    return fallback;
  }
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) {
    return fallback;
  }
  const port = Number.parseInt(text, 10);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    return fallback;
  }
  return port;
}

export function resolveDevStackPorts(env = process.env) {
  const ports = {};
  for (const key of Object.keys(DEFAULT_DEV_STACK_PORTS)) {
    const raw = env[DEV_STACK_PORT_ENV_VARS[key]];
    ports[key] = parsePort(raw, DEFAULT_DEV_STACK_PORTS[key]);
  }
  return ports;
}

export function devStackPortMappings(ports) {
  return [
    `${DEV_STACK_BIND_HOST}:${ports.postgres}:5432`,
    `${DEV_STACK_BIND_HOST}:${ports.temporal}:7233`,
  ];
}

export function buildDevStackComposeYaml({
  ports,
  postgresImage = DEV_STACK_POSTGRES_IMAGE,
  temporalImage = DEV_STACK_TEMPORAL_IMAGE,
  projectName = DEV_STACK_PROJECT_NAME,
}) {
  const [postgresMapping, temporalMapping] = devStackPortMappings(ports);

  return [
    `name: ${projectName}`,
    "",
    "services:",
    "  postgres:",
    `    image: ${postgresImage}`,
    "    ports:",
    `      - "${postgresMapping}"`,
    "    environment:",
    "      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password",
    "    secrets:",
    "      - postgres-password",
    "    volumes:",
    "      - postgres-data:/var/lib/postgresql/data",
    "    healthcheck:",
    '      test: ["CMD-SHELL", "pg_isready -U postgres"]',
    "      interval: 5s",
    "      timeout: 5s",
    "      retries: 20",
    "  temporal:",
    `    image: ${temporalImage}`,
    "    environment:",
    "      DB: postgres12",
    "      DB_PORT: 5432",
    "      POSTGRES_USER: postgres",
    "      POSTGRES_SEEDS: postgres",
    "      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password",
    '    entrypoint: ["/bin/sh", "-ec"]',
    "    command:",
    "      - 'export POSTGRES_PWD=\"$$(cat /run/secrets/postgres-password)\"; exec /etc/temporal/entrypoint.sh autosetup'",
    "    secrets:",
    "      - postgres-password",
    "    ports:",
    `      - "${temporalMapping}"`,
    "    depends_on:",
    "      postgres:",
    "        condition: service_healthy",
    "    healthcheck:",
    '      test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233"]',
    "      interval: 5s",
    "      timeout: 5s",
    "      retries: 20",
    "",
    "secrets:",
    "  postgres-password:",
    "    file: ./secrets/postgres-password",
    "",
    "volumes:",
    "  postgres-data:",
    "",
  ].join("\n");
}

export function parseComposeServiceImage(composeText, serviceName) {
  const lines = composeText.split(/\r?\n/);
  const header = `  ${serviceName}:`;
  const start = lines.indexOf(header);
  if (start === -1) {
    return null;
  }

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== "" && !line.startsWith("    ")) {
      break;
    }
    const match = /^ {4}image:\s*(\S.*)$/.exec(line);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

// The Dockerfile pins the OpenCode CLI as an npm package spec. OpenCode 2
// ships as @opencode/cli; older pins used the opencode-ai package. Accept
// either so the dev stack always installs exactly what the Dockerfile pins.
const OPENCODE_PACKAGE_PATTERN =
  /(@opencode\/cli|opencode-ai)@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/;

export function parseOpencodePackage(dockerfileText) {
  const match = OPENCODE_PACKAGE_PATTERN.exec(dockerfileText);
  return match ? `${match[1]}@${match[2]}` : null;
}

export function parseOpencodeVersion(dockerfileText) {
  const match = OPENCODE_PACKAGE_PATTERN.exec(dockerfileText);
  return match ? match[2] : null;
}

export function devStackChildProcessEnv(ports) {
  return {
    api: {
      SPACE_API_PORT: String(ports.api),
    },
    web: {
      SPACE_WEB_HOST: DEV_STACK_BIND_HOST,
      SPACE_WEB_PORT: String(ports.web),
      SPACE_API_PORT: String(ports.api),
    },
  };
}

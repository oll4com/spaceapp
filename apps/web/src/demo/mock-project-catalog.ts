// Generated from the canonical Demo Projects definitions.
export const mockProjectCatalog = {
  "projects": [
    {
      "id": "project-1-salesforce-crm",
      "index": 1,
      "name": "Project 1 — Salesforce CRM",
      "summary": "Salesforce Accounts and Contacts with Google Sheets synchronisation.",
      "description": "Creates a real Account and its linked Contact through the Salesforce API, lists existing Accounts with pagination and search, and appends one Google Sheets row per created record. Live mode uses the Space connectors; Sample mode runs with synthetic data and never touches an external service.",
      "variantIds": [
        "javascript-react-node",
        "typescript-react-node"
      ],
      "requiresConnections": [
        "salesforce",
        "google-sheets"
      ]
    },
    {
      "id": "project-2-crud-playground",
      "index": 2,
      "name": "Project 2 — CRUD Playground",
      "summary": "Small task list with create, status change and delete.",
      "description": "Isolated CRUD demo used to prove run lifecycle, preview, logs and variant switching without any external dependency. Every write stays inside the run workspace.",
      "variantIds": [
        "javascript-react-node",
        "typescript-react-node"
      ],
      "requiresConnections": []
    }
  ],
  "variants": [
    {
      "id": "javascript-react-node",
      "projectId": "project-1-salesforce-crm",
      "language": "javascript",
      "label": "JavaScript · React · Node.js",
      "stack": [
        "JavaScript",
        "React",
        "Node.js"
      ],
      "supportsLive": true,
      "available": true,
      "unavailableReason": null
    },
    {
      "id": "typescript-react-node",
      "projectId": "project-1-salesforce-crm",
      "language": "typescript",
      "label": "TypeScript · React · Node.js",
      "stack": [
        "TypeScript",
        "React",
        "Node.js"
      ],
      "supportsLive": true,
      "available": true,
      "unavailableReason": null
    },
    {
      "id": "javascript-react-node",
      "projectId": "project-2-crud-playground",
      "language": "javascript",
      "label": "JavaScript · React · Node.js",
      "stack": [
        "JavaScript",
        "React",
        "Node.js"
      ],
      "supportsLive": true,
      "available": true,
      "unavailableReason": null
    },
    {
      "id": "typescript-react-node",
      "projectId": "project-2-crud-playground",
      "language": "typescript",
      "label": "TypeScript · React · Node.js",
      "stack": [
        "TypeScript",
        "React",
        "Node.js"
      ],
      "supportsLive": true,
      "available": true,
      "unavailableReason": null
    }
  ]
} as const;

// AUTO-GENERATED from contracts/schemas by scripts/gen.mjs. Do not edit by hand.

export const appConfigSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://lattice.dev/schemas/app-config.json",
  "title": "AppConfig",
  "description": "Public, non-secret configuration served by GET /v1/config. Never add secrets here.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "version",
    "tenant_id",
    "backend_url",
    "realtime_url",
    "app_key",
    "schema_version",
    "min_client_version",
    "features",
    "collections"
  ],
  "properties": {
    "version": {
      "type": "integer",
      "const": 1,
      "description": "Version of this config format."
    },
    "tenant_id": {
      "type": "string",
      "minLength": 1
    },
    "backend_url": {
      "type": "string",
      "format": "uri",
      "pattern": "^https?://[^/\\s?#]+(?:/[^\\s?#]*)?$",
      "description": "Stable tenant hostname, never an instance address."
    },
    "realtime_url": {
      "type": "string",
      "format": "uri",
      "pattern": "^https?://[^/\\s?#]+(?:/[^\\s?#]*)?$",
      "description": "PocketBase realtime (SSE) endpoint."
    },
    "app_key": {
      "type": "string",
      "minLength": 1,
      "description": "Publishable key. Not a secret."
    },
    "schema_version": {
      "type": "string",
      "minLength": 1
    },
    "min_client_version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Oldest client version this backend supports."
    },
    "features": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "collections": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1
      }
    }
  }
} as const;

export const featuresSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://lattice.dev/schemas/features.json",
  "title": "Features",
  "description": "Per-tenant feature flags served by authenticated GET /v1/features. Options must never contain secrets.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "features"
  ],
  "properties": {
    "features": {
      "type": "object",
      "propertyNames": {
        "pattern": "^[a-z][a-z0-9_-]{0,48}$"
      },
      "additionalProperties": {
        "$ref": "#/$defs/Feature"
      }
    }
  },
  "$defs": {
    "Feature": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "enabled"
      ],
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "options": {
          "type": "object",
          "additionalProperties": true
        }
      }
    }
  }
} as const;

export const dashboardLayoutSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://lattice.dev/schemas/dashboard-layout.json",
  "title": "DashboardLayout",
  "description": "Server-driven dashboard layout. Every platform renders the same widget types.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "name",
    "layout"
  ],
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "layout": {
      "type": "array",
      "maxItems": 100,
      "items": {
        "$ref": "#/$defs/Widget"
      }
    }
  },
  "$defs": {
    "Widget": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "type",
        "collection",
        "x",
        "y",
        "w",
        "h"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "type": {
          "enum": [
            "table",
            "chart",
            "kpi",
            "form",
            "list"
          ]
        },
        "collection": {
          "type": "string",
          "pattern": "^[a-zA-Z_][a-zA-Z0-9_]*$"
        },
        "x": {
          "type": "integer",
          "minimum": 0
        },
        "y": {
          "type": "integer",
          "minimum": 0
        },
        "w": {
          "type": "integer",
          "minimum": 1,
          "maximum": 12
        },
        "h": {
          "type": "integer",
          "minimum": 1
        },
        "props": {
          "$ref": "#/$defs/WidgetProps"
        }
      }
    },
    "WidgetProps": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "filter": {
          "type": "string",
          "maxLength": 500,
          "description": "PocketBase filter with {:name} placeholders bound from params."
        },
        "params": {
          "type": "object",
          "additionalProperties": {
            "type": [
              "string",
              "number",
              "boolean"
            ]
          }
        },
        "sort": {
          "type": "string",
          "pattern": "^-?[a-zA-Z_][a-zA-Z0-9_.]*(,-?[a-zA-Z_][a-zA-Z0-9_.]*)*$"
        },
        "metric": {
          "type": "string",
          "pattern": "^(count|(sum|avg|min|max):[a-zA-Z_][a-zA-Z0-9_]*)$"
        },
        "groupBy": {
          "type": "string",
          "pattern": "^[a-zA-Z_][a-zA-Z0-9_]*(:(day|week|month|year))?$"
        },
        "fields": {
          "type": "array",
          "maxItems": 50,
          "items": {
            "type": "string",
            "pattern": "^[a-zA-Z_][a-zA-Z0-9_.]*$"
          }
        }
      }
    }
  }
} as const;

export const pluginManifestSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://lattice.dev/schemas/plugin-manifest.json",
  "title": "PluginManifest",
  "description": "Manifest every plugin ships with. Checked by the registry at startup.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name",
    "version",
    "interface_version",
    "license"
  ],
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,48}$"
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$"
    },
    "interface_version": {
      "type": "integer",
      "minimum": 1,
      "description": "Version of the plugin interface this plugin implements."
    },
    "license": {
      "type": "string",
      "minLength": 1
    },
    "requires": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "permissions": {
      "type": "array",
      "uniqueItems": true,
      "items": {
        "type": "string",
        "pattern": "^[a-z_]+:[a-z0-9_*]+$"
      }
    }
  }
} as const;

export const eventEnvelopeSchema = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://lattice.dev/schemas/events/envelope.json",
  "title": "EventEnvelope",
  "description": "Envelope for every event/webhook payload. Always versioned.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "type",
    "version",
    "occurred_at",
    "tenant_id",
    "data"
  ],
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1,
      "description": "Unique event id (use as idempotency key)."
    },
    "type": {
      "type": "string",
      "pattern": "^[a-z_]+(\\.[a-z_]+)+$",
      "description": "e.g. payment.succeeded"
    },
    "version": {
      "type": "integer",
      "minimum": 1
    },
    "occurred_at": {
      "type": "string",
      "format": "date-time",
      "description": "RFC 3339 timestamp."
    },
    "tenant_id": {
      "type": "string",
      "minLength": 1
    },
    "data": {
      "type": "object",
      "additionalProperties": true
    }
  }
} as const;

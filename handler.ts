import type { StartTaskMessage, TaskContext, HandlerResult } from '@blocks-network/sdk';

/**
 * Rule-based troubleshooter for API and SaaS error reports.
 * No model calls. Classifies the first request part with keyword rules.
 */
export default async function handler(
  task: StartTaskMessage,
  ctx?: TaskContext,
): Promise<HandlerResult> {
  const raw = task.requestParts?.[0]?.text ?? '';
  const text = unwrapTextField(raw);

  ctx?.reportStatus('Classifying error report...');

  return {
    artifacts: [
      {
        data: troubleshoot(text),
        mimeType: 'text/plain',
        outputId: 'result',
      },
    ],
  };
}

type Category =
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'vendor'
  | 'timeout'
  | 'cors'
  | 'body'
  | 'unknown';

type Sections = {
  summary: string;
  cause: string;
  checks: string[];
  next: string;
};

function unwrapTextField(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return raw;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const text = textField(parsed);
    if (text !== undefined) return text;
  } catch {
    // Plain text that starts with "{", not a JSON object.
  }
  return raw;
}

function textField(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.text === 'string' ? record.text : undefined;
}

function troubleshoot(input: string): string {
  const text = input.trim();
  if (!text) return render(emptySections());
  const lowered = text.toLowerCase();
  return render(sectionsFor(classify(lowered), lowered));
}

function classify(text: string): Category {
  if (isRateLimit(text)) return 'rate_limit';
  if (isAuth(text)) return 'auth';
  if (isNotFound(text)) return 'not_found';
  if (isVendor(text)) return 'vendor';
  if (isTimeout(text)) return 'timeout';
  if (isCors(text)) return 'cors';
  if (isBody(text)) return 'body';
  return 'unknown';
}

function isRateLimit(text: string): boolean {
  return (
    /\b429\b/.test(text) ||
    /rate[\s-]?limit/.test(text) ||
    text.includes('too many requests') ||
    /throttl/.test(text) ||
    text.includes('retry-after') ||
    text.includes('quota exceeded') ||
    text.includes('over quota')
  );
}

function isAuth(text: string): boolean {
  if (/\b401\b/.test(text) || /\b403\b/.test(text)) return true;
  if (credentialRejected(text)) return true;
  if (text.includes('permission denied') || text.includes('insufficient scope') || text.includes('insufficient_scope')) {
    return true;
  }
  if (isCors(text)) return false;
  return text.includes('forbidden') || text.includes('access denied');
}

function credentialRejected(text: string): boolean {
  if (/\bunauthori[sz]ed\b/.test(text)) return true;
  if (/invalid[\s_-]?(api[\s_-]?)?(key|token)\b/.test(text)) return true;
  if (/expired[\s_-]?(api[\s_-]?)?(key|token)\b/.test(text)) return true;
  if (/\b(api[\s_-]?key|access token|bearer token|token) (is |was |has been )?(expired|revoked)\b/.test(text)) {
    return true;
  }
  if (/\b(api[\s_-]?key|access token|bearer token|token) (is |was |has been )invalid\b/.test(text)) {
    return true;
  }
  if (text.includes('authentication failed')) return true;
  if (text.includes('missing authorization') || text.includes('no authorization')) return true;
  return text.includes('api key not found') || text.includes('token not found');
}

function isNotFound(text: string): boolean {
  return (
    /\b404\b/.test(text) ||
    text.includes('not found') ||
    text.includes('no route') ||
    text.includes('unknown route') ||
    text.includes('does not exist') ||
    /\bcannot (get|post|put|patch|delete)\b/.test(text)
  );
}

function isVendor(text: string): boolean {
  const codes = text.match(/\b5\d\d\b/g) ?? [];
  if (codes.some((code) => code !== '504')) return true;
  if (/\b5xx\b/.test(text)) return true;
  if (text.includes('internal server error')) return true;
  if (text.includes('bad gateway')) return true;
  return text.includes('service unavailable');
}

function isTimeout(text: string): boolean {
  return (
    /\b504\b/.test(text) ||
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('etimedout') ||
    text.includes('econnaborted') ||
    text.includes('deadline exceeded')
  );
}

function isCors(text: string): boolean {
  return (
    /\bcors\b/.test(text) ||
    text.includes('access-control-allow-origin') ||
    text.includes('access-control-allow-headers') ||
    text.includes('access-control-allow-methods') ||
    text.includes('cross-origin') ||
    text.includes('preflight')
  );
}

function isBody(text: string): boolean {
  if (/\b422\b/.test(text) || /\b415\b/.test(text)) return true;
  if (text.includes('malformed')) return true;
  if (text.includes('invalid json') || text.includes('unexpected token')) return true;
  if (text.includes('unsupported media type')) return true;
  if (/missing body|empty body|body is required|request body is missing|no request body/.test(text)) return true;
  if (/required field|missing field|missing required/.test(text)) return true;
  if (text.includes('content-type') && /json|mismatch|expected|invalid/.test(text)) return true;
  if (/\b400\b/.test(text) && /body|json|payload|schema|malformed|field/.test(text)) return true;
  return /schema validation|validation error|failed validation/.test(text) && /body|json|field|payload|request/.test(text);
}

function sectionsFor(category: Category, text: string): Sections {
  switch (category) {
    case 'auth':
      return authSections(text);
    case 'not_found':
      return notFoundSections(text);
    case 'rate_limit':
      return rateLimitSections(text);
    case 'vendor':
      return vendorSections(text);
    case 'timeout':
      return timeoutSections(text);
    case 'cors':
      return corsSections();
    case 'body':
      return bodySections(text);
    default:
      return unknownSections();
  }
}

function authSections(text: string): Sections {
  const kind = authKind(text);
  if (kind === '403') {
    return {
      summary: 'The API refused this call for permissions.',
      cause: 'The caller is authenticated but is not allowed to do this (HTTP 403).',
      checks: [
        'Confirm the token scopes or roles include this operation.',
        'Check that the resource is in the same account or workspace as the key.',
        'Compare with a key that is known to be allowed.',
      ],
      next: 'Grant the missing scope, or call with a credential that is allowed to access this resource.',
    };
  }
  if (kind === '401') {
    return {
      summary: 'The API rejected the credentials on this call.',
      cause: 'The key or token is missing, expired, or not accepted (HTTP 401).',
      checks: [
        'Confirm the Authorization header or API key is actually sent.',
        'Check expiry, audience, and that the key is for this environment.',
        'Retry once with a newly issued credential, and keep the secret out of logs.',
      ],
      next: 'Issue a fresh credential and retry the same request.',
    };
  }
  const has401 = /\b401\b/.test(text);
  const has403 = /\b403\b/.test(text);
  return {
    summary: 'The API rejected the call on authentication or permission grounds.',
    cause:
      has401 && has403
        ? 'The report includes both HTTP 401 and HTTP 403, so it is not one failure.'
        : 'The report mixes a rejected credential with a permission failure. It does not name a single status.',
    checks: [
      'Read the status line and the error code in the body.',
      'Confirm the credential is present, unexpired, and meant for this environment.',
      'Check scopes when the status is 403, and the key itself when it is 401.',
    ],
    next: 'Fix the credential or the scope, then retry the same request.',
  };
}

function authKind(text: string): '401' | '403' | 'either' {
  const unauthorized = /\b401\b/.test(text) || credentialRejected(text);
  const forbidden =
    /\b403\b/.test(text) ||
    text.includes('forbidden') ||
    text.includes('access denied') ||
    text.includes('permission denied') ||
    text.includes('insufficient scope') ||
    text.includes('insufficient_scope');
  if (unauthorized && !forbidden) return '401';
  if (forbidden && !unauthorized) return '403';
  return 'either';
}

function notFoundSections(text: string): Sections {
  const kind = notFoundKind(text);
  if (kind === 'route') {
    return {
      summary: 'The server did not match this request to a route.',
      cause: 'The method or path does not exist on this host (HTTP 404).',
      checks: [
        'Compare the method and path with the vendor current API reference.',
        'Check for a wrong version prefix, a trailing slash, or the wrong base URL.',
        'Confirm the call is going to the right host.',
      ],
      next: 'Correct the method or URL, then retry.',
    };
  }
  if (kind === 'resource') {
    return {
      summary: 'The route responded, but the resource was not found.',
      cause: 'The id in the request does not match a record this server can see (HTTP 404).',
      checks: [
        'Confirm the id is complete and belongs to this account.',
        'Check whether the record was deleted or lives in another environment.',
        'Read the same id with a call that is known to succeed.',
      ],
      next: 'Use an id that exists in this environment and retry.',
    };
  }
  return {
    summary: 'The server returned a not-found result.',
    cause: 'Either the route is wrong or the resource id is missing (HTTP 404). The report does not say which.',
    checks: [
      'Compare the method and path with the current API reference.',
      'If the path looks right, confirm the id exists in this account and environment.',
      'Check the host so a test id is not sent to production.',
    ],
    next: 'Fix the URL or replace the id, then retry.',
  };
}

function notFoundKind(text: string): 'route' | 'resource' | 'either' {
  const route =
    /\broute\b/.test(text) ||
    /\bendpoint\b/.test(text) ||
    /\bcannot (get|post|put|patch|delete)\b/.test(text) ||
    text.includes('no route') ||
    text.includes('unknown route');
  const resource =
    /\bresource\b/.test(text) ||
    /\brecord\b/.test(text) ||
    /\bentity\b/.test(text) ||
    text.includes('no such') ||
    /unknown id|resource id/.test(text) ||
    /\b(user|customer|object|invoice|subscription) not found\b/.test(text);
  if (route && !resource) return 'route';
  if (resource && !route) return 'resource';
  return 'either';
}

function rateLimitSections(text: string): Sections {
  const names429 = /\b429\b/.test(text) || text.includes('too many requests');
  return {
    summary: 'The vendor is throttling this client.',
    cause: names429
      ? 'The caller exceeded the vendor rate limit (HTTP 429).'
      : 'The caller exceeded a rate or quota limit.',
    checks: [
      'Read Retry-After and any rate-limit remaining or reset headers.',
      'Look for parallel workers or tight retry loops sharing one key.',
      'Compare the call volume with the vendor published limit.',
    ],
    next: 'Wait until the window resets, then send one request. Slow the client to stay under the limit.',
  };
}

function vendorSections(text: string): Sections {
  const code = vendorCode(text);
  return {
    summary: 'The vendor failed while handling the request.',
    cause: code
      ? `The vendor or a gateway in front of it failed the call (HTTP ${code}).`
      : 'The vendor or a gateway in front of it failed the call (HTTP 5xx).',
    checks: [
      'Retry with backoff. 502 and 503 are often short-lived.',
      'Check the vendor status page for this API.',
      'Save the request id if the same failure keeps happening.',
    ],
    next: 'Retry later. If the same 5xx continues, send the vendor the request id and the timestamp.',
  };
}

function vendorCode(text: string): string | undefined {
  const match = text.match(/\b5\d\d\b/);
  if (!match || match[0] === '504') return undefined;
  return match[0];
}

function timeoutSections(text: string): Sections {
  const gateway = /\b504\b/.test(text) || text.includes('gateway timeout');
  return {
    summary: 'The call ended because something gave up waiting.',
    cause: gateway
      ? 'A gateway timed out waiting for the vendor (HTTP 504).'
      : 'A client, proxy, or gateway timeout stopped the request before a normal response.',
    checks: [
      'Note whether the limit is the client timeout or an HTTP 504.',
      'Check proxy, DNS, and firewall paths to this host.',
      'See whether the vendor still applied the change, so a retry is not a double write.',
    ],
    next: 'Retry once if the operation is safe to repeat. If it keeps timing out, check the vendor status before raising the client limit.',
  };
}

function corsSections(): Sections {
  return {
    summary: 'The browser blocked the response as cross-origin.',
    cause: 'The API is not sending the CORS headers this page origin requires, or the preflight failed.',
    checks: [
      'Confirm the failure is in a browser. Server-side calls do not enforce CORS.',
      'Check that Access-Control-Allow-Origin matches this page origin, including scheme and port.',
      'For custom headers or PUT, PATCH, and DELETE, confirm OPTIONS succeeds and allows those headers.',
    ],
    next: 'Allow this origin on the API, or send the call from your server instead of the browser.',
  };
}

function bodySections(text: string): Sections {
  const kind = bodyKind(text);
  if (kind === 'missing') {
    return {
      summary: 'The request body does not satisfy the API.',
      cause: 'A required body or field was not sent.',
      checks: [
        'Confirm the request includes a body and the documented required fields.',
        'Check Content-Type is application/json when the API expects JSON.',
        'Compare the payload with the vendor schema for this endpoint.',
      ],
      next: 'Send the missing field or body, then retry.',
    };
  }
  if (kind === 'malformed') {
    return {
      summary: 'The API could not parse the request body.',
      cause: 'The body is malformed, or the Content-Type does not match the payload.',
      checks: [
        'Validate the JSON before sending it.',
        'Confirm Content-Type matches the body, usually application/json.',
        'Remove a trailing comma or extra characters the server is rejecting.',
      ],
      next: 'Send a well-formed body with the matching Content-Type, then retry.',
    };
  }
  return {
    summary: 'The API rejected the request body.',
    cause: 'The body is missing or malformed. The report does not isolate which.',
    checks: [
      'Confirm a body is present and includes the required fields.',
      'Validate the JSON and the Content-Type.',
      'Read the response for the field name it rejected.',
    ],
    next: 'Correct the payload the response names, then retry.',
  };
}

function bodyKind(text: string): 'missing' | 'malformed' | 'either' {
  const missing = /missing body|empty body|body is required|request body is missing|no request body|required field|missing field|missing required/.test(
    text,
  );
  const malformed =
    text.includes('malformed') ||
    text.includes('invalid json') ||
    text.includes('unexpected token') ||
    text.includes('unsupported media type') ||
    /\b415\b/.test(text) ||
    (text.includes('content-type') && /mismatch|invalid|expected/.test(text));
  if (missing && !malformed) return 'missing';
  if (malformed && !missing) return 'malformed';
  return 'either';
}

function emptySections(): Sections {
  return {
    summary: 'No error text was provided.',
    cause: 'There is nothing in the report to classify.',
    checks: [
      'Paste the HTTP status, method, and URL.',
      'Include a redacted response body.',
      'Note whether the caller is a browser, a server, or a webhook.',
    ],
    next: 'Send that error text in the request.',
  };
}

function unknownSections(): Sections {
  return {
    summary: 'This report does not match a common API or SaaS failure.',
    cause: 'There is not enough specific signal to name a cause.',
    checks: [
      'Record the HTTP status, method, and URL.',
      'Save a redacted response body and any request id.',
      'Note whether the caller is a browser, a server, or a webhook.',
    ],
    next: 'Send those details for a more specific pass.',
  };
}

function render(sections: Sections): string {
  return [
    'Summary',
    sections.summary,
    '',
    'Likely cause',
    sections.cause,
    '',
    'Checks',
    ...sections.checks.map((item) => `- ${item}`),
    '',
    'Next step',
    sections.next,
    '',
  ].join('\n');
}

// A small `requests`-like adapter over fetch.
//
// The ported modules keep the Python call shapes:
//
//     const response = await http.post(url, { headers, json, timeout: 10 });
//     response.raise_for_status();
//     const body = response.json();
//
// The field names `status_code` and `response` are snake_case on purpose. The
// Python logic reads them by those names (`getattr(error, "response")`,
// `response.status_code`), so keeping them lets that logic port literally.
//
// Every error message here is secret-free: it never contains the URL, query,
// headers or body, at most the HTTP status code. The underlying fetch error is
// never attached as `cause`, because Node prints cause chains (S7).

import { ValueError } from "./python-compat.ts";

/** requests.exceptions.RequestException: the base of the errors below. */
export class RequestException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestException";
  }
}

/** requests.exceptions.HTTPError, raised by `raise_for_status()`. */
export class HTTPError extends RequestException {
  declare readonly response: HttpResponse;

  constructor(response: HttpResponse) {
    super(`HTTP error ${response.status_code}`);
    this.name = "HTTPError";
    // Non-enumerable, so printing an uncaught HTTPError (Node's inspect) shows
    // only the status line, not the response.
    Object.defineProperty(this, "response", { value: response, enumerable: false });
  }
}

/** requests.exceptions.ConnectionError: the request failed before a response. */
export class ConnectionError extends RequestException {
  constructor() {
    super("HTTP connection failed");
    this.name = "ConnectionError";
  }
}

/** requests.exceptions.Timeout: no complete response within `timeout` seconds. */
export class Timeout extends RequestException {
  constructor() {
    super("HTTP request timed out");
    this.name = "Timeout";
  }
}

/**
 * requests.exceptions.ReadTimeout. fetch applies one overall timeout and cannot
 * tell a connect timeout from a read timeout, so every fetch timeout is
 * reported as ReadTimeout, the common case in `requests`. Its name is what
 * `type(error).__name__` logs in Python.
 */
export class ReadTimeout extends Timeout {
  constructor() {
    super();
    this.name = "ReadTimeout";
  }
}

/**
 * requests.exceptions.ChunkedEncodingError: the connection broke while the body
 * was being read. In `requests` it is not a ConnectionError, so the Notion
 * retry policy does not retry it.
 */
export class ChunkedEncodingError extends RequestException {
  constructor() {
    super("HTTP response body was interrupted");
    this.name = "ChunkedEncodingError";
  }
}

/** requests.exceptions.InvalidURL: the URL could not be parsed. */
export class InvalidURL extends RequestException {
  constructor() {
    super("Invalid URL");
    this.name = "InvalidURL";
  }
}

/** requests.exceptions.InvalidHeader: a header name or value is not allowed. */
export class InvalidHeader extends RequestException {
  constructor() {
    super("Invalid header");
    this.name = "InvalidHeader";
  }
}

/**
 * requests.exceptions.JSONDecodeError. In Python it is a ValueError, and the
 * application catches it as one, so it extends ValueError here.
 */
export class JSONDecodeError extends ValueError {
  constructor() {
    super("Response body is not valid JSON");
    this.name = "JSONDecodeError";
  }
}

export type HttpHeaders = Record<string, string>;

export class HttpResponse {
  readonly status_code: number;
  // Private fields behind getters: Node's inspect does not print them, so a
  // logged response never shows its headers or body.
  readonly #headers: Headers;
  readonly #text: string;

  constructor(status_code: number, headers: Headers, text: string) {
    this.status_code = status_code;
    this.#headers = headers;
    this.#text = text;
  }

  /** Case-insensitive, like `requests`' CaseInsensitiveDict: `headers.get("retry-after")`. */
  get headers(): Headers {
    return this.#headers;
  }

  /** The body, read eagerly so that `json()` can be synchronous. */
  get text(): string {
    return this.#text;
  }

  /** `response.json()`: throws JSONDecodeError (a ValueError) on invalid JSON. */
  json(): unknown {
    try {
      return JSON.parse(this.text);
    } catch {
      throw new JSONDecodeError();
    }
  }

  /** `response.raise_for_status()`: throws HTTPError for status 400–599. */
  raise_for_status(): void {
    if (this.status_code >= 400 && this.status_code < 600) {
      throw new HTTPError(this);
    }
  }
}

export type PostOptions = {
  headers?: HttpHeaders;
  json?: unknown;
  /** Seconds, as in `requests`. One overall timeout rather than connect/read. */
  timeout?: number;
};

export type GetOptions = {
  headers?: HttpHeaders;
  params?: Record<string, string>;
  /** Seconds, as in `requests`. One overall timeout rather than connect/read. */
  timeout?: number;
};

export type Http = {
  post(url: string, options?: PostOptions): Promise<HttpResponse>;
  get(url: string, options?: GetOptions): Promise<HttpResponse>;
};

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

// urllib.parse.quote_plus, which `requests` uses to encode params: everything
// except letters, digits and `_.-~` is percent-encoded, and spaces become `+`.
function quotePlus(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** Appends params to the URL the way `requests` does for simple string values. */
export function encodeParams(url: string, params: Record<string, string> | undefined): string {
  if (!params) return url;
  const query = Object.entries(params)
    .map(([key, value]) => `${quotePlus(key)}=${quotePlus(value)}`)
    .join("&");
  if (!query) return url;
  const hashIndex = url.indexOf("#");
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const fragment = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${query}${fragment}`;
}

function isTimeoutError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "TimeoutError";
}

export function createHttp(fetchImpl: FetchImpl = globalThis.fetch): Http {
  async function send(
    method: "GET" | "POST",
    url: string,
    headers: HttpHeaders | undefined,
    body: string | undefined,
    timeout: number | undefined,
  ): Promise<HttpResponse> {
    if (!URL.canParse(url)) throw new InvalidURL();
    let requestHeaders: Headers;
    try {
      requestHeaders = new Headers(headers ?? {});
    } catch {
      // The platform's message quotes the offending value, which may be a token.
      throw new InvalidHeader();
    }
    const signal = timeout === undefined ? undefined : AbortSignal.timeout(timeout * 1000);
    const init: RequestInit = { method, headers: requestHeaders };
    if (body !== undefined) init.body = body;
    if (signal) init.signal = signal;
    // Errors are rethrown without `cause` and without the fetch error's
    // message, which can contain the URL.
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (isTimeoutError(error, signal)) throw new ReadTimeout();
      throw new ConnectionError();
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // requests/models.py (Response.iter_content) maps a ReadTimeoutError
      // while streaming the body to ConnectionError, not to a Timeout, and a
      // ProtocolError to ChunkedEncodingError.
      if (isTimeoutError(error, signal)) throw new ConnectionError();
      throw new ChunkedEncodingError();
    }
    return new HttpResponse(response.status, response.headers, text);
  }

  return {
    async post(url, { headers, json, timeout } = {}) {
      let body: string | undefined;
      let requestHeaders = headers;
      if (json !== undefined) {
        body = JSON.stringify(json);
        // `requests` adds this header for `json=` unless the caller set one.
        const hasContentType = Object.keys(headers ?? {}).some(
          (name) => name.toLowerCase() === "content-type",
        );
        if (!hasContentType) {
          requestHeaders = { ...headers, "Content-Type": "application/json" };
        }
      }
      return send("POST", url, requestHeaders, body, timeout);
    },

    async get(url, { headers, params, timeout } = {}) {
      return send("GET", encodeParams(url, params), headers, undefined, timeout);
    },
  };
}

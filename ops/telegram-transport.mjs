import { Pool, ProxyAgent, RetryAgent } from 'undici';

export function createTelegramDispatcher(uri) {
  // Retry only CONNECT establishment, before any Telegram request bytes exist.
  // Never wrap the outer dispatcher: retrying an ambiguous send can duplicate it.
  return new ProxyAgent({
    uri,
    clientFactory: (origin, options) => new RetryAgent(
      new Pool(origin, { ...options, headersTimeout: 1500 }),
      {
        methods: ['CONNECT'], maxRetries: 8, minTimeout: 100, maxTimeout: 100,
        errorCodes: ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'],
        statusCodes: [502, 503, 504]
      }
    )
  });
}
